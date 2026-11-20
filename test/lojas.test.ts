import fs from 'node:fs';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { MercadoPagoError } from '../src/gateways/mercadopago/mercadopago.client';
import { CheckoutLojas } from '../src/gateways/mercadopago/lojas';
import { eventoDoPagamento } from '../src/webhook/lojas.controller';
import { assinarAvisoMP } from './helpers/assinaturaMP';
import { FakeMPClient, projetoExemplo } from './helpers/fakes';
import { CONFIG_LOJAS, subirApp, TOKEN_MP } from './helpers/app';

const fx = (n: string) => JSON.parse(fs.readFileSync(path.join(__dirname, 'fixtures/mercadopago/lojas', `${n}.json`), 'utf-8'));
const TOK = 'APP_USR-token-da-lojista';
const REF = 'APP_USR-refresh-da-lojista';

type App = Awaited<ReturnType<typeof subirApp>>;
let app: App;
afterEach(async () => { await app?.fechar(); vi.restoreAllMocks(); });

const sobe = (client: FakeMPClient, opts: Parameters<typeof subirApp>[1] = {}) => subirApp(client, opts);
const v1 = (metodo: string, rota: string, corpo?: unknown, chave: string | null = projetoExemplo.api_key) =>
  fetch(`${app.url}/v1${rota}`, {
    method: metodo,
    headers: { 'content-type': 'application/json', ...(chave ? { 'x-api-key': chave } : {}) },
    body: corpo === undefined ? undefined : JSON.stringify(corpo),
  });

async function semear(a: App, ref = 'loja-1', mp = '998877') {
  return a.repos.accounts.upsertConnected({
    project_id: projetoExemplo.id, account_ref: ref, mp_user_id: mp, access_token: TOK, refresh_token: REF,
    public_key: 'pk', expires_at: new Date(Date.now() + 100 * 86400_000).toISOString(), connected_at: new Date().toISOString(),
  });
}

const em = (min: number) => new Date(Date.now() + min * 60_000).toISOString();
const preferencia = (extra: Record<string, unknown> = {}) => ({
  account_ref: 'loja-1', reference: 'pedido-1001',
  items: [{ title: 'Vestido midi', quantity: 2, unit_price_cents: 8990 }, { title: 'Cinto', quantity: 1, unit_price_cents: 3500 }],
  shipping_cents: 1500, payer: { name: 'Maria Ficticia', phone: '11999990000' },
  back_url: 'https://dittu.com.br/demo/pedido/1001', expires_at: em(60), max_installments: 3, ...extra,
});

describe('conversão do pagamento das lojas', () => {
  const lojas = (raw: unknown) => new CheckoutLojas('teste', new FakeMPClient({ 'GET /v1/payments/1': raw }));

  it('aprovado no cartão em 3x', async () => {
    const p = await lojas(fx('aprovado_cartao_3x')).obterPagamento('1', 'loja-1');
    expect(p).toMatchObject({
      id: '900001', reference: 'pedido-1001', status: 'approved', amount_cents: 15000, fee_cents: 750, method: 'credit_card',
      account_ref: 'loja-1', installments: 3, refunded_cents: 0, disputed: false, ambiente: 'teste',
    });
  });

  it('Pix pendente traz o QR; Pix vencido vira expired', async () => {
    const pend = await lojas(fx('pix_pendente')).obterPagamento('1', 'loja-1');
    expect(pend).toMatchObject({ status: 'pending', method: 'pix', pix: { qr_code: '00020126-qr-ficticio', expires_at: '2026-11-20T14:00:00.000Z' } });
    expect((await lojas(fx('pix_vencido')).obterPagamento('1', 'loja-1')).status).toBe('expired');
  });

  it('reembolso parcial fica approved com refunded_cents', async () => {
    expect(await lojas(fx('reembolso_parcial')).obterPagamento('1', 'loja-1')).toMatchObject({ status: 'approved', refunded_cents: 4050, disputed: false });
  });

  it('in_mediation vira approved com disputed; charged_back mantém o status e disputed', async () => {
    expect(await lojas(fx('em_mediacao')).obterPagamento('1', 'loja-1')).toMatchObject({ status: 'approved', disputed: true });
    expect(await lojas(fx('charged_back')).obterPagamento('1', 'loja-1')).toMatchObject({ status: 'charged_back', disputed: true });
  });
});

