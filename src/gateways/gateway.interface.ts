import type { IncomingHttpHeaders } from 'http';

export interface CheckoutParams {
  customer_ref: string;
  priceId: string;
  successUrl: string;
  cancelUrl: string;
}

export type Ambiente = 'teste' | 'producao';

export interface Subscription {
  id: string;
  reference: string;
  status: 'pending' | 'authorized' | 'paused' | 'cancelled';
  amount_cents: number;
  frequency_months: number;
  payer_email: string;
  init_point: string | null;
  next_payment_date: string | null;
  ambiente: Ambiente;
}

export interface Payment {
  id: string;
  reference: string;
  status: 'pending' | 'approved' | 'rejected' | 'cancelled' | 'expired' | 'refunded' | 'charged_back';
  status_detail: string | null;
  amount_cents: number;
  fee_cents: number | null;
  method: 'pix' | 'credit_card' | 'debit_card' | 'other';
  approved_at: string | null;
  subscription_id: string | null;
  pix: { qr_code: string; qr_code_base64: string; expires_at: string | null } | null;
  ambiente: Ambiente;
}

export type WebhookEventName =
  | 'subscription.activated'
  | 'subscription.payment_approved'
  | 'subscription.payment_failed'
  | 'subscription.cancelled'
  | 'payment.approved'
  | 'payment.expired'
  | 'payment.refunded';

export interface WebhookResult {
  event: WebhookEventName;
  customer_ref: string;
  gateway_event_id: string;
  data?: { subscription: Subscription | null; payment: Payment | null };
}

export interface WebhookInput {
  rawBody: Buffer;
  headers: IncomingHttpHeaders;
  query: Record<string, string | undefined>;
}

export interface SubscriptionStatus {
  active: boolean;
  expires_at?: string;
}

export interface PaymentGateway {
  createCheckoutLink(params: CheckoutParams): Promise<string>;
  handleWebhookEvent(input: WebhookInput): Promise<WebhookResult | null>;
  getSubscriptionStatus(customer_ref: string): Promise<SubscriptionStatus>;
}
