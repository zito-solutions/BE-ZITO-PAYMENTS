import { Ambiente, PaymentLoja, Preferencia } from '../gateway.interface';
import { MercadoPagoClient, MercadoPagoError, MPClient } from './mercadopago.client';
import { formatoDataMP, MPPayment, paraPayment } from './conversao';

export interface ItemPreferencia {
  title: string;
  quantity: number;
  unit_price_cents: number;
}

export interface CriarPreferenciaParams {
  account_ref: string;
  reference: string;
  items: ItemPreferencia[];
  shipping_cents: number;
  payer: { name: string; phone?: string };
  back_url: string;
  expires_at: string;
  max_installments: number;
}

export interface ContextoPreferencia {
  project_id: string;
  account_ref: string;
  /** Base pública do hub: `new URL(redirect_uri).origin`. */
  base: string;
}

/** O MP recusou o estorno (4xx): a mensagem é a do MP (ex.: sem saldo). */
export class EstornoRecusadoError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'EstornoRecusadoError';
  }
}

interface MPPreferencia {
  id: string;
  init_point?: string;
  sandbox_init_point?: string;
}

interface MPBusca {
  results?: MPPayment[];
}

/** Checkout das lojas do Dittu: tudo com o access_token da lojista, nunca com o do hub. Sem comissão. */
export class CheckoutLojas {
  constructor(
    private readonly ambiente: Ambiente,
    private readonly client: MPClient
  ) {}

  async criarPreferencia(p: CriarPreferenciaParams, ctx: ContextoPreferencia): Promise<Preferencia> {
    const items: Array<Record<string, unknown>> = p.items.map((i, n) => ({
      id: String(n + 1),
      title: i.title,
      quantity: i.quantity,
      unit_price: i.unit_price_cents / 100,
      currency_id: 'BRL',
    }));
    if (p.shipping_cents > 0) {
      items.push({ id: 'entrega', title: 'Entrega', quantity: 1, unit_price: p.shipping_cents / 100, currency_id: 'BRL' });
    }
    const expiracao = formatoDataMP(p.expires_at);
    const notification_url =
      `${ctx.base}/webhook/mercadopago-lojas?project_id=${encodeURIComponent(ctx.project_id)}` +
      `&account_ref=${encodeURIComponent(ctx.account_ref)}`;

    const raw = await this.client.request<MPPreferencia>('POST', '/checkout/preferences', {
      body: {
        items,
        payer: p.payer.phone ? { name: p.payer.name, phone: { number: p.payer.phone } } : { name: p.payer.name },
        external_reference: p.reference,
        notification_url,
        back_urls: { success: p.back_url, pending: p.back_url, failure: p.back_url },
        auto_return: 'approved',
        payment_methods: { excluded_payment_types: [{ id: 'ticket' }, { id: 'atm' }], installments: p.max_installments },
        expires: true,
        expiration_date_to: expiracao,
        date_of_expiration: expiracao,
      },
    });

    // em teste, o link do sandbox quando o MP devolve; a TASK-394 confirma qual funciona
    const init_point = (this.ambiente === 'teste' && raw.sandbox_init_point) || raw.init_point;
    if (!raw.id || !init_point) throw new MercadoPagoError(502, 'invalid_response', 'Resposta inesperada do Mercado Pago');
    return { id: String(raw.id), init_point, expires_at: new Date(p.expires_at).toISOString(), ambiente: this.ambiente };
  }

  private paraPaymentLoja(raw: MPPayment, account_ref: string): PaymentLoja {
    const base = paraPayment(raw, this.ambiente);
    const emMediacao = raw.status === 'in_mediation';
    return {
      ...base,
      // em mediação o pagamento foi aprovado, mas está em disputa
      status: emMediacao ? 'approved' : base.status,
      account_ref,
      installments: typeof raw.installments === 'number' ? raw.installments : null,
      refunded_cents: Math.round((raw.transaction_amount_refunded ?? 0) * 100),
      disputed: emMediacao || raw.status === 'charged_back',
    };
  }

  async obterPagamento(id: string, account_ref: string): Promise<PaymentLoja> {
    const raw = await this.client.request<MPPayment>('GET', `/v1/payments/${encodeURIComponent(id)}`);
    return this.paraPaymentLoja(raw, account_ref);
  }

  async buscarPorReferencia(reference: string, account_ref: string): Promise<PaymentLoja[]> {
    const res = await this.client.request<MPBusca>('GET', '/v1/payments/search', {
      query: { external_reference: reference, sort: 'date_created', criteria: 'desc', limit: '20' },
    });
    return (res.results ?? [])
      .filter((p) => p.external_reference === reference)
      .sort((a, b) => dataCriacao(b) - dataCriacao(a))
      .map((p) => this.paraPaymentLoja(p, account_ref));
  }

  /** Sem `amount_cents` o estorno é integral (sem corpo). 4xx do MP vira `EstornoRecusadoError`. */
  async estornar(id: string, account_ref: string, p: { amount_cents?: number; idempotency_key: string }): Promise<PaymentLoja> {
    try {
      await this.client.request('POST', `/v1/payments/${encodeURIComponent(id)}/refunds`, {
        idempotencyKey: p.idempotency_key,
        body: p.amount_cents !== undefined ? { amount: p.amount_cents / 100 } : undefined,
      });
    } catch (err) {
      if (err instanceof MercadoPagoError && err.status >= 400 && err.status < 500) throw new EstornoRecusadoError(err.message);
      throw err;
    }
    return this.obterPagamento(id, account_ref);
  }
}

function dataCriacao(p: MPPayment): number {
  const t = Date.parse(p.date_created ?? '');
  return Number.isNaN(t) ? 0 : t;
}

export function buildCheckoutLojas(ambiente: Ambiente, accessToken: string): CheckoutLojas {
  return new CheckoutLojas(ambiente, new MercadoPagoClient(accessToken));
}
