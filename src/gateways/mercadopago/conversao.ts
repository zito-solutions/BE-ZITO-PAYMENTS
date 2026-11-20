import { Ambiente, Payment, Subscription } from '../gateway.interface';

/* Formas mínimas do que o Mercado Pago devolve (só o que o hub lê). */
export interface MPPreapproval {
  id: string;
  status?: string;
  reason?: string;
  external_reference?: string;
  payer_email?: string;
  init_point?: string;
  next_payment_date?: string;
  date_created?: string;
  last_modified?: string;
  preapproval_plan_id?: string;
  auto_recurring?: {
    frequency?: number;
    frequency_type?: string;
    transaction_amount?: number;
    currency_id?: string;
    start_date?: string;
  };
}

export interface MPPayment {
  id: number | string;
  status?: string;
  status_detail?: string;
  external_reference?: string | null;
  transaction_amount?: number;
  transaction_amount_refunded?: number;
  installments?: number;
  date_created?: string;
  payment_method_id?: string;
  payment_type_id?: string;
  date_approved?: string | null;
  date_of_expiration?: string | null;
  fee_details?: Array<{ amount?: number }>;
  metadata?: Record<string, unknown> | null;
  point_of_interaction?: {
    transaction_data?: {
      qr_code?: string;
      qr_code_base64?: string;
      subscription_id?: string;
    };
  };
}

export interface MPAuthorizedPayment {
  id: number | string;
  preapproval_id?: string;
  status?: string;
  external_reference?: string | null;
  transaction_amount?: number;
  payment?: { id?: number | string; status?: string } | null;
}

export function centavos(valor: number | undefined | null): number {
  return Math.round((valor ?? 0) * 100);
}

export function statusAssinatura(s: string | undefined): Subscription['status'] {
  switch (s) {
    case 'authorized':
      return 'authorized';
    case 'paused':
      return 'paused';
    case 'cancelled':
    case 'canceled':
      return 'cancelled';
    default:
      return 'pending';
  }
}

export function paraSubscription(p: MPPreapproval, ambiente: Ambiente): Subscription {
  const ar = p.auto_recurring ?? {};
  return {
    id: String(p.id),
    reference: p.external_reference ?? '',
    status: statusAssinatura(p.status),
    amount_cents: centavos(ar.transaction_amount),
    frequency_months: ar.frequency_type === 'months' && ar.frequency ? ar.frequency : 1,
    payer_email: p.payer_email ?? '',
    init_point: p.init_point ?? null,
    next_payment_date: iso(p.next_payment_date),
    ambiente,
  };
}

function statusPagamento(p: MPPayment): Payment['status'] {
  switch (p.status) {
    case 'approved':
      return 'approved';
    case 'rejected':
      return 'rejected';
    case 'refunded':
      return 'refunded';
    case 'charged_back':
      return 'charged_back';
    case 'cancelled':
      return p.status_detail === 'expired' ? 'expired' : 'cancelled';
    default:
      return 'pending'; // pending, in_process, in_mediation, authorized
  }
}

function metodo(p: MPPayment): Payment['method'] {
  if (p.payment_method_id === 'pix') return 'pix';
  if (p.payment_type_id === 'credit_card') return 'credit_card';
  if (p.payment_type_id === 'debit_card') return 'debit_card';
  return 'other';
}

/** `date_of_expiration` do MP traz offset (-03:00); devolve ISO em UTC. */
function iso(data: string | null | undefined): string | null {
  if (!data) return null;
  const d = new Date(data);
  return Number.isNaN(d.getTime()) ? null : d.toISOString();
}

export function subscriptionIdDoPagamento(p: MPPayment): string | null {
  const id = p.point_of_interaction?.transaction_data?.subscription_id ?? p.metadata?.['preapproval_id'];
  return id ? String(id) : null;
}

export function paraPayment(p: MPPayment, ambiente: Ambiente): Payment {
  const td = p.point_of_interaction?.transaction_data;
  const taxas = (p.fee_details ?? []).reduce((soma, f) => soma + (f.amount ?? 0), 0);
  const temTaxa = (p.fee_details ?? []).length > 0;
  const method = metodo(p);
  return {
    id: String(p.id),
    reference: p.external_reference ?? '',
    status: statusPagamento(p),
    status_detail: p.status_detail ?? null,
    amount_cents: centavos(p.transaction_amount),
    fee_cents: temTaxa ? centavos(taxas) : null,
    method,
    approved_at: iso(p.date_approved),
    subscription_id: subscriptionIdDoPagamento(p),
    pix:
      method === 'pix' && td?.qr_code
        ? { qr_code: td.qr_code, qr_code_base64: td.qr_code_base64 ?? '', expires_at: iso(p.date_of_expiration) }
        : null,
    ambiente,
  };
}

/** `AAAA-MM-DDTHH:mm:ss.000-03:00` (o Brasil não tem horário de verão desde 2019). */
export function formatoDataMP(isoUtc: string): string {
  const d = new Date(new Date(isoUtc).getTime() - 3 * 3600 * 1000);
  return d.toISOString().replace(/Z$/, '').replace(/\.\d{3}$/, '.000') + '-03:00';
}