describe('criarPreferencia', () => {
  const ctx = { project_id: projetoExemplo.id, account_ref: 'loja 1/é', base: 'https://hub.exemplo' };
  const params = () => ({ ...preferencia(), account_ref: 'loja 1/é' });

  it('corpo enviado ao MP: itens com entrega, sem comissão, sem boleto, parcelas, notification_url e as duas datas', async () => {
    const client = new FakeMPClient({ 'POST /checkout/preferences': { id: 'pref-1', init_point: 'https://mp/real', sandbox_init_point: 'https://mp/sandbox' } });
    const expira = '2026-11-20T15:00:00.000Z';
    const r = await new CheckoutLojas('teste', client).criarPreferencia({ ...params(), expires_at: expira }, ctx);
    expect(r).toEqual({ id: 'pref-1', init_point: 'https://mp/sandbox', expires_at: expira, ambiente: 'teste' });
    const corpo = client.calls[0]!.options!.body as Record<string, any>;
    expect(corpo['items']).toEqual([
      { id: '1', title: 'Vestido midi', quantity: 2, unit_price: 89.9, currency_id: 'BRL' },
      { id: '2', title: 'Cinto', quantity: 1, unit_price: 35, currency_id: 'BRL' },
      { id: 'entrega', title: 'Entrega', quantity: 1, unit_price: 15, currency_id: 'BRL' },
    ]);
    expect(JSON.stringify(corpo)).not.toContain('marketplace_fee');
    expect(corpo['payer']).toEqual({ name: 'Maria Ficticia', phone: { number: '11999990000' } });
    expect(corpo['external_reference']).toBe('pedido-1001');
    expect(corpo['notification_url']).toBe(`https://hub.exemplo/webhook/mercadopago-lojas?project_id=${projetoExemplo.id}&account_ref=loja%201%2F%C3%A9`);
    expect(corpo['back_urls']).toEqual({ success: params().back_url, pending: params().back_url, failure: params().back_url });
    expect(corpo['auto_return']).toBe('approved');
    expect(corpo['payment_methods']).toEqual({ excluded_payment_types: [{ id: 'ticket' }, { id: 'atm' }], installments: 3 });
    expect(corpo['expires']).toBe(true);
    expect(corpo['expiration_date_to']).toBe('2026-11-20T12:00:00.000-03:00');
    expect(corpo['date_of_expiration']).toBe('2026-11-20T12:00:00.000-03:00');
  });

  it('sem entrega e sem telefone: nada de item "entrega" nem phone; em produção usa init_point', async () => {
    const client = new FakeMPClient({ 'POST /checkout/preferences': { id: 'p', init_point: 'https://mp/real', sandbox_init_point: 'https://mp/sandbox' } });
    const r = await new CheckoutLojas('producao', client).criarPreferencia({ ...params(), shipping_cents: 0, payer: { name: 'Maria Ficticia' } }, ctx);
    expect(r.init_point).toBe('https://mp/real');
    const corpo = client.calls[0]!.options!.body as Record<string, any>;
    expect(corpo['items']).toHaveLength(2);
    expect(corpo['payer']).toEqual({ name: 'Maria Ficticia' });
  });

  it('em teste sem sandbox_init_point usa o init_point', async () => {
    const client = new FakeMPClient({ 'POST /checkout/preferences': { id: 'p', init_point: 'https://mp/real' } });
    expect((await new CheckoutLojas('teste', client).criarPreferencia(params(), ctx)).init_point).toBe('https://mp/real');
  });
});

