import { randomBytes } from 'crypto';
import { Request, RequestHandler, Response, Router } from 'express';
import type { AppDeps } from '../../app';
import { GATEWAY_LOJAS, lerConfigLojas, paraConnectedAccount } from '../../contas/contas';
import { montarLinkDeAutorizacao } from '../../gateways/mercadopago/oauth';
import * as S from './schemas';
import { HttpError, param, validar } from './util';

const STATE_VALE_MS = 10 * 60_000;

type Tratar = (fn: (req: Request, res: Response) => Promise<void>) => RequestHandler;

/** `return_url` tem que ser https; http só em localhost no ambiente de teste. */
export function returnUrlValido(url: string, ambiente: 'teste' | 'producao'): boolean {
  const u = new URL(url);
  if (u.protocol === 'https:') return true;
  return ambiente === 'teste' && u.protocol === 'http:' && (u.hostname === 'localhost' || u.hostname === '127.0.0.1');
}

/** Contas conectadas do Mercado Pago (OAuth da lojista). Contrato: backlog/tasks/TASK-396.md. */
export function montarRotasContas(router: Router, deps: AppDeps, tratar: Tratar): void {
  const comLojas = (fn: (req: Request, res: Response, cfg: NonNullable<ReturnType<typeof lerConfigLojas>>) => Promise<void>) =>
    tratar(async (req, res) => {
      const cfg = lerConfigLojas(await deps.repos.configs.findActive(req.project.id, GATEWAY_LOJAS));
      if (!cfg) throw new HttpError(409, 'gateway_not_configured', 'Projeto sem configuração do Mercado Pago das lojas');
      await fn(req, res, cfg);
    });

  router.post('/accounts/connect', comLojas(async (req, res, cfg) => {
    const { account_ref, return_url } = validar(S.conectarConta, req.body);
    if (!returnUrlValido(return_url, cfg.ambiente)) {
      throw new HttpError(400, 'validation_error', 'return_url: precisa ser https');
    }
    const state = randomBytes(32).toString('hex');
    const expira = new Date(Date.now() + STATE_VALE_MS);
    await deps.repos.oauthStates.create({
      state,
      project_id: req.project.id,
      account_ref,
      return_url,
      expires_at: expira.toISOString(),
    });
    res.status(201).json({
      authorize_url: montarLinkDeAutorizacao({ client_id: cfg.client_id, redirect_uri: cfg.redirect_uri, state }),
      expires_at: expira.toISOString(),
    });
  }));

  router.get('/accounts/:account_ref', comLojas(async (req, res, cfg) => {
    const conta = await deps.repos.accounts.findByRef(req.project.id, param(req, 'account_ref'));
    if (!conta) throw new HttpError(404, 'not_found', 'Conta não encontrada');
    res.json(paraConnectedAccount(conta, cfg.ambiente));
  }));

  // só apaga os tokens e marca disconnected; não manda callback (quem pediu foi o projeto)
  router.delete('/accounts/:account_ref', comLojas(async (req, res, cfg) => {
    let conta = await deps.repos.accounts.findByRef(req.project.id, param(req, 'account_ref'));
    if (!conta) throw new HttpError(404, 'not_found', 'Conta não encontrada');
    if (conta.status !== 'disconnected') {
      conta = await deps.repos.accounts.markDisconnected(conta.id, 'disconnected', new Date());
    }
    res.json(paraConnectedAccount(conta, cfg.ambiente));
  }));
}
