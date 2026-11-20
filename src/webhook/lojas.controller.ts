import { Request, Response } from 'express';
import type { AppDeps } from '../app';
import { emitirEventoDeConta, GATEWAY_LOJAS, lerConfigLojas, paraConnectedAccount } from '../contas/contas';
import { verificarAssinaturaMP } from '../gateways/mercadopago/assinatura';
import { MercadoPagoError } from '../gateways/mercadopago/mercadopago.client';
import { criarEEntregar } from '../callbacks/entregar';
import { PaymentLoja, WebhookEventName } from '../gateways/gateway.interface';
import { AccountRow } from '../repositories/types';
import { Project } from '../payments/payment.types';

function um(v: unknown): string | undefined {
  const x = Array.isArray(v) ? v[0] : v;
  return typeof x === 'string' && x ? x : undefined;
}

interface CorpoAviso {
  type?: string;
  action?: string;
  user_id?: string | number;
  data?: { id?: string | number };
}

type EventoOrder = Extract<WebhookEventName, `order.${string}`>;

/** Qual evento `order.*` o pagamento gera (null = nenhum: pendente, recusado, sem referência). */
export function eventoDoPagamento(p: PaymentLoja): EventoOrder | null {
  if (!p.reference) return null;
  if (p.status === 'refunded' || (p.status === 'approved' && p.refunded_cents > 0)) return 'order.payment_refunded';
  if (p.status === 'charged_back' || p.disputed) return 'order.payment_disputed';
  if (p.status === 'approved') return 'order.payment_approved';
  if (p.status === 'cancelled' || p.status === 'expired') return 'order.payment_expired';
  return null;
}

/** Webhook das lojas: `POST /webhook/mercadopago-lojas?project_id=<id>[&account_ref=<ref>]`. Tópicos `mp-connect` e `payment`. */
export function createWebhookLojasHandler(deps: AppDeps) {
  return async function handleLojas(req: Request, res: Response): Promise<void> {
    const projectId = um(req.query['project_id']);
    if (!projectId) {
      res.status(400).json({ error: 'Missing project_id' });
      return;
    }

    try {
      const project = await deps.repos.projects.findById(projectId);
      const cfg = project ? lerConfigLojas(await deps.repos.configs.findActive(project.id, GATEWAY_LOJAS)) : null;
      if (!project || !cfg) {
        res.status(404).json({ error: 'Project or config not found' });
        return;
      }

      const rawBody = Buffer.isBuffer(req.body) ? req.body : Buffer.alloc(0);
      let corpo: CorpoAviso = {};
      try {
        const j = JSON.parse(rawBody.toString('utf-8')) as unknown;
        if (j && typeof j === 'object') corpo = j as CorpoAviso;
      } catch {
        corpo = {};
      }
      const topico = um(req.query['type']) ?? um(req.query['topic']) ?? corpo.type;
      const dataIdBruto = um(req.query['data.id']) ?? um(req.query['id']) ?? corpo.data?.id;
      const dataId = dataIdBruto !== undefined ? String(dataIdBruto) : undefined;

      const xSignature = um(req.headers['x-signature']);
      if (xSignature) {
        const v = verificarAssinaturaMP({ xSignature, xRequestId: um(req.headers['x-request-id']), dataId, segredo: cfg.webhook_secret });
        if (!v.ok) {
          console.error(`[${project.name}] [${GATEWAY_LOJAS}] aviso recusado: ${v.motivo}`);
          res.status(401).json({ error: 'Invalid signature' });
          return;
        }
      }
      console.log(`[${project.name}] [${GATEWAY_LOJAS}] webhook ${topico ?? '-'} assinado: ${xSignature ? 'sim' : 'não'}`);

      if (topico === 'payment') {
        const r = await tratarPagamento(deps, project, cfg.ambiente, {
          accountRef: um(req.query['account_ref']),
          userId: corpo.user_id,
          dataId,
          aviso: lerAviso(rawBody),
        });
        res.status(200).json(r);
        return;
      }

      if (topico !== 'mp-connect' || corpo.action !== 'application.deauthorized' || corpo.user_id === undefined) {
        res.status(200).json({ received: true, processed: false });
        return;
      }

      let desconectou = 0;
      const contas = await deps.repos.accounts.findConnectedByMpUserId(project.id, String(corpo.user_id));
      for (const conta of contas) {
        // o aviso pode não vir assinado: só desconecta se o MP confirmar que o token não vale mais
        if (!conta.access_token) continue;
        if (await deps.oauth.contaAindaValida(conta.access_token)) continue;
        const agora = new Date();
        const nova = await deps.repos.accounts.markDisconnected(conta.id, 'disconnected', agora);
        await emitirEventoDeConta(deps, project, 'account.disconnected', paraConnectedAccount(nova, cfg.ambiente), agora);
        desconectou++;
      }
      res.status(200).json({ received: true, processed: desconectou > 0 });
    } catch (err) {
      // erro de rede ao confirmar no MP: 500 para ele tentar de novo
      console.error(`[webhook] [${GATEWAY_LOJAS}] erro interno:`, err instanceof Error ? err.message : 'erro');
      res.status(500).json({ error: 'Internal error' });
    }
  };
}