describe('rotas /v1/checkout', () => {
  const pref = { 'POST /checkout/preferences': { id: 'pref-1', init_point: 'https://mp/real', sandbox_init_point: 'https://mp/sandbox' } };

  it('401 sem chave', async () => {
    app = await sobe(new FakeMPClient({}));
    expect((await v1('POST', '/checkout/preferences', preferencia(), null)).status).toBe(401);
    expect((await v1('GET', '/checkout/payments/1?account_ref=loja-1', undefined, null)).status).toBe(401);
  });

  it('409 gateway_not_configured e account_not_connected (inexistente e desconectada)', async () => {
    app = await sobe(new FakeMPClient({}), { configLojas: null });
    const r = await v1('POST', '/checkout/preferences', preferencia());
    expect(r.status).toBe(409);
    expect((await r.json()).error).toBe('gateway_not_configured');
    await app.fechar();

    app = await sobe(new FakeMPClient({}));
    const sem = await v1('POST', '/checkout/preferences', preferencia());
    expect(sem.status).toBe(409);
    expect((await sem.json()).error).toBe('account_not_connected');
    const c = await semear(app);
    await app.repos.accounts.markDisconnected(c.id, 'disconnected', new Date());
    for (const r2 of [
      await v1('POST', '/checkout/preferences', preferencia()),
      await v1('GET', '/checkout/payments/1?account_ref=loja-1'),
      await v1('GET', '/checkout/payments?account_ref=loja-1&reference=x'),
      await v1('POST', '/checkout/payments/1/refund', { account_ref: 'loja-1', idempotency_key: 'idem-12345678' }),
    ]) {
      expect(r2.status).toBe(409);
      expect((await r2.json()).error).toBe('account_not_connected');
    }
  });

  it('400 para expires_at fora da janela, back_url http e itens inválidos', async () => {
    app = await sobe(new FakeMPClient(pref));
    await semear(app);
    for (const extra of [
      { expires_at: em(2) }, { expires_at: em(4 * 24 * 60) }, { expires_at: 'amanha' },
      { back_url: 'http://dittu.com.br/x' }, { items: [] }, { max_installments: 13 }, { shipping_cents: -1 },
      { items: [{ title: 'x', quantity: 0, unit_price_cents: 100 }] },
    ]) {
      const r = await v1('POST', '/checkout/preferences', preferencia(extra));
      expect(r.status, JSON.stringify(extra)).toBe(400);
      expect((await r.json()).error).toBe('validation_error');
    }
  });

  it('201 da preferência, criada com o token da lojista e não com o do hub', async () => {
    const client = new FakeMPClient(pref);
    app = await sobe(client);
    await semear(app);
    const r = await v1('POST', '/checkout/preferences', preferencia());
    expect(r.status).toBe(201);
    expect(await r.json()).toMatchObject({ id: 'pref-1', init_point: 'https://mp/sandbox', ambiente: 'teste' });
    expect(app.tokensUsados).toEqual([TOK]);
    expect(app.tokensUsados).not.toContain(TOKEN_MP);
    const corpo = client.calls[0]!.options!.body as Record<string, any>;
    expect(corpo['notification_url']).toBe(`https://pagamentos.zitosolutions.com.br/webhook/mercadopago-lojas?project_id=${projetoExemplo.id}&account_ref=loja-1`);
  });

  it('back_url http://localhost vale só em teste', async () => {
    app = await sobe(new FakeMPClient(pref));
    await semear(app);
    expect((await v1('POST', '/checkout/preferences', preferencia({ back_url: 'http://localhost:3000/x' }))).status).toBe(201);
    await app.fechar();
    app = await sobe(new FakeMPClient(pref), { configLojas: { ...CONFIG_LOJAS, ambiente: 'producao' } });
    await semear(app);
    expect((await v1('POST', '/checkout/preferences', preferencia({ back_url: 'http://localhost:3000/x' }))).status).toBe(400);
  });

  it('GET por id; query account_ref obrigatória; 404 do MP vira not_found; outros viram 502', async () => {
    const client = new FakeMPClient({
      'GET /v1/payments/900001': fx('aprovado_cartao_3x'),
      'GET /v1/payments/404': new MercadoPagoError(404, 'not_found', 'Payment not found'),
      'GET /v1/payments/500': new MercadoPagoError(500, 'x', 'falhou'),
    });
    app = await sobe(client);
    await semear(app);
    const ok = await v1('GET', '/checkout/payments/900001?account_ref=loja-1');
    expect(ok.status).toBe(200);
    expect(await ok.json()).toMatchObject({ id: '900001', account_ref: 'loja-1', installments: 3 });
    expect((await v1('GET', '/checkout/payments/900001')).status).toBe(400);
    expect((await v1('GET', '/checkout/payments/404?account_ref=loja-1')).status).toBe(404);
    expect((await v1('GET', '/checkout/payments/500?account_ref=loja-1')).status).toBe(502);
  });

  it('GET por referência: mais novo primeiro, só a referência exata, vazio se nenhum', async () => {
    const velho = { ...fx('pix_vencido'), id: 1, date_created: '2026-11-20T09:00:00.000-04:00' };
    const novo = { ...fx('aprovado_cartao_3x'), id: 2, date_created: '2026-11-20T10:00:00.000-04:00' };
    const outro = { ...fx('aprovado_cartao_3x'), id: 3, external_reference: 'pedido-9' };
    const client = new FakeMPClient({ 'GET /v1/payments/search': { results: [velho, outro, novo] } });
    app = await sobe(client);
    await semear(app);
    const r = await (await v1('GET', '/checkout/payments?account_ref=loja-1&reference=pedido-1001')).json();
    expect(r.payments.map((p: { id: string }) => p.id)).toEqual(['2', '1']);
    expect(client.calls[0]!.options!.query).toEqual({ external_reference: 'pedido-1001', sort: 'date_created', criteria: 'desc', limit: '20' });
    expect((await v1('GET', '/checkout/payments?account_ref=loja-1')).status).toBe(400);
    await app.fechar();
    app = await sobe(new FakeMPClient({ 'GET /v1/payments/search': { results: [] } }));
    await semear(app);
    expect(await (await v1('GET', '/checkout/payments?account_ref=loja-1&reference=nada')).json()).toEqual({ payments: [] });
  });

  describe('estorno', () => {
    const corpo = { account_ref: 'loja-1', idempotency_key: 'idem-12345678' };

    it('integral: sem corpo, com X-Idempotency-Key; devolve o pagamento', async () => {
      const client = new FakeMPClient({ 'POST /v1/payments/900001/refunds': {}, 'GET /v1/payments/900001': { ...fx('aprovado_cartao_3x'), status: 'refunded', transaction_amount_refunded: 150 } });
      app = await sobe(client);
      await semear(app);
      const r = await v1('POST', '/checkout/payments/900001/refund', corpo);
      expect(r.status).toBe(200);
      expect(await r.json()).toMatchObject({ status: 'refunded', refunded_cents: 15000 });
      expect(client.calls[0]!.options!.body).toBeUndefined();
      expect(client.calls[0]!.options!.idempotencyKey).toBe('idem-12345678');
    });

    it('parcial: manda amount em reais', async () => {
      const client = new FakeMPClient({ 'POST /v1/payments/900001/refunds': {}, 'GET /v1/payments/900001': fx('reembolso_parcial') });
      app = await sobe(client);
      await semear(app);
      const r = await v1('POST', '/checkout/payments/900001/refund', { ...corpo, amount_cents: 4050 });
      expect(await r.json()).toMatchObject({ status: 'approved', refunded_cents: 4050 });
      expect(client.calls[0]!.options!.body).toEqual({ amount: 40.5 });
    });

    it('422 refund_rejected com a mensagem do MP; 5xx vira 502; chave curta é 400', async () => {
      app = await sobe(new FakeMPClient({ 'POST /v1/payments/1/refunds': new MercadoPagoError(400, 'bad_request', 'Not enough balance to refund') }));
      await semear(app);
      const r = await v1('POST', '/checkout/payments/1/refund', corpo);
      expect(r.status).toBe(422);
      expect(await r.json()).toEqual({ error: 'refund_rejected', message: 'Not enough balance to refund' });
      expect((await v1('POST', '/checkout/payments/1/refund', { ...corpo, idempotency_key: 'curta' })).status).toBe(400);
      expect((await v1('POST', '/checkout/payments/1/refund', { ...corpo, amount_cents: 0 })).status).toBe(400);
      await app.fechar();
      app = await sobe(new FakeMPClient({ 'POST /v1/payments/1/refunds': new MercadoPagoError(500, 'x', 'falhou') }));
      await semear(app);
      expect((await v1('POST', '/checkout/payments/1/refund', corpo)).status).toBe(502);
    });
  });

  it('o log não traz nome, telefone, token nem init_point', async () => {
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});
    app = await sobe(new FakeMPClient(pref));
    await semear(app);
    await v1('POST', '/checkout/preferences', preferencia());
    await new Promise((r) => setTimeout(r, 20));
    const saida = log.mock.calls.map((c) => c.join(' ')).join('\n');
    expect(saida).toContain('[Dittu] [mercadopago_lojas] POST /v1/checkout/preferences 201');
    for (const proibido of ['Maria', '11999990000', TOK, 'https://mp/']) expect(saida).not.toContain(proibido);
  });
});

