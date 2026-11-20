import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { formatoDataMP, paraPayment, paraSubscription } from '../src/gateways/mercadopago/conversao';

const fx = (n: string) => JSON.parse(fs.readFileSync(path.join(__dirname, 'fixtures/mercadopago', n), 'utf-8'));

describe('conversão MP -> contrato', () => {
  it('assinatura autorizada (sandbox)', () => {
    const s = paraSubscription(fx('preapproval_authorized.json'), 'teste');
    expect(s).toMatchObject({
      status: 'authorized', amount_cents: 1990, frequency_months: 1, reference: expect.stringMatching(/^sandbox-apro-/),
      payer_email: 'cliente.ficticia@exemplo.com.br', ambiente: 'teste',
    });
    expect(s.next_payment_date).toMatch(/^2026-12-20T13:\d\d:\d\d\.000Z$/); // -04:00 vira UTC
  });

  it('assinatura pendente com start_date traz o init_point', () => {
    const s = paraSubscription(fx('preapproval_pending_start_date.json'), 'teste');
    expect(s.status).toBe('pending');
    expect(s.init_point).toContain('preapproval_id=');
  });

  it('normaliza "canceled" para "cancelled"', () => {
    expect(paraSubscription({ id: '1', status: 'canceled' }, 'teste').status).toBe('cancelled');
    expect(paraSubscription({ id: '1', status: 'paused' }, 'producao').status).toBe('paused');
  });

  it('pagamento de assinatura aprovado: taxa, método e subscription_id', () => {
    const p = paraPayment(fx('payment_assinatura_aprovado.json'), 'teste');
    expect(p).toMatchObject({
      status: 'approved', status_detail: 'accredited', amount_cents: 1990, fee_cents: 50, method: 'credit_card',
      pix: null, ambiente: 'teste',
    });
    expect(p.subscription_id).toMatch(/^[0-9a-f]{32}$/);
    expect(p.approved_at).toMatch(/Z$/);
  });

  it('Pix pendente com QR (formato do manual do MP) e Pix vencido', () => {
    const base = {
      id: 987, status: 'pending', status_detail: 'pending_waiting_transfer', external_reference: 'loja-1',
      transaction_amount: 29.9, payment_method_id: 'pix', payment_type_id: 'bank_transfer',
      date_of_expiration: '2026-11-20T10:30:00.000-03:00',
      point_of_interaction: { transaction_data: { qr_code: '00020126...', qr_code_base64: 'iVBORw0KGgo=' } },
    };
    const p = paraPayment(base, 'teste');
    expect(p).toMatchObject({ method: 'pix', amount_cents: 2990, fee_cents: null, subscription_id: null });
    expect(p.pix).toEqual({ qr_code: '00020126...', qr_code_base64: 'iVBORw0KGgo=', expires_at: '2026-11-20T13:30:00.000Z' });

    const vencido = paraPayment({ ...base, status: 'cancelled', status_detail: 'expired' }, 'teste');
    expect(vencido.status).toBe('expired');
    expect(paraPayment({ ...base, status: 'cancelled', status_detail: 'by_payer' }, 'teste').status).toBe('cancelled');
    expect(paraPayment({ ...base, status: 'in_process' }, 'teste').status).toBe('pending');
  });

  it('formatoDataMP usa -03:00 com .000', () => {
    expect(formatoDataMP('2026-11-20T13:30:00.123Z')).toBe('2026-11-20T10:30:00.000-03:00');
  });
});
