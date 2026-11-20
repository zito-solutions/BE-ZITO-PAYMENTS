import {
  Ambiente,
  CheckoutParams,
  PaymentGateway,
  Payment,
  Subscription,
  SubscriptionStatus,
  WebhookInput,
  WebhookResult,
} from '../gateway.interface';
import { MercadoPagoClient, MPClient } from './mercadopago.client';
import {
  MPAuthorizedPayment,
  MPPayment,
  MPPreapproval,
  formatoDataMP,
  paraPayment,
  paraSubscription,
} from './conversao';
import { tratarAvisoMP } from './webhook';

export interface MercadoPagoConfig {
  access_token: string;
  webhook_secret: string;
  ambiente: Ambiente;
}

export interface CriarAssinaturaParams {
  reference: string;
  payer_email: string;
  reason: string;
  amount_cents: number;
  frequency_months: number;
  back_url: string;
  start_date?: string;
}

export interface CriarPlanoParams {
  reason: string;
  amount_cents: number;
  frequency_months: number;
  back_url: string;
}

export interface CriarAssinaturaCartaoParams {
  reference: string;
  payer_email: string;
  plan_id: string;
  card_token_id: string;
}

export interface CriarPixParams {
  reference: string;
  payer_email: string;
  description: string;
  amount_cents: number;
  expires_at: string;
  idempotency_key: string;
}

interface MPPlan {
  id: string;
  status?: string;
  init_point?: string;
  reason?: string;
  back_url?: string;
  auto_recurring?: MPPreapproval['auto_recurring'];
}

export class MercadoPagoGateway implements PaymentGateway {
  readonly ambiente: Ambiente;
  private readonly client: MPClient;

  constructor(private readonly config: MercadoPagoConfig, client?: MPClient) {
    this.ambiente = config.ambiente === 'producao' ? 'producao' : 'teste';
    this.client = client ?? new MercadoPagoClient(config.access_token);
  }

  /* ---------- assinaturas ---------- */

  async criarPlano(p: CriarPlanoParams): Promise<{ id: string; init_point: string | null; status: string }> {
    const plano = await this.client.request<MPPlan>('POST', '/preapproval_plan', {
      body: {
        reason: p.reason,
        back_url: p.back_url,
        auto_recurring: {
          frequency: p.frequency_months,
          frequency_type: 'months',
          transaction_amount: p.amount_cents / 100,
          currency_id: 'BRL',
        },
      },
    });
    return { id: String(plano.id), init_point: plano.init_point ?? null, status: plano.status ?? 'active' };
  }

  async criarAssinaturaPendente(p: CriarAssinaturaParams): Promise<Subscription> {
    const auto_recurring: Record<string, unknown> = {
      frequency: p.frequency_months,
      frequency_type: 'months',
      transaction_amount: p.amount_cents / 100,
      currency_id: 'BRL',
    };
    if (p.start_date) auto_recurring['start_date'] = formatoDataMP(p.start_date);

    const raw = await this.client.request<MPPreapproval>('POST', '/preapproval', {
      body: {
        reason: p.reason,
        external_reference: p.reference,
        payer_email: p.payer_email,
        back_url: p.back_url,
        auto_recurring,
        status: 'pending',
      },
    });
    return paraSubscription(raw, this.ambiente);
  }

  async criarAssinaturaComCartao(p: CriarAssinaturaCartaoParams): Promise<Subscription> {
    const plano = await this.client.request<MPPlan>('GET', `/preapproval_plan/${encodeURIComponent(p.plan_id)}`);
    const raw = await this.client.request<MPPreapproval>('POST', '/preapproval', {
      body: {
        preapproval_plan_id: p.plan_id,
        reason: plano.reason,
        external_reference: p.reference,
        payer_email: p.payer_email,
        card_token_id: p.card_token_id,
        back_url: plano.back_url,
        auto_recurring: plano.auto_recurring,
        status: 'authorized',
      },
    });
    return paraSubscription(raw, this.ambiente);
  }

  obterAssinaturaBruta(id: string): Promise<MPPreapproval> {
    return this.client.request<MPPreapproval>('GET', `/preapproval/${encodeURIComponent(id)}`);
  }

