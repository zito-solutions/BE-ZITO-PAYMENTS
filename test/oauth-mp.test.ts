import { describe, expect, it, vi } from 'vitest';
import { criarOAuthGateway, montarLinkDeAutorizacao } from '../src/gateways/mercadopago/oauth';
import { MercadoPagoError } from '../src/gateways/mercadopago/mercadopago.client';

const cfg = { client_id: '123', client_secret: 'segredo-do-app', redirect_uri: 'https://hub.exemplo/oauth/mercadopago/retorno' };
const resp = (status: number, corpo: unknown) => new Response(JSON.stringify(corpo), { status });

describe('montarLinkDeAutorizacao', () => {
  it('põe os parâmetros certos, com state e redirect_uri codificados', () => {
    const u = new URL(montarLinkDeAutorizacao({ client_id: '123', redirect_uri: cfg.redirect_uri, state: 'a b&c' }));
    expect(u.origin + u.pathname).toBe('https://auth.mercadopago.com.br/authorization');
    expect(Object.fromEntries(u.searchParams)).toEqual({
      client_id: '123', response_type: 'code', platform_id: 'mp', state: 'a b&c', redirect_uri: cfg.redirect_uri,
    });
    expect(u.search).toContain('redirect_uri=https%3A%2F%2Fhub.exemplo');
  });
});

describe('oauth/token', () => {
  const tokens = { access_token: 'APP_USR-novo', refresh_token: 'TG-novo', public_key: 'APP_USR-pk', user_id: 998877, expires_in: 15552000 };

  it('trocarCodigo envia o corpo certo e converte a resposta', async () => {
    const f = vi.fn(async () => resp(200, tokens));
    const r = await criarOAuthGateway(f as never).trocarCodigo(cfg, 'TG-code');
    const [url, init] = f.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe('https://api.mercadopago.com/oauth/token');
    expect(init.method).toBe('POST');
    expect(JSON.parse(init.body as string)).toEqual({
      client_id: '123', client_secret: 'segredo-do-app', grant_type: 'authorization_code', code: 'TG-code', redirect_uri: cfg.redirect_uri,
    });
    expect(r).toEqual(tokens);
  });

  it('renovarToken usa refresh_token', async () => {
    const f = vi.fn(async () => resp(200, tokens));
    await criarOAuthGateway(f as never).renovarToken(cfg, 'TG-velho');
    const init = (f.mock.calls[0] as unknown as [string, RequestInit])[1];
    expect(JSON.parse(init.body as string)).toEqual({
      client_id: '123', client_secret: 'segredo-do-app', grant_type: 'refresh_token', refresh_token: 'TG-velho',
    });
  });

  it('erro do MP não leva segredo nem corpo na mensagem', async () => {
    const f = vi.fn(async () => resp(400, { error: 'invalid_grant', message: 'code TG-code segredo-do-app' }));
    const err = await criarOAuthGateway(f as never).trocarCodigo(cfg, 'TG-code').catch((e) => e);
    expect(err).toBeInstanceOf(MercadoPagoError);
    expect(err).toMatchObject({ status: 400, code: 'invalid_grant' });
    expect(String(err.message)).not.toMatch(/segredo-do-app|TG-code/);
  });

  it('falha de rede vira MercadoPagoError 504 sem segredo', async () => {
    const f = vi.fn(async () => { throw new Error('boom segredo-do-app'); });
    const err = await criarOAuthGateway(f as never).trocarCodigo(cfg, 'x').catch((e) => e);
    expect(err).toMatchObject({ status: 504, code: 'network_error' });
    expect(err.message).not.toContain('segredo-do-app');
  });

  it('resposta sem token é erro', async () => {
    const f = vi.fn(async () => resp(200, {}));
    await expect(criarOAuthGateway(f as never).trocarCodigo(cfg, 'x')).rejects.toMatchObject({ status: 502 });
  });
});

describe('contaAindaValida', () => {
  const com = (s: number) => criarOAuthGateway((async () => resp(s, {})) as never).contaAindaValida('APP_USR-t');
  it('200 true; 401 e 403 false; 500 lança', async () => {
    expect(await com(200)).toBe(true);
    expect(await com(401)).toBe(false);
    expect(await com(403)).toBe(false);
    await expect(com(500)).rejects.toBeInstanceOf(MercadoPagoError);
  });

  it('chama /users/me com o token da conta', async () => {
    const f = vi.fn(async () => resp(200, {}));
    await criarOAuthGateway(f as never).contaAindaValida('APP_USR-t');
    const [url, init] = f.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe('https://api.mercadopago.com/users/me');
    expect((init.headers as Record<string, string>)['Authorization']).toBe('Bearer APP_USR-t');
  });
});
