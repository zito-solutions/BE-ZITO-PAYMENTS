import {
  Payment,
  Subscription,
  WebhookEventName,
  WebhookInput,
  WebhookResult,
} from '../gateway.interface';
import { MercadoPagoError } from './mercadopago.client';
import { MPAuthorizedPayment, MPPayment, MPPreapproval } from './conversao';
import { verificarAssinaturaMP } from './assinatura';

/** O que o tratamento do aviso precisa do gateway (o gateway real e o falso dos testes cumprem). */
export interface LeituraMP {
  ambiente: 'teste' | 'producao';
  obterAssinaturaBruta(id: string): Promise<MPPreapproval>;
  obterAssinatura(id: string): Promise<Subscription>;
  obterPagamentoDeAssinaturaBruto(id: string): Promise<MPAuthorizedPayment>;
  obterPagamentoBruto(id: string): Promise<MPPayment>;
  obterPagamento(id: string): Promise<Payment>;
}

export class AvisoInvalidoError extends Error {
  constructor(public readonly motivo: string) {
    super(`Aviso do Mercado Pago recusado: ${motivo}`);
    this.name = 'AvisoInvalidoError';
  }
}

export interface TratarAvisoDeps {
  gateway: LeituraMP;
  segredo: string;
  agora?: Date;
}

function primeiro(v: string | string[] | undefined): string | undefined {
  return Array.isArray(v) ? v[0] : v;
}

function lerCorpo(rawBody: Buffer): { type?: string; data?: { id?: string | number } } {
  try {
    const j = JSON.parse(rawBody.toString('utf-8')) as unknown;
    return j && typeof j === 'object' ? (j as never) : {};
  } catch {
    return {};
  }
}

/**
 * Valida o x-signature (com o webhook_secret do projeto; o project_id da query NÃO entra na
 * assinatura), consulta o recurso no MP e devolve o evento normalizado. null = nada a fazer (200).
 */
export async function tratarAvisoMP(input: WebhookInput, deps: TratarAvisoDeps): Promise<WebhookResult | null> {
  const body = lerCorpo(input.rawBody);
  const topico = input.query['type'] ?? input.query['topic'] ?? body.type;
  const dataIdBruto = input.query['data.id'] ?? input.query['id'] ?? body.data?.id;
  const dataId = dataIdBruto !== undefined ? String(dataIdBruto) : undefined;

  const assinatura = verificarAssinaturaMP({
    xSignature: primeiro(input.headers['x-signature']),
    xRequestId: primeiro(input.headers['x-request-id']),
    dataId,
    segredo: deps.segredo,
    agora: deps.agora,
  });
  if (!assinatura.ok) throw new AvisoInvalidoError(assinatura.motivo);

  if (!dataId || !topico) return null;

  try {
    switch (topico) {
      case 'subscription_preapproval':
        return await avisoAssinatura(deps.gateway, dataId);
      case 'subscription_authorized_payment':
        return await avisoCobrancaAssinatura(deps.gateway, dataId);
      case 'payment':
        return await avisoPagamento(deps.gateway, dataId);
      default:
        return null;
    }
  } catch (err) {
    // recurso que o MP não conhece (ex.: aviso de simulação do painel): não adianta ele tentar de novo
    if (err instanceof MercadoPagoError && err.status === 404) return null;
    throw err;
  }
}

async function avisoAssinatura(gw: LeituraMP, id: string): Promise<WebhookResult | null> {
  const raw = await gw.obterAssinaturaBruta(id);
  const status = raw.status === 'canceled' ? 'cancelled' : raw.status;
  const event: WebhookEventName | null =
    status === 'authorized' ? 'subscription.activated' : status === 'cancelled' ? 'subscription.cancelled' : null;
  if (!event || !raw.external_reference) return null;

  const subscription = await gw.obterAssinatura(id);
  return {
    event,
    customer_ref: raw.external_reference,
    gateway_event_id: `mp:preapproval:${id}:${raw.status}:${raw.last_modified ?? ''}`,
    data: { subscription, payment: null },
  };
}

async function avisoCobrancaAssinatura(gw: LeituraMP, id: string): Promise<WebhookResult | null> {
  const cobranca = await gw.obterPagamentoDeAssinaturaBruto(id);
  const paymentId = cobranca.payment?.id;
  if (paymentId === undefined || paymentId === null) return null;

  const pagamentoBruto = await gw.obterPagamentoBruto(String(paymentId));
  const event: WebhookEventName | null =
    pagamentoBruto.status === 'approved'
      ? 'subscription.payment_approved'
      : pagamentoBruto.status === 'rejected'
        ? 'subscription.payment_failed'
        : null;
  if (!event) return null;

  const payment = await gw.obterPagamento(String(paymentId));
  const subscriptionId = cobranca.preapproval_id ?? payment.subscription_id;
  const subscription = subscriptionId ? await gw.obterAssinatura(subscriptionId) : null;
  const reference = subscription?.reference || cobranca.external_reference || payment.reference;
  if (!reference) return null;

  return {
    event,
    customer_ref: reference,
    gateway_event_id: `mp:authorized_payment:${id}:${pagamentoBruto.status}`,
    data: { subscription, payment: { ...payment, subscription_id: payment.subscription_id ?? subscriptionId ?? null } },
  };
}

async function avisoPagamento(gw: LeituraMP, id: string): Promise<WebhookResult | null> {
  const bruto = await gw.obterPagamentoBruto(id);
  const payment = await gw.obterPagamento(id);
  const deAssinatura = !!payment.subscription_id;
  const refund = payment.status === 'refunded' || payment.status === 'charged_back';

  let event: WebhookEventName | null = null;
  if (refund) event = 'payment.refunded';
  else if (!deAssinatura && payment.status === 'approved') event = 'payment.approved';
  else if (!deAssinatura && payment.status === 'expired') event = 'payment.expired';
  if (!event || !payment.reference) return null;

  return {
    event,
    customer_ref: payment.reference,
    gateway_event_id: `mp:payment:${id}:${bruto.status === 'cancelled' && payment.status === 'expired' ? 'expired' : bruto.status}`,
    data: { subscription: null, payment },
  };
}
