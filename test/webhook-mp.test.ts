import fs from 'node:fs';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { MercadoPagoError } from '../src/gateways/mercadopago/mercadopago.client';
import { MercadoPagoGateway } from '../src/gateways/mercadopago/mercadopago.gateway';
import { AvisoInvalidoError, tratarAvisoMP } from '../src/gateways/mercadopago/webhook';
import { assinarAvisoMP } from './helpers/assinaturaMP';
import { FakeMPClient, projetoExemplo } from './helpers/fakes';
import { SEGREDO_MP, subirApp, TOKEN_MP } from './helpers/app';

const fx = (n: string) => JSON.parse(fs.readFileSync(path.join(__dirname, 'fixtures/mercadopago', n), 'utf-8'));
const preapproval = fx('preapproval_authorized.json');
const pagamentoAssinatura = fx('payment_assinatura_aprovado.json');
const cobranca = fx('authorized_payment_processed.json');
const PID = String(pagamentoAssinatura.id);
const SID = preapproval.id as string;

const pix = (status: string, detail = 'x') => ({
  id: 555, status, status_detail: detail, external_reference: 'loja-1', transaction_amount: 29.9, payment_method_id: 'pix',
  payment_type_id: 'bank_transfer', date_of_expiration: '2026-11-20T10:30:00.000-03:00',
  point_of_interaction: { transaction_data: { qr_code: 'qr', qr_code_base64: 'b64' } },
});

function aviso(topico: string, dataId: string, query = true) {
  const requestId = 'req-1';
  const raw = Buffer.from(JSON.stringify({ type: topico, data: { id: dataId } }));
  return {
    rawBody: raw,
    headers: { 'x-signature': assinarAvisoMP({ segredo: SEGREDO_MP, dataId, requestId }), 'x-request-id': requestId },
    query: query ? { 'data.id': dataId, type: topico } : {},
  };
}

function gw(routes: Record<string, unknown>) {
  const client = new FakeMPClient(routes);
  const g = new MercadoPagoGateway({ access_token: TOKEN_MP, webhook_secret: SEGREDO_MP, ambiente: 'teste' }, client);
  return { g, client, tratar: (i: ReturnType<typeof aviso>) => tratarAvisoMP(i, { gateway: g, segredo: SEGREDO_MP }) };
}