function lerAviso(rawBody: Buffer): unknown {
  try {
    return JSON.parse(rawBody.toString('utf-8')) as unknown;
  } catch {
    return null;
  }
}

/** Aviso `payment`: acha a conta, consulta o pagamento no MP com o token dela (nunca confia no corpo) e emite o `order.*`. */
async function tratarPagamento(
  deps: AppDeps,
  project: Project,
  ambiente: 'teste' | 'producao',
  a: { accountRef: string | undefined; userId: string | number | undefined; dataId: string | undefined; aviso: unknown }
): Promise<{ received: true; processed: boolean; reason?: string }> {
  let conta: AccountRow | null = null;
  if (a.accountRef) {
    conta = await deps.repos.accounts.findByRef(project.id, a.accountRef);
  } else if (a.userId !== undefined) {
    conta = (await deps.repos.accounts.findConnectedByMpUserId(project.id, String(a.userId)))[0] ?? null;
  }
  if (!conta || conta.status !== 'connected' || !conta.access_token || !a.dataId) {
    return { received: true, processed: false };
  }

  let pagamento: PaymentLoja;
  try {
    pagamento = await deps.buildCheckoutLojas(ambiente, conta.access_token).obterPagamento(a.dataId, conta.account_ref);
  } catch (err) {
    if (err instanceof MercadoPagoError && err.status === 404) return { received: true, processed: false };
    throw err; // o catch de fora responde 500 e o MP tenta de novo
  }

  const evento = eventoDoPagamento(pagamento);
  if (!evento) return { received: true, processed: false };

  const gatewayEventId = `mp-lojas:payment:${pagamento.id}:${pagamento.status}:${pagamento.refunded_cents}:${pagamento.disputed}`;
  const existente = await deps.repos.events.findByGatewayEventId(gatewayEventId);
  if (existente) {
    // gravado mas sem entrega (queda no meio): cria agora
    if (!(await deps.repos.deliveries.getByEventId(existente.id))) await criarEEntregar(deps.entrega, project, existente);
    return { received: true, processed: false, reason: 'duplicate' };
  }

  const gravado = await deps.repos.events.insert({
    project_id: project.id,
    gateway: 'mercadopago',
    event_type: evento,
    customer_ref: pagamento.reference,
    gateway_event_id: gatewayEventId,
    payload: { aviso: a.aviso, data: { subscription: null, payment: pagamento, account: paraConnectedAccount(conta, ambiente) } },
  });
  if (!gravado) return { received: true, processed: false, reason: 'duplicate' };

  console.log(`[${project.name}] [${GATEWAY_LOJAS}] evento recebido: ${evento}`);
  await criarEEntregar(deps.entrega, project, gravado);
  return { received: true, processed: true };
}
