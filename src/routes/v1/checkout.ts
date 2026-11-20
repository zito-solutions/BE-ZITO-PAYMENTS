import { Request, RequestHandler, Response, Router } from 'express';
import type { AppDeps } from '../../app';
import { GATEWAY_LOJAS, lerConfigLojas } from '../../contas/contas';
import { CheckoutLojas, EstornoRecusadoError } from '../../gateways/mercadopago/lojas';
import { returnUrlValido } from './accounts';
import * as S from './schemas';
import { HttpError, param, validar } from './util';

type Tratar = (fn: (req: Request, res: Response) => Promise<void>) => RequestHandler;

/** Checkout das lojas: tudo com o token da lojista. Contrato: backlog/tasks/TASK-396.md. */
export function montarRotasCheckout(router: Router, deps: AppDeps, tratar: Tratar): void {
  const comConta = (
    contaRef: (req: Request) => unknown,
    fn: (req: Request, res: Response, ctx: { cfg: NonNullable<ReturnType<typeof lerConfigLojas>>; lojas: CheckoutLojas; account_ref: string }) => Promise<void>
  ) =>
    tratar(async (req, res) => {
      const cfg = lerConfigLojas(await deps.repos.configs.findActive(req.project.id, GATEWAY_LOJAS));
      if (!cfg) throw new HttpError(409, 'gateway_not_configured', 'Projeto sem configuração do Mercado Pago das lojas');
      const { account_ref } = validar(S.contaDoPagamento, contaRef(req));
      const conta = await deps.repos.accounts.findByRef(req.project.id, account_ref);
      if (!conta || conta.status !== 'connected' || !conta.access_token) {
        throw new HttpError(409, 'account_not_connected', 'Conta do Mercado Pago não conectada');
      }
      await fn(req, res, { cfg, lojas: deps.buildCheckoutLojas(cfg.ambiente, conta.access_token), account_ref });
    });

  router.post('/checkout/preferences', comConta((req) => req.body, async (req, res, { cfg, lojas, account_ref }) => {
    const p = validar(S.criarPreferencia, req.body);
    if (!returnUrlValido(p.back_url, cfg.ambiente)) {
      throw new HttpError(400, 'validation_error', 'back_url: precisa ser https');
    }
    const pref = await lojas.criarPreferencia(p, {
      project_id: req.project.id,
      account_ref,
      base: new URL(cfg.redirect_uri).origin,
    });
    res.status(201).json(pref);
  }));

  // a busca por referência vem antes do `:id`
  router.get('/checkout/payments', comConta((req) => req.query, async (req, res, { lojas, account_ref }) => {
    const { reference } = validar(S.pagamentosPorReferencia, req.query);
    res.json({ payments: await lojas.buscarPorReferencia(reference, account_ref) });
  }));

  router.get('/checkout/payments/:id', comConta((req) => req.query, async (req, res, { lojas, account_ref }) => {
    res.json(await lojas.obterPagamento(param(req, 'id'), account_ref));
  }));

  router.post('/checkout/payments/:id/refund', comConta((req) => req.body, async (req, res, { lojas, account_ref }) => {
    const { amount_cents, idempotency_key } = validar(S.estornarLoja, req.body);
    try {
      res.json(await lojas.estornar(param(req, 'id'), account_ref, { amount_cents, idempotency_key }));
    } catch (err) {
      if (err instanceof EstornoRecusadoError) throw new HttpError(422, 'refund_rejected', err.message);
      throw err;
    }
  }));
}