describe('tratarAvisoMP (tabela de eventos)', () => {
  it('assinatura inválida lança AvisoInvalidoError antes de consultar o MP', async () => {
    const { tratar, client } = gw({});
    const i = aviso('payment', '1');
    await expect(tratar({ ...i, headers: { ...i.headers, 'x-signature': 'ts=1,v1=00' } })).rejects.toBeInstanceOf(AvisoInvalidoError);
    expect(client.calls).toHaveLength(0);
  });

  it('o project_id da query não entra na validação da assinatura', async () => {
    const { tratar } = gw({ [`GET /preapproval/${SID}`]: preapproval, });
    const i = aviso('subscription_preapproval', SID);
    const r = await tratar({ ...i, query: { ...i.query, project_id: 'qualquer-coisa' } });
    expect(r?.event).toBe('subscription.activated');
  });

  it('lê tópico e id do corpo quando a query não traz', async () => {
    const { tratar } = gw({ [`GET /preapproval/${SID}`]: preapproval, [`GET /preapproval/${SID}`]: preapproval });
    const r = await tratar(aviso('subscription_preapproval', SID, false));
    expect(r?.event).toBe('subscription.activated');
  });

  it('preapproval authorized -> subscription.activated', async () => {
    const { tratar } = gw({ [`GET /preapproval/${SID}`]: preapproval });
    const r = await tratar(aviso('subscription_preapproval', SID));
    expect(r).toMatchObject({
      event: 'subscription.activated', customer_ref: preapproval.external_reference,
      gateway_event_id: `mp:preapproval:${SID}:authorized:${preapproval.last_modified}`,
    });
    expect(r?.data?.subscription?.status).toBe('authorized');
  });

  it('preapproval cancelled (ou canceled) -> subscription.cancelled; pending -> nada', async () => {
    for (const status of ['cancelled', 'canceled']) {
      const { tratar } = gw({ [`GET /preapproval/${SID}`]: { ...preapproval, status } });
      const r = await tratar(aviso('subscription_preapproval', SID));
      expect(r?.event).toBe('subscription.cancelled');
      expect(r?.data?.subscription?.status).toBe('cancelled');
    }
    const { tratar } = gw({ [`GET /preapproval/${SID}`]: { ...preapproval, status: 'pending' } });
    expect(await tratar(aviso('subscription_preapproval', SID))).toBeNull();
  });

  const rotasCobranca = (pagamento: object) => ({
    [`GET /authorized_payments/${cobranca.id}`]: cobranca,
    [`GET /v1/payments/${PID}`]: pagamento,
    [`GET /preapproval/${SID}`]: preapproval,
  });

  it('cobrança de assinatura com pagamento approved -> subscription.payment_approved', async () => {
    const { tratar } = gw(rotasCobranca(pagamentoAssinatura));
    const r = await tratar(aviso('subscription_authorized_payment', String(cobranca.id)));
    expect(r).toMatchObject({
      event: 'subscription.payment_approved', customer_ref: preapproval.external_reference,
      gateway_event_id: `mp:authorized_payment:${cobranca.id}:approved`,
    });
    expect(r?.data?.payment).toMatchObject({ status: 'approved', subscription_id: SID });
    expect(r?.data?.subscription?.id).toBe(SID);
  });

  it('cobrança com pagamento rejected -> subscription.payment_failed; pending -> nada', async () => {
    const { tratar } = gw(rotasCobranca({ ...pagamentoAssinatura, status: 'rejected', status_detail: 'cc_rejected_other_reason' }));
    const r = await tratar(aviso('subscription_authorized_payment', String(cobranca.id)));
    expect(r?.event).toBe('subscription.payment_failed');
    expect(r?.gateway_event_id).toBe(`mp:authorized_payment:${cobranca.id}:rejected`);

    const g2 = gw(rotasCobranca({ ...pagamentoAssinatura, status: 'in_process' }));
    expect(await g2.tratar(aviso('subscription_authorized_payment', String(cobranca.id)))).toBeNull();
  });

  it('cobrança sem pagamento ainda -> nada', async () => {
    const { tratar } = gw({ [`GET /authorized_payments/${cobranca.id}`]: { ...cobranca, payment: null } });
    expect(await tratar(aviso('subscription_authorized_payment', String(cobranca.id)))).toBeNull();
  });

  it('payment de assinatura: só refunded/charged_back geram evento', async () => {
    const aprovado = gw({ [`GET /v1/payments/${PID}`]: pagamentoAssinatura });
    expect(await aprovado.tratar(aviso('payment', PID))).toBeNull();

    for (const status of ['refunded', 'charged_back']) {
      const { tratar } = gw({ [`GET /v1/payments/${PID}`]: { ...pagamentoAssinatura, status } });
      const r = await tratar(aviso('payment', PID));
      expect(r).toMatchObject({ event: 'payment.refunded', gateway_event_id: `mp:payment:${PID}:${status}` });
    }
  });

  it('payment avulso (Pix): approved, expired, refunded; pendente -> nada', async () => {
    const casos: Array<[object, string | null, string]> = [
      [pix('approved'), 'payment.approved', 'mp:payment:555:approved'],
      [pix('cancelled', 'expired'), 'payment.expired', 'mp:payment:555:expired'],
      [pix('refunded'), 'payment.refunded', 'mp:payment:555:refunded'],
      [pix('charged_back'), 'payment.refunded', 'mp:payment:555:charged_back'],
      [pix('pending'), null, ''],
      [pix('rejected'), null, ''],
    ];
    for (const [pagamento, evento, geid] of casos) {
      const { tratar } = gw({ 'GET /v1/payments/555': pagamento });
      const r = await tratar(aviso('payment', '555'));
      if (evento) {
        expect(r).toMatchObject({ event: evento, customer_ref: 'loja-1', gateway_event_id: geid });
        expect(r?.data?.payment?.id).toBe('555');
      } else {
        expect(r).toBeNull();
      }
    }
  });

  it('sem external_reference não gera evento', async () => {
    const { tratar } = gw({ 'GET /v1/payments/555': { ...pix('approved'), external_reference: null } });
    expect(await tratar(aviso('payment', '555'))).toBeNull();
  });

  it('tópico desconhecido -> nada; recurso inexistente (404) -> nada; outros erros do MP sobem', async () => {
    expect(await gw({}).tratar(aviso('merchant_order', '1'))).toBeNull();
    expect(await gw({ 'GET /v1/payments/9': new MercadoPagoError(404, 'not_found', 'Payment not found') }).tratar(aviso('payment', '9'))).toBeNull();
    await expect(
      gw({ 'GET /v1/payments/9': new MercadoPagoError(500, 'x', 'caiu') }).tratar(aviso('payment', '9'))
    ).rejects.toBeInstanceOf(MercadoPagoError);
  });
});