  async obterAssinatura(id: string): Promise<Subscription> {
    return paraSubscription(await this.obterAssinaturaBruta(id), this.ambiente);
  }

  /**
   * O sandbox ignora o filtro `external_reference` de /preapproval/search (devolve tudo); o que filtra é o `q`.
   * Manda os dois e confere a referência exata no resultado.
   */
  async buscarAssinaturaPorReferencia(reference: string): Promise<Subscription | null> {
    const res = await this.client.request<{ results?: MPPreapproval[] }>('GET', '/preapproval/search', {
      query: { external_reference: reference, q: reference, sort: 'date_created:desc', limit: '100' },
    });
    const lista = (res.results ?? [])
      .filter((p) => p.external_reference === reference)
      .sort((x, y) => Date.parse(y.date_created ?? '') - Date.parse(x.date_created ?? ''));
    return lista[0] ? paraSubscription(lista[0], this.ambiente) : null;
  }

  async atualizarValor(id: string, amount_cents: number): Promise<Subscription> {
    const raw = await this.client.request<MPPreapproval>('PUT', `/preapproval/${encodeURIComponent(id)}`, {
      body: { auto_recurring: { transaction_amount: amount_cents / 100, currency_id: 'BRL' } },
    });
    return paraSubscription(raw, this.ambiente);
  }

  /** Idempotente: já cancelada devolve a assinatura como está. */
  async cancelarAssinatura(id: string): Promise<Subscription> {
    const atual = await this.obterAssinaturaBruta(id);
    if (atual.status === 'cancelled' || atual.status === 'canceled') {
      return paraSubscription(atual, this.ambiente);
    }
    const raw = await this.client.request<MPPreapproval>('PUT', `/preapproval/${encodeURIComponent(id)}`, {
      body: { status: 'cancelled' },
    });
    return paraSubscription(raw, this.ambiente);
  }

  obterPagamentoDeAssinaturaBruto(id: string): Promise<MPAuthorizedPayment> {
    return this.client.request<MPAuthorizedPayment>('GET', `/authorized_payments/${encodeURIComponent(id)}`);
  }

  /* ---------- Pix e pagamentos ---------- */

  async criarPix(p: CriarPixParams): Promise<Payment> {
    const raw = await this.client.request<MPPayment>('POST', '/v1/payments', {
      idempotencyKey: p.idempotency_key,
      body: {
        transaction_amount: p.amount_cents / 100,
        description: p.description,
        payment_method_id: 'pix',
        external_reference: p.reference,
        date_of_expiration: formatoDataMP(p.expires_at),
        payer: { email: p.payer_email },
      },
    });
    return paraPayment(raw, this.ambiente);
  }

  obterPagamentoBruto(id: string): Promise<MPPayment> {
    return this.client.request<MPPayment>('GET', `/v1/payments/${encodeURIComponent(id)}`);
  }

  async obterPagamento(id: string): Promise<Payment> {
    return paraPayment(await this.obterPagamentoBruto(id), this.ambiente);
  }

  async reembolsar(id: string, idempotency_key: string): Promise<Payment> {
    await this.client.request('POST', `/v1/payments/${encodeURIComponent(id)}/refunds`, {
      idempotencyKey: idempotency_key,
      body: {},
    });
    return this.obterPagamento(id);
  }

  /* ---------- interface PaymentGateway ---------- */

  async createCheckoutLink(_params: CheckoutParams): Promise<string> {
    throw new Error('Mercado Pago: use a API /v1 (POST /v1/subscriptions ou /v1/pix)');
  }

  async getSubscriptionStatus(customer_ref: string): Promise<SubscriptionStatus> {
    const s = await this.buscarAssinaturaPorReferencia(customer_ref);
    return { active: s?.status === 'authorized', expires_at: s?.next_payment_date ?? undefined };
  }

  handleWebhookEvent(input: WebhookInput): Promise<WebhookResult | null> {
    return tratarAvisoMP(input, { gateway: this, segredo: this.config.webhook_secret });
  }
}
