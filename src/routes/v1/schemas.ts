import { z } from 'zod';

const frequencia = z.union([z.literal(1), z.literal(12)]);
const cents = z.number().int().positive();
const texto = z.string().min(1).max(256);
const dataISO = z.iso.datetime({ offset: true });

export const criarAssinatura = z.object({
  reference: texto,
  payer_email: z.email(),
  reason: texto,
  amount_cents: cents,
  frequency_months: frequencia,
  back_url: z.url(),
  start_date: dataISO.optional(),
});

export const criarPlano = z.object({
  reason: texto,
  amount_cents: cents,
  frequency_months: frequencia,
  back_url: z.url(),
});

export const criarAssinaturaCartao = z.object({
  reference: texto,
  payer_email: z.email(),
  plan_id: texto,
  card_token_id: texto,
});

export const atualizarAssinatura = z.object({ amount_cents: cents });

export const criarPix = z.object({
  reference: texto,
  payer_email: z.email(),
  description: texto,
  amount_cents: cents,
  expires_at: dataISO,
  idempotency_key: z.string().min(1).max(128),
});

export const reembolsar = z.object({ idempotency_key: z.string().min(1).max(128) });

export const consultaPorReferencia = z.object({ reference: texto });

export const conectarConta = z.object({
  account_ref: z.string().min(1).max(100),
  return_url: z.url(),
});

/* ---------- checkout das lojas (TASK-398) ---------- */

const MIN_EXPIRA_MS = 5 * 60_000;
const MAX_EXPIRA_MS = 3 * 24 * 3_600_000;

export const criarPreferencia = z.object({
  account_ref: z.string().min(1).max(100),
  reference: z.string().min(1).max(100),
  items: z
    .array(
      z.object({
        title: z.string().min(1).max(120),
        quantity: z.number().int().min(1).max(99),
        unit_price_cents: cents,
      })
    )
    .min(1)
    .max(50),
  shipping_cents: z.number().int().min(0),
  payer: z.object({ name: z.string().min(1).max(120), phone: z.string().max(20).optional() }),
  back_url: z.url(),
  expires_at: dataISO.refine(
    (v) => {
      const dif = Date.parse(v) - Date.now();
      return dif >= MIN_EXPIRA_MS && dif <= MAX_EXPIRA_MS;
    },
    { message: 'precisa ser entre 5 minutos e 3 dias a partir de agora' }
  ),
  max_installments: z.number().int().min(1).max(12),
});

export const contaDoPagamento = z.object({ account_ref: z.string().min(1).max(100) });

export const pagamentosPorReferencia = z.object({
  account_ref: z.string().min(1).max(100),
  reference: z.string().min(1).max(100),
});

export const estornarLoja = z.object({
  account_ref: z.string().min(1).max(100),
  amount_cents: cents.optional(),
  idempotency_key: z.string().min(8).max(100),
});