describe('POST /webhook/:gateway', () => {
  let app: Awaited<ReturnType<typeof subirApp>> | undefined;
  afterEach(async () => { await app?.fechar(); vi.restoreAllMocks(); });

  const enviar = async (a: NonNullable<typeof app>, i: ReturnType<typeof aviso>, projeto: string | null = projetoExemplo.id) => {
    const q = new URLSearchParams({ ...i.query, ...(projeto ? { project_id: projeto } : {}) });
    return fetch(`${a.url}/webhook/mercadopago?${q}`, { method: 'POST', headers: { 'content-type': 'application/json', ...i.headers }, body: i.rawBody });
  };

  it('401 com assinatura ruim', async () => {
    app = await subirApp(new FakeMPClient({}));
    const i = aviso('payment', '555');
    const r = await enviar(app, { ...i, headers: { ...i.headers, 'x-signature': 'ts=1,v1=aa' } });
    expect(r.status).toBe(401);
    expect(app.events).toHaveLength(0);
  });

  it('200, grava o evento e entrega o callback; repetido -> 200 sem novo callback', async () => {
    app = await subirApp(new FakeMPClient({ 'GET /v1/payments/555': pix('approved') }));
    const i = aviso('payment', '555');
    const r1 = await enviar(app, i);
    expect(r1.status).toBe(200);
    expect(await r1.json()).toEqual({ received: true, processed: true });
    expect(app.events).toHaveLength(1);
    expect(app.envios).toHaveLength(1);
    expect(app.envios[0]!.headers['X-Zito-Event-Id']).toBe(app.events[0]!.id);
    expect(JSON.parse(app.envios[0]!.body).event).toBe('payment.approved');

    const r2 = await enviar(app, i);
    expect(r2.status).toBe(200);
    expect((await r2.json()).reason).toBe('duplicate');
    expect(app.envios).toHaveLength(1);
    expect(app.events).toHaveLength(1);
  });

  it('500 quando o MP falha (para ele tentar de novo) e sem vazar o token', async () => {
    app = await subirApp(new FakeMPClient({ 'GET /v1/payments/555': new MercadoPagoError(502, 'x', 'gateway fora') }));
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const r = await enviar(app, aviso('payment', '555'));
    expect(r.status).toBe(500);
    expect(JSON.stringify(await r.json()) + JSON.stringify(spy.mock.calls)).not.toContain(TOKEN_MP);
    expect(app.events).toHaveLength(0);
  });

  it('200 processed:false quando o aviso não vira evento', async () => {
    app = await subirApp(new FakeMPClient({ 'GET /v1/payments/555': pix('pending') }));
    const r = await enviar(app, aviso('payment', '555'));
    expect(await r.json()).toEqual({ received: true, processed: false });
  });

  it('400 sem project_id, 404 com projeto desconhecido, 404 sem config do MP', async () => {
    app = await subirApp(new FakeMPClient({}), { comConfigMP: false });
    expect((await enviar(app, aviso('payment', '1'), null)).status).toBe(400);
    expect((await enviar(app, aviso('payment', '1'), '99999999-9999-4999-8999-999999999999')).status).toBe(404);
    expect((await enviar(app, aviso('payment', '1'))).status).toBe(404);
  });

  it('Stripe: continua chamando constructEvent com a stripe-signature e responde 400 se falhar', async () => {
    app = await subirApp(new FakeMPClient({}));
    app.stripe.webhooks.constructEvent.mockReturnValue({
      id: 'evt_1', type: 'checkout.session.completed', data: { object: { metadata: { customer_ref: '5511999' } } },
    });
    const corpo = JSON.stringify({ id: 'evt_1' });
    const r = await fetch(`${app.url}/webhook/stripe?project_id=${projetoExemplo.id}`, {
      method: 'POST', headers: { 'content-type': 'application/json', 'stripe-signature': 't=1,v1=abc' }, body: corpo,
    });
    expect(r.status).toBe(200);
    expect(app.stripe.webhooks.constructEvent).toHaveBeenCalledTimes(1);
    const [raw, sig, secret] = app.stripe.webhooks.constructEvent.mock.calls[0]!;
    expect(Buffer.isBuffer(raw) && raw.toString()).toBe(corpo);
    expect([sig, secret]).toEqual(['t=1,v1=abc', 'whsec']);
    expect(app.events[0]).toMatchObject({ event_type: 'subscription.activated', customer_ref: '5511999', gateway: 'stripe' });
    expect(JSON.parse(app.envios[0]!.body)).toMatchObject({ event: 'subscription.activated', customer_ref: '5511999', gateway: 'stripe', project_id: projetoExemplo.id });

    app.stripe.webhooks.constructEvent.mockImplementation(() => { throw new Error('bad sig'); });
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const ruim = await fetch(`${app.url}/webhook/stripe?project_id=${projetoExemplo.id}`, {
      method: 'POST', headers: { 'content-type': 'application/json', 'stripe-signature': 'x' }, body: corpo,
    });
    expect(ruim.status).toBe(400);
  });
});
