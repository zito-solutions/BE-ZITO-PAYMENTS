import { NextFunction, Request, RequestHandler, Response, Router } from 'express';
import { ZodError, ZodType } from 'zod';
import type { AppDeps } from '../../app';
import { projectAuth } from '../../middleware/project.auth';
import { MercadoPagoError } from '../../gateways/mercadopago/mercadopago.client';
import { MercadoPagoGateway } from '../../gateways/mercadopago/mercadopago.gateway';
import * as S from './schemas';

class HttpError extends Error {
  constructor(public status: number, public code: string, message: string) {
    super(message);
  }
}

function validar<T>(schema: ZodType<T>, dados: unknown): T {
  const r = schema.safeParse(dados ?? {});
  if (r.success) return r.data;
  throw r.error;
}

function resumoZod(err: ZodError): string {
  const i = err.issues[0];
  if (!i) return 'Dados inválidos';
  const campo = i.path.join('.');
  return campo ? `${campo}: ${i.message}` : i.message;
}

function param(req: Request, nome: string): string {
  const v = req.params[nome];
  return Array.isArray(v) ? (v[0] ?? '') : (v ?? '');
}

export function createV1Router(deps: AppDeps): Router {
  const router = Router();

  // log sem e-mail, token nem QR: só projeto, gateway, rota e status
  router.use((req: Request, res: Response, next: NextFunction) => {
    res.on('finish', () => {
      const rota = `${req.method} ${req.baseUrl}${req.route?.path ?? req.path}`;
      console.log(`[${req.project?.name ?? '-'}] [mercadopago] ${rota} ${res.statusCode}`);
    });
    next();
  });

  router.use(projectAuth(deps.repos));

  const tratar =
    (fn: (req: Request, res: Response) => Promise<void>): RequestHandler =>
    async (req, res) => {
      try {
        await fn(req, res);
      } catch (err) {
        if (err instanceof ZodError) {
          res.status(400).json({ error: 'validation_error', message: resumoZod(err) });
        } else if (err instanceof HttpError) {
          res.status(err.status).json({ error: err.code, message: err.message });
        } else if (err instanceof MercadoPagoError) {
          if (err.status === 404) {
            res.status(404).json({ error: 'not_found', message: err.message });
          } else {
            res.status(502).json({ error: 'gateway_error', message: err.message });
          }
        } else {
          console.error(`[${req.project?.name ?? '-'}] [mercadopago] erro interno:`, err instanceof Error ? err.message : err);
          res.status(500).json({ error: 'internal_error', message: 'Erro interno' });
        }
      }
    };

  const comMP =
    (fn: (req: Request, res: Response, mp: MercadoPagoGateway) => Promise<void>): RequestHandler =>
    tratar(async (req, res) => {
      const config = await deps.repos.configs.findActive(req.project.id, 'mercadopago');
      if (!config) throw new HttpError(409, 'gateway_not_configured', 'Projeto sem configuração do Mercado Pago');
      await fn(req, res, deps.buildMercadoPago(config));
    });

  router.get('/config', comMP(async (_req, res, mp) => {
    res.json({ gateway: 'mercadopago', ambiente: mp.ambiente });
  }));

  router.post('/plans', comMP(async (req, res, mp) => {
    res.status(201).json(await mp.criarPlano(validar(S.criarPlano, req.body)));
  }));

  router.post('/subscriptions', comMP(async (req, res, mp) => {
    res.status(201).json(await mp.criarAssinaturaPendente(validar(S.criarAssinatura, req.body)));
  }));

  router.post('/subscriptions/card', comMP(async (req, res, mp) => {
    res.status(201).json(await mp.criarAssinaturaComCartao(validar(S.criarAssinaturaCartao, req.body)));
  }));

  router.get('/subscriptions', comMP(async (req, res, mp) => {
    const { reference } = validar(S.consultaPorReferencia, req.query);
    const s = await mp.buscarAssinaturaPorReferencia(reference);
    if (!s) throw new HttpError(404, 'not_found', 'Assinatura não encontrada');
    res.json(s);
  }));

  router.get('/subscriptions/:id', comMP(async (req, res, mp) => {
    res.json(await mp.obterAssinatura(param(req, 'id')));
  }));

  router.patch('/subscriptions/:id', comMP(async (req, res, mp) => {
    const { amount_cents } = validar(S.atualizarAssinatura, req.body);
    res.json(await mp.atualizarValor(param(req, 'id'), amount_cents));
  }));

  router.post('/subscriptions/:id/cancel', comMP(async (req, res, mp) => {
    res.json(await mp.cancelarAssinatura(param(req, 'id')));
  }));

  router.post('/pix', comMP(async (req, res, mp) => {
    res.status(201).json(await mp.criarPix(validar(S.criarPix, req.body)));
  }));

  router.get('/payments/:id', comMP(async (req, res, mp) => {
    res.json(await mp.obterPagamento(param(req, 'id')));
  }));

  router.post('/payments/:id/refund', comMP(async (req, res, mp) => {
    const { idempotency_key } = validar(S.reembolsar, req.body);
    res.json(await mp.reembolsar(param(req, 'id'), idempotency_key));
  }));

  // callbacks que não chegaram (não dependem do gateway)
  router.get('/callbacks/failed', tratar(async (req, res) => {
    res.json({ deliveries: await deps.repos.deliveries.listFailed(req.project.id) });
  }));

  router.post('/callbacks/:id/retry', tratar(async (req, res) => {
    const id = param(req, 'id');
    const ok = await deps.repos.deliveries.resetToPending(id, req.project.id, new Date());
    if (!ok) throw new HttpError(404, 'not_found', 'Entrega não encontrada ou não está com falha');
    res.json({ id, status: 'pending' });
  }));

  return router;
}
