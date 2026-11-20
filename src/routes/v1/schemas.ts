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
