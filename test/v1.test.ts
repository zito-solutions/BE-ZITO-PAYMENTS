import fs from 'node:fs';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { MercadoPagoError } from '../src/gateways/mercadopago/mercadopago.client';
import { FakeMPClient, projetoExemplo } from './helpers/fakes';
import { subirApp, TOKEN_MP } from './helpers/app';

const fx = (n: string) => JSON.parse(fs.readFileSync(path.join(__dirname, 'fixtures/mercadopago', n), 'utf-8'));
const preapproval = fx('preapproval_authorized.json');
const pagamento = fx('payment_assinatura_aprovado.json');
const SID = preapproval.id as string;

let app: Awaited<ReturnType<typeof subirApp>>;
afterEach(async () => { await app?.fechar(); vi.restoreAllMocks(); });

const chamar = (metodo: string, rota: string, corpo?: unknown, chave: string | null = projetoExemplo.api_key) =>
  fetch(`${app.url}/v1${rota}`, {
    method: metodo,
    headers: { 'content-type': 'application/json', ...(chave ? { 'x-api-key': chave } : {}) },
    body: corpo === undefined ? undefined : JSON.stringify(corpo),
  });

const assinatura = {
  reference: 'loja-1', payer_email: 'cliente.ficticia@exemplo.com.br', reason: 'Dittu Pro', amount_cents: 1990,
  frequency_months: 1, back_url: 'https://dittu.com.br/painel/assinatura',
};
const pix = {
  reference: 'loja-1', payer_email: 'cliente.ficticia@exemplo.com.br', description: 'Dittu Pro 12 meses', amount_cents: 19900,
  expires_at: '2026-11-20T15:00:00.000Z', idempotency_key: 'idem-12345678',
};

describe('autenticação e configuração', () => {
  it('401 sem chave e com chave errada', async () => {
    app = await subirApp(new FakeMPClient({}));
    expect((await chamar('GET', '/config', undefined, null)).status).toBe(401);
    expect((await chamar('GET', '/config', undefined, 'errada')).status).toBe(401);
  });

  it('409 gateway_not_configured sem config do MP', async () => {
    app = await subirApp(new FakeMPClient({}), { comConfigMP: false });
    const r = await chamar('GET', '/config');
    expect(r.status).toBe(409);
    expect((await r.json()).error).toBe('gateway_not_configured');
  });

  it('GET /config mostra o ambiente', async () => {
    app = await subirApp(new FakeMPClient({}));
    expect(await (await chamar('GET', '/config')).json()).toEqual({ gateway: 'mercadopago', ambiente: 'teste' });
  });
});

