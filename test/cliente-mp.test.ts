import { describe, expect, it } from 'vitest';
import { MercadoPagoClient, MercadoPagoError } from '../src/gateways/mercadopago/mercadopago.client';

const TOKEN = 'APP_USR-segredo-que-nao-pode-vazar';

describe('MercadoPagoClient', () => {
  it('manda Bearer, idempotência, query e corpo JSON', async () => {
    let visto: { url: string; init: RequestInit } | undefined;
    const c = new MercadoPagoClient(TOKEN, async (url, init) => {
      visto = { url, init };
      return new Response(JSON.stringify({ ok: true }), { status: 201 });
    });
    const r = await c.request('POST', '/v1/payments', { body: { a: 1 }, query: { x: '1', y: undefined }, idempotencyKey: 'k1' });
    expect(r).toEqual({ ok: true });
    expect(visto!.url).toBe('https://api.mercadopago.com/v1/payments?x=1');
    const h = visto!.init.headers as Record<string, string>;
    expect(h['Authorization']).toBe(`Bearer ${TOKEN}`);
    expect(h['X-Idempotency-Key']).toBe('k1');
    expect(visto!.init.body).toBe('{"a":1}');
  });

  it('erro do MP vira MercadoPagoError com a mensagem do MP, sem token nem corpo da requisição', async () => {
    const c = new MercadoPagoClient(TOKEN, async () => new Response(JSON.stringify({ message: 'payer_email is required', error: 'bad_request' }), { status: 400 }));
    const e = await c.request('POST', '/preapproval', { body: { card_token_id: 'cartao-secreto' } }).catch((x) => x);
    expect(e).toBeInstanceOf(MercadoPagoError);
    expect(e).toMatchObject({ status: 400, code: 'bad_request', message: 'payer_email is required' });
    expect(JSON.stringify([e.message, e.stack])).not.toContain(TOKEN);
    expect(JSON.stringify([e.message, e.stack])).not.toContain('cartao-secreto');
  });

  it('falha de rede e timeout viram 504 sem detalhes', async () => {
    const rede = new MercadoPagoClient(TOKEN, async () => { throw new Error(`falhou com ${TOKEN}`); });
    const e1 = await rede.request('GET', '/x').catch((x) => x);
    expect(e1).toMatchObject({ status: 504, code: 'network_error' });
    expect(e1.message).not.toContain(TOKEN);

    const t = Object.assign(new Error('t'), { name: 'TimeoutError' });
    const e2 = await new MercadoPagoClient(TOKEN, async () => { throw t; }).request('GET', '/x').catch((x) => x);
    expect(e2.code).toBe('timeout');
  });
});