describe('webhook payment das lojas', () => {
  const chamarAviso = (id: string | number, opts: { query?: string; assinar?: 'ok' | 'ruim' | false; corpo?: unknown } = {}) => {
    const headers: Record<string, string> = { 'content-type': 'application/json' };
    const dataId = String(id);
    if (opts.assinar) {
      headers['x-request-id'] = 'r1';
      headers['x-signature'] = assinarAvisoMP({ segredo: opts.assinar === 'ok' ? CONFIG_LOJAS.webhook_secret : 'outro', dataId, requestId: 'r1' });
    }
    return fetch(`${app.url}/webhook/mercadopago-lojas?project_id=${projetoExemplo.id}${opts.query ?? '&account_ref=loja-1'}`, {
      method: 'POST', headers, body: JSON.stringify(opts.corpo ?? { type: 'payment', data: { id: dataId }, user_id: 998877 }),
    });
  };
  const comPagamento = (raw: unknown) => sobe(new FakeMPClient({ 'GET /v1/payments/1': raw }));

  it.each([
    ['aprovado_cartao_3x', 'order.payment_approved'],
    ['pix_vencido', 'order.payment_expired'],
    ['reembolso_parcial', 'order.payment_refunded'],
    ['em_mediacao', 'order.payment_disputed'],
    ['charged_back', 'order.payment_disputed'],
  ])('%s -> %s, com payment, account e sem token', async (fixture, evento) => {
    app = await comPagamento(fx(fixture));
    await semear(app);
    const r = await chamarAviso(1);
    expect(r.status).toBe(200);
    expect(await r.json()).toMatchObject({ processed: true });
    expect(app.envios).toHaveLength(1);
    const corpo = JSON.parse(app.envios[0]!.body);
    expect(corpo).toMatchObject({
      event: evento, customer_ref: 'pedido-1001', gateway: 'mercadopago',
      data: {
        subscription: null,
        payment: { account_ref: 'loja-1' },
        account: { account_ref: 'loja-1', status: 'connected', mp_user_id: '998877', ambiente: 'teste' },
      },
    });
    const bruto = app.envios[0]!.body;
    for (const proibido of [TOK, REF, 'access_token', 'refresh_token']) expect(bruto).not.toContain(proibido);
    expect(app.tokensUsados).toEqual([TOK]);
  });

  it('reembolso total (refunded) -> order.payment_refunded; pendente, recusado e sem reference -> nenhum evento', async () => {
    app = await comPagamento({ ...fx('aprovado_cartao_3x'), status: 'refunded', transaction_amount_refunded: 150 });
    await semear(app);
    await chamarAviso(1);
    expect(JSON.parse(app.envios[0]!.body).event).toBe('order.payment_refunded');
    await app.fechar();

    for (const raw of [fx('pix_pendente'), { ...fx('aprovado_cartao_3x'), status: 'rejected', status_detail: 'cc_rejected_other_reason' }, { ...fx('aprovado_cartao_3x'), external_reference: null }]) {
      app = await comPagamento(raw);
      await semear(app);
      const r = await chamarAviso(1);
      expect(r.status).toBe(200);
      expect(await r.json()).toMatchObject({ processed: false });
      expect(app.envios).toHaveLength(0);
      expect(app.events).toHaveLength(0);
      await app.fechar();
    }
  });

  it('eventoDoPagamento: reembolso vence disputa; rejected e cancelled sem expirar', () => {
    const base = { reference: 'r', status: 'approved', refunded_cents: 0, disputed: false } as never;
    expect(eventoDoPagamento({ ...(base as object), status: 'approved', refunded_cents: 10, disputed: true } as never)).toBe('order.payment_refunded');
    expect(eventoDoPagamento({ ...(base as object), status: 'cancelled' } as never)).toBe('order.payment_expired');
    expect(eventoDoPagamento({ ...(base as object), status: 'rejected' } as never)).toBeNull();
  });

  it('conta achada pelo account_ref, pelo user_id do corpo e sem conta -> processed:false', async () => {
    app = await comPagamento(fx('aprovado_cartao_3x'));
    await semear(app, 'loja-7', '555');
    expect(await (await chamarAviso(1, { query: '', corpo: { type: 'payment', data: { id: '1' }, user_id: 555 } })).json()).toMatchObject({ processed: true });
    expect(JSON.parse(app.envios[0]!.body).data.account.account_ref).toBe('loja-7');
    const outro = await chamarAviso(1, { query: '&account_ref=nao-existe' });
    expect(await outro.json()).toMatchObject({ processed: false });
    expect(await (await chamarAviso(1, { query: '', corpo: { type: 'payment', data: { id: '1' }, user_id: 1 } })).json()).toMatchObject({ processed: false });
    expect(app.envios).toHaveLength(1);
  });

  it('conta desconectada -> processed:false, sem consultar o MP', async () => {
    const client = new FakeMPClient({});
    app = await sobe(client);
    const c = await semear(app);
    await app.repos.accounts.markDisconnected(c.id, 'disconnected', new Date());
    const r = await chamarAviso(1);
    expect(r.status).toBe(200);
    expect(client.calls).toHaveLength(0);
  });

  it('funciona sem assinatura e com assinatura certa; assinatura ruim -> 401 sem consultar o MP', async () => {
    const client = new FakeMPClient({ 'GET /v1/payments/1': fx('aprovado_cartao_3x') });
    app = await sobe(client);
    await semear(app);
    expect((await chamarAviso(1, { assinar: 'ruim' })).status).toBe(401);
    expect(client.calls).toHaveLength(0);
    expect((await chamarAviso(1, { assinar: 'ok' })).status).toBe(200);
    expect(app.envios).toHaveLength(1);
  });

  it('o corpo do aviso não manda: o evento sai do que o MP devolve', async () => {
    app = await comPagamento(fx('pix_vencido'));
    await semear(app);
    await chamarAviso(1, { corpo: { type: 'payment', data: { id: '1' }, status: 'approved' } });
    expect(JSON.parse(app.envios[0]!.body).event).toBe('order.payment_expired');
  });

  it('repetido não reentrega; mudança de estado gera outro evento', async () => {
    let estado: unknown = fx('aprovado_cartao_3x');
    const client = new FakeMPClient({ 'GET /v1/payments/1': () => estado });
    app = await sobe(client);
    await semear(app);
    await chamarAviso(1);
    const dup = await chamarAviso(1);
    expect(await dup.json()).toMatchObject({ processed: false, reason: 'duplicate' });
    expect(app.envios).toHaveLength(1);
    estado = fx('reembolso_parcial');
    await chamarAviso(1);
    expect(app.envios).toHaveLength(2);
    expect(app.events.map((e) => e.gateway_event_id)).toEqual([
      'mp-lojas:payment:900001:approved:0:false',
      'mp-lojas:payment:900004:approved:4050:false',
    ]);
  });

  it('evento gravado sem entrega cria a entrega no aviso repetido', async () => {
    app = await comPagamento(fx('aprovado_cartao_3x'));
    await semear(app);
    await chamarAviso(1);
    app.deliveries.length = 0;
    const r = await chamarAviso(1);
    expect(await r.json()).toMatchObject({ reason: 'duplicate' });
    expect(app.deliveries).toHaveLength(1);
    expect(app.envios).toHaveLength(2);
  });

  it('404 do MP -> 200 processed:false; outros erros -> 500 sem vazar o token', async () => {
    const err = vi.spyOn(console, 'error').mockImplementation(() => {});
    app = await sobe(new FakeMPClient({ 'GET /v1/payments/1': new MercadoPagoError(404, 'not_found', 'nada') }));
    await semear(app);
    expect(await (await chamarAviso(1)).json()).toMatchObject({ processed: false });
    await app.fechar();
    app = await sobe(new FakeMPClient({ 'GET /v1/payments/1': new MercadoPagoError(500, 'x', 'falhou') }));
    await semear(app);
    const r = await chamarAviso(1);
    expect(r.status).toBe(500);
    expect(JSON.stringify(err.mock.calls) + (await r.text())).not.toContain(TOK);
  });

  it('tópico mp-connect continua como na TASK-396', async () => {
    app = await comPagamento(fx('aprovado_cartao_3x'));
    await semear(app);
    const r = await chamarAviso(998877, { corpo: { type: 'mp-connect', action: 'outra', user_id: 998877, data: { id: '998877' } } });
    expect(await r.json()).toMatchObject({ processed: false });
  });
});