describe('assinaturas', () => {
  it('POST /subscriptions -> 201 pendente com init_point, no formato que o MP pede', async () => {
    const client = new FakeMPClient({ 'POST /preapproval': { ...preapproval, status: 'pending', init_point: 'https://mp/checkout' } });
    app = await subirApp(client);
    const r = await chamar('POST', '/subscriptions', { ...assinatura, start_date: '2026-12-20T13:00:00.000Z' });
    expect(r.status).toBe(201);
    expect(await r.json()).toMatchObject({ status: 'pending', init_point: 'https://mp/checkout', ambiente: 'teste' });
    expect(client.calls[0]!.options!.body).toMatchObject({
      status: 'pending', external_reference: 'loja-1', payer_email: assinatura.payer_email, back_url: assinatura.back_url,
      auto_recurring: { frequency: 1, frequency_type: 'months', transaction_amount: 19.9, currency_id: 'BRL', start_date: '2026-12-20T10:00:00.000-03:00' },
    });
    expect(client.calls[0]!.options!.body).not.toHaveProperty('preapproval_plan_id');
  });

  it('400 com corpo inválido (valor, frequência, e-mail, back_url)', async () => {
    app = await subirApp(new FakeMPClient({}));
    for (const ruim of [{ amount_cents: 19.9 }, { frequency_months: 3 }, { payer_email: 'nao-e-email' }, { back_url: 'sem-url' }, { reference: '' }]) {
      const r = await chamar('POST', '/subscriptions', { ...assinatura, ...ruim });
      expect(r.status).toBe(400);
      const j = await r.json();
      expect(j.error).toBe('validation_error');
      expect(j.message).toContain(Object.keys(ruim)[0]);
    }
  });

  it('POST /plans e POST /subscriptions/card', async () => {
    const client = new FakeMPClient({
      'POST /preapproval_plan': { id: 'plano1', init_point: 'https://mp/plano', status: 'active' },
      'GET /preapproval_plan/plano1': { id: 'plano1', reason: 'Dittu Pro', back_url: 'https://x', auto_recurring: preapproval.auto_recurring },
      'POST /preapproval': preapproval,
    });
    app = await subirApp(client);
    const p = await chamar('POST', '/plans', { reason: 'Dittu Pro', amount_cents: 1990, frequency_months: 12, back_url: 'https://dittu.com.br' });
    expect(p.status).toBe(201);
    expect(await p.json()).toEqual({ id: 'plano1', init_point: 'https://mp/plano', status: 'active' });
    expect(client.calls[0]!.options!.body).toMatchObject({ auto_recurring: { frequency: 12, transaction_amount: 19.9 } });

    const c = await chamar('POST', '/subscriptions/card', { reference: 'loja-1', payer_email: 'cliente.ficticia@exemplo.com.br', plan_id: 'plano1', card_token_id: 'tok' });
    expect(c.status).toBe(201);
    expect((await c.json()).status).toBe('authorized');
    expect(client.calls.at(-1)!.options!.body).toMatchObject({ preapproval_plan_id: 'plano1', card_token_id: 'tok', status: 'authorized' });
  });

  it('GET por id, por referência (mais recente) e 404', async () => {
    const client = new FakeMPClient({
      [`GET /preapproval/${SID}`]: preapproval,
      'GET /preapproval/search': (o: { query?: Record<string, string | undefined> } | undefined) =>
        o?.query?.['external_reference'] === 'loja-1'
          ? { results: [
              { ...preapproval, id: 'velha', date_created: '2026-01-01T00:00:00.000-04:00', external_reference: 'loja-1' },
              { ...preapproval, id: 'nova', date_created: '2026-06-01T00:00:00.000-04:00', external_reference: 'loja-1' },
              { ...preapproval, id: 'outra', date_created: '2026-09-01T00:00:00.000-04:00', external_reference: 'loja-2' },
            ] }
          : { results: [] },
      'GET /preapproval/naoexiste': new MercadoPagoError(404, 'not_found', 'Preapproval not found'),
    });
    app = await subirApp(client);
    expect((await (await chamar('GET', `/subscriptions/${SID}`)).json()).id).toBe(SID);
    expect((await (await chamar('GET', '/subscriptions?reference=loja-1')).json()).id).toBe('nova');
    expect((await chamar('GET', '/subscriptions?reference=loja-9')).status).toBe(404);
    expect((await chamar('GET', '/subscriptions')).status).toBe(400);
    const nf = await chamar('GET', '/subscriptions/naoexiste');
    expect(nf.status).toBe(404);
    expect((await nf.json()).error).toBe('not_found');
  });

  it('PATCH atualiza o valor e cancelar é idempotente', async () => {
    let cancelada = false;
    const client = new FakeMPClient({
      [`PUT /preapproval/${SID}`]: (o: { body?: { status?: string } } | undefined) => {
        if (o?.body?.status === 'cancelled') cancelada = true;
        return { ...preapproval, status: cancelada ? 'cancelled' : 'authorized', auto_recurring: { ...preapproval.auto_recurring, transaction_amount: 24.9 } };
      },
      [`GET /preapproval/${SID}`]: () => ({ ...preapproval, status: cancelada ? 'canceled' : 'authorized' }),
    });
    app = await subirApp(client);
    const up = await chamar('PATCH', `/subscriptions/${SID}`, { amount_cents: 2490 });
    expect((await up.json()).amount_cents).toBe(2490);
    expect((await chamar('PATCH', `/subscriptions/${SID}`, { amount_cents: -1 })).status).toBe(400);

    const c1 = await chamar('POST', `/subscriptions/${SID}/cancel`);
    expect((await c1.json()).status).toBe('cancelled');
    const puts = client.calls.filter((c) => c.method === 'PUT').length;
    const c2 = await chamar('POST', `/subscriptions/${SID}/cancel`);
    expect(c2.status).toBe(200);
    expect((await c2.json()).status).toBe('cancelled');
    expect(client.calls.filter((c) => c.method === 'PUT').length).toBe(puts); // não cancelou de novo
  });
});

describe('Pix e pagamentos', () => {
  it('POST /pix -> 201 com QR, expiração no formato do MP e chave de idempotência', async () => {
    const client = new FakeMPClient({
      'POST /v1/payments': { id: 555, status: 'pending', external_reference: 'loja-1', transaction_amount: 199, payment_method_id: 'pix',
        date_of_expiration: '2026-11-20T12:00:00.000-03:00', point_of_interaction: { transaction_data: { qr_code: 'qr', qr_code_base64: 'b64' } } },
    });
    app = await subirApp(client);
    const r = await chamar('POST', '/pix', pix);
    expect(r.status).toBe(201);
    expect(await r.json()).toMatchObject({ id: '555', method: 'pix', amount_cents: 19900, pix: { qr_code: 'qr', qr_code_base64: 'b64', expires_at: '2026-11-20T15:00:00.000Z' } });
    expect(client.calls[0]!.options!.idempotencyKey).toBe('idem-12345678');
    expect(client.calls[0]!.options!.body).toMatchObject({
      transaction_amount: 199, payment_method_id: 'pix', date_of_expiration: '2026-11-20T12:00:00.000-03:00', external_reference: 'loja-1',
    });
    expect((await chamar('POST', '/pix', { ...pix, expires_at: 'amanha' })).status).toBe(400);
    expect((await chamar('POST', '/pix', { ...pix, idempotency_key: undefined })).status).toBe(400);
  });

  it('GET /payments/:id e reembolso integral', async () => {
    const client = new FakeMPClient({
      [`GET /v1/payments/${pagamento.id}`]: pagamento,
      [`POST /v1/payments/${pagamento.id}/refunds`]: {},
    });
    app = await subirApp(client);
    expect((await (await chamar('GET', `/payments/${pagamento.id}`)).json()).status).toBe('approved');
    const r = await chamar('POST', `/payments/${pagamento.id}/refund`, { idempotency_key: 'refund-12345' });
    expect(r.status).toBe(200);
    expect(client.calls.find((c) => c.method === 'POST')!.options!.idempotencyKey).toBe('refund-12345');
    expect((await chamar('POST', `/payments/${pagamento.id}/refund`, {})).status).toBe(400);
  });
});

describe('erros do MP e segredos', () => {
  it('502 gateway_error com a mensagem do MP, sem token, e log sem e-mail', async () => {
    app = await subirApp(new FakeMPClient({ 'POST /preapproval': new MercadoPagoError(400, 'bad', 'payer_email is required') }));
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});
    const r = await chamar('POST', '/subscriptions', assinatura);
    expect(r.status).toBe(502);
    const j = await r.json();
    expect(j).toEqual({ error: 'gateway_error', message: 'payer_email is required' });
    await new Promise((res) => setTimeout(res, 20));
    const saida = JSON.stringify(log.mock.calls);
    expect(saida).toContain('[Dittu] [mercadopago] POST /v1/subscriptions 502');
    expect(saida).not.toContain(assinatura.payer_email);
    expect(JSON.stringify(j)).not.toContain(TOKEN_MP);
  });
});

describe('callbacks que falharam', () => {
  it('lista as failed do projeto e reenvia', async () => {
    app = await subirApp(new FakeMPClient({}));
    const ev = (await app.repos.events.insert({
      project_id: projetoExemplo.id, gateway: 'mercadopago', event_type: 'payment.approved', customer_ref: 'loja-1',
      gateway_event_id: 'g1', payload: {},
    }))!;
    const d = await app.repos.deliveries.create(ev.id, projetoExemplo.id);
    await app.repos.deliveries.update(d.id, { status: 'failed', attempts: 7, last_error: 'HTTP 500', last_status_code: 500 });

    const lista = await (await chamar('GET', '/callbacks/failed')).json();
    expect(lista.deliveries).toEqual([expect.objectContaining({ id: d.id, event: 'payment.approved', attempts: 7, last_error: 'HTTP 500' })]);

    const r = await chamar('POST', `/callbacks/${d.id}/retry`);
    expect(r.status).toBe(200);
    expect(app.deliveries[0]).toMatchObject({ status: 'pending', attempts: 0 });
    expect((await chamar('POST', `/callbacks/${d.id}/retry`)).status).toBe(404); // já não está failed
    expect((await chamar('GET', '/callbacks/failed')).status).toBe(200);
  });

  it('não depende da config do MP', async () => {
    app = await subirApp(new FakeMPClient({}), { comConfigMP: false });
    expect((await chamar('GET', '/callbacks/failed')).status).toBe(200);
  });
});
