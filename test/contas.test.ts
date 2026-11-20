import { afterEach, describe, expect, it, vi } from 'vitest';
import { MercadoPagoError } from '../src/gateways/mercadopago/mercadopago.client';
import { renovarContas } from '../src/contas/renovar';
import { assinarAvisoMP } from './helpers/assinaturaMP';
import { FakeMPClient, projetoExemplo } from './helpers/fakes';
import { CONFIG_LOJAS, oauthFalso, subirApp } from './helpers/app';

type App = Awaited<ReturnType<typeof subirApp>>;
let app: App;
afterEach(async () => { await app?.fechar(); vi.restoreAllMocks(); });

const TOK = 'APP_USR-token-da-lojista';
const REF = 'APP_USR-refresh-da-lojista';
const tokens = { access_token: 'APP_USR-novo-acesso', refresh_token: 'TG-novo-refresh', public_key: 'APP_USR-pk', user_id: 998877, expires_in: 15552000 };

const sobe = (opts: Parameters<typeof subirApp>[1] = {}) => subirApp(new FakeMPClient({}), opts);
const v1 = (metodo: string, rota: string, corpo?: unknown, chave: string | null = projetoExemplo.api_key) =>
  fetch(`${app.url}/v1${rota}`, {
    method: metodo,
    headers: { 'content-type': 'application/json', ...(chave ? { 'x-api-key': chave } : {}) },
    body: corpo === undefined ? undefined : JSON.stringify(corpo),
  });

async function semear(a: App, extra: Partial<{ ref: string; expira: Date; mp: string }> = {}) {
  return a.repos.accounts.upsertConnected({
    project_id: projetoExemplo.id, account_ref: extra.ref ?? 'loja-1', mp_user_id: extra.mp ?? '998877',
    access_token: TOK, refresh_token: REF, public_key: 'pk', expires_at: (extra.expira ?? new Date(Date.now() + 100 * 86400_000)).toISOString(),
    connected_at: new Date().toISOString(),
  });
}

describe('POST /v1/accounts/connect', () => {
  const corpo = { account_ref: 'loja-1', return_url: 'https://dittu.com.br/painel/pagamentos' };

  it('401 sem chave', async () => {
    app = await sobe();
    expect((await v1('POST', '/accounts/connect', corpo, null)).status).toBe(401);
  });

  it('409 sem config das lojas', async () => {
    app = await sobe({ configLojas: null });
    const r = await v1('POST', '/accounts/connect', corpo);
    expect(r.status).toBe(409);
    expect((await r.json()).error).toBe('gateway_not_configured');
  });

  it('400 com return_url http fora do ambiente de teste, e http em localhost só em teste', async () => {
    app = await sobe({ configLojas: { ...CONFIG_LOJAS, ambiente: 'producao' } });
    expect((await v1('POST', '/accounts/connect', { ...corpo, return_url: 'http://localhost:3000/x' })).status).toBe(400);
    await app.fechar();
    app = await sobe();
    expect((await v1('POST', '/accounts/connect', { ...corpo, return_url: 'http://localhost:3000/x' })).status).toBe(201);
    expect((await v1('POST', '/accounts/connect', { ...corpo, return_url: 'http://dittu.com.br/x' })).status).toBe(400);
    expect((await v1('POST', '/accounts/connect', { account_ref: '', return_url: 'https://x.com' })).status).toBe(400);
  });

  it('201 com o link, state gravado e validade de 10 minutos', async () => {
    app = await sobe();
    const r = await v1('POST', '/accounts/connect', corpo);
    expect(r.status).toBe(201);
    const j = await r.json();
    const u = new URL(j.authorize_url);
    const state = u.searchParams.get('state')!;
    expect(state).toMatch(/^[0-9a-f]{64}$/);
    expect(u.searchParams.get('client_id')).toBe(CONFIG_LOJAS.client_id);
    expect(u.searchParams.get('redirect_uri')).toBe(CONFIG_LOJAS.redirect_uri);
    expect(app.states).toHaveLength(1);
    expect(app.states[0]).toMatchObject({ state, project_id: projetoExemplo.id, account_ref: 'loja-1', return_url: corpo.return_url });
    const dif = new Date(j.expires_at).getTime() - Date.now();
    expect(dif).toBeGreaterThan(9 * 60_000);
    expect(dif).toBeLessThanOrEqual(10 * 60_000);
  });
});

describe('GET e DELETE /v1/accounts/:ref', () => {
  it('GET 404 se nunca conectou; 200 sem token', async () => {
    app = await sobe();
    expect((await v1('GET', '/accounts/loja-1')).status).toBe(404);
    await semear(app);
    const r = await v1('GET', '/accounts/loja-1');
    expect(r.status).toBe(200);
    const txt = await r.text();
    expect(txt).not.toMatch(/access_token|refresh_token|public_key|APP_USR/);
    expect(JSON.parse(txt)).toMatchObject({ account_ref: 'loja-1', status: 'connected', mp_user_id: '998877', ambiente: 'teste' });
  });

  it('DELETE apaga os tokens, é idempotente e não manda callback; 404 se nunca existiu', async () => {
    app = await sobe();
    expect((await v1('DELETE', '/accounts/loja-1')).status).toBe(404);
    await semear(app);
    for (let i = 0; i < 2; i++) {
      const r = await v1('DELETE', '/accounts/loja-1');
      expect(r.status).toBe(200);
      expect((await r.json()).status).toBe('disconnected');
    }
    expect(app.accounts[0]).toMatchObject({ status: 'disconnected', access_token: null, refresh_token: null });
    expect(app.envios).toHaveLength(0);
  });
});

describe('GET /oauth/mercadopago/retorno', () => {
  const retorno = (q: Record<string, string>) =>
    fetch(`${app.url}/oauth/mercadopago/retorno?${new URLSearchParams(q)}`, { redirect: 'manual' });
  const novoState = async (a: App, p: Partial<{ expira: Date; url: string }> = {}) => {
    await a.repos.oauthStates.create({
      state: 'st-' + Math.random().toString(16).slice(2), project_id: projetoExemplo.id, account_ref: 'loja-1',
      return_url: p.url ?? 'https://dittu.com.br/painel/pagamentos?aba=mp', expires_at: (p.expira ?? new Date(Date.now() + 600_000)).toISOString(),
    });
    return a.states[a.states.length - 1]!.state;
  };

  it('state ausente ou desconhecido: 400 com a página', async () => {
    app = await sobe();
    for (const q of [{}, { state: 'nao-existe', code: 'x' }]) {
      const r = await retorno(q);
      expect(r.status).toBe(400);
      expect(await r.text()).toContain('Este link de conexão não vale mais. Volte ao painel e tente de novo.');
    }
  });

  it('state de uso único: a segunda volta é 400', async () => {
    app = await sobe({ oauth: oauthFalso({ trocarCodigo: async () => tokens }) });
    const s = await novoState(app);
    expect((await retorno({ state: s, code: 'c' })).status).toBe(303);
    expect((await retorno({ state: s, code: 'c' })).status).toBe(400);
  });

  it('state vencido: motivo=expirado', async () => {
    app = await sobe();
    const s = await novoState(app, { expira: new Date(Date.now() - 1000) });
    const r = await retorno({ state: s, code: 'c' });
    expect(r.status).toBe(303);
    expect(new URL(r.headers.get('location')!).searchParams.get('motivo')).toBe('expirado');
    expect(new URL(r.headers.get('location')!).searchParams.get('mp')).toBe('erro');
  });

  it('negado (error=access_denied ou sem code): motivo=negado', async () => {
    app = await sobe();
    const s = await novoState(app);
    const r = await retorno({ state: s, error: 'access_denied' });
    expect(new URL(r.headers.get('location')!).searchParams.get('motivo')).toBe('negado');
    const s2 = await novoState(app);
    expect(new URL((await retorno({ state: s2 })).headers.get('location')!).searchParams.get('motivo')).toBe('negado');
  });

  it('troca falhou: motivo=falha, sem corpo nem segredo no log, nada gravado', async () => {
    const log = vi.spyOn(console, 'error').mockImplementation(() => {});
    app = await sobe({ oauth: oauthFalso({ trocarCodigo: async () => { throw new MercadoPagoError(400, 'invalid_grant', 'HTTP 400'); } }) });
    const s = await novoState(app);
    const r = await retorno({ state: s, code: 'CODIGO-SECRETO' });
    expect(new URL(r.headers.get('location')!).searchParams.get('motivo')).toBe('falha');
    expect(app.accounts).toHaveLength(0);
    const saida = log.mock.calls.flat().join(' ');
    expect(saida).toContain('oauth falhou: 400 invalid_grant');
    expect(saida).not.toMatch(/CODIGO-SECRETO|client-secret/);
  });

  it('sem config das lojas: motivo=falha', async () => {
    app = await sobe({ configLojas: null });
    const s = await novoState(app);
    expect(new URL((await retorno({ state: s, code: 'c' })).headers.get('location')!).searchParams.get('motivo')).toBe('falha');
  });

  it('sucesso: conta conectada, evento, callback sem token e redirect preservando a query', async () => {
    const trocar = vi.fn(async () => tokens);
    app = await sobe({ oauth: oauthFalso({ trocarCodigo: trocar }) });
    const s = await novoState(app);
    const r = await retorno({ state: s, code: 'c1' });
    expect(r.status).toBe(303);
    const loc = new URL(r.headers.get('location')!);
    expect(loc.origin + loc.pathname).toBe('https://dittu.com.br/painel/pagamentos');
    expect(Object.fromEntries(loc.searchParams)).toEqual({ aba: 'mp', mp: 'conectado' });
    expect(r.headers.get('location')).not.toMatch(/APP_USR|TG-/);
    expect(trocar).toHaveBeenCalledWith(expect.objectContaining({ client_id: CONFIG_LOJAS.client_id }), 'c1');

    expect(app.accounts[0]).toMatchObject({ account_ref: 'loja-1', status: 'connected', mp_user_id: '998877', access_token: tokens.access_token });
    expect(app.events).toHaveLength(1);
    expect(app.events[0]).toMatchObject({ event_type: 'account.connected', customer_ref: 'loja-1', gateway: 'mercadopago' });
    expect(app.events[0]!.gateway_event_id).toMatch(/^mp-lojas:account:loja-1:connected:\d+$/);

    expect(app.envios).toHaveLength(1);
    const corpo = JSON.parse(app.envios[0]!.body);
    expect(corpo).toMatchObject({ event: 'account.connected', customer_ref: 'loja-1', gateway: 'mercadopago' });
    expect(corpo.data.account).toMatchObject({ account_ref: 'loja-1', status: 'connected', mp_user_id: '998877', ambiente: 'teste' });
    expect(corpo.data.subscription).toBeNull();
    expect(app.envios[0]!.body).not.toMatch(/APP_USR|TG-novo|access_token|refresh_token/);
  });
});

describe('webhook mp-connect', () => {
  const aviso = (corpo: unknown, opts: { assinar?: 'ok' | 'ruim' | false; query?: string } = {}) => {
    const headers: Record<string, string> = { 'content-type': 'application/json' };
    const dataId = '998877';
    if (opts.assinar === 'ok') {
      headers['x-request-id'] = 'r1';
      headers['x-signature'] = assinarAvisoMP({ segredo: CONFIG_LOJAS.webhook_secret, dataId, requestId: 'r1' });
    } else if (opts.assinar === 'ruim') {
      headers['x-request-id'] = 'r1';
      headers['x-signature'] = assinarAvisoMP({ segredo: 'outro', dataId, requestId: 'r1' });
    }
    return fetch(`${app.url}/webhook/mercadopago-lojas?project_id=${projetoExemplo.id}${opts.query ?? ''}`, {
      method: 'POST', headers, body: JSON.stringify(corpo),
    });
  };
  const desautorizou = { type: 'mp-connect', action: 'application.deauthorized', user_id: 998877, data: { id: '998877' } };

  it('assinatura ruim: 401; sem project_id: 400; projeto sem config: 404', async () => {
    app = await sobe();
    await semear(app);
    expect((await aviso(desautorizou, { assinar: 'ruim' })).status).toBe(401);
    expect((await fetch(`${app.url}/webhook/mercadopago-lojas`, { method: 'POST', body: '{}' })).status).toBe(400);
    await app.fechar();
    app = await sobe({ configLojas: null });
    expect((await aviso(desautorizou)).status).toBe(404);
  });

  it('sem assinatura e a conta ainda valida: nada muda', async () => {
    app = await sobe({ oauth: oauthFalso({ contaAindaValida: async () => true }) });
    await semear(app);
    const r = await aviso(desautorizou);
    expect(r.status).toBe(200);
    expect(app.accounts[0]!.status).toBe('connected');
    expect(app.events).toHaveLength(0);
  });

  it('conta invalida no MP: disconnected, tokens apagados e callback account.disconnected', async () => {
    const valida = vi.fn(async (t: string) => { expect(t).toBe(TOK); return false; });
    app = await sobe({ oauth: oauthFalso({ contaAindaValida: valida }) });
    await semear(app);
    await semear(app, { ref: 'outra', mp: '111' });
    const r = await aviso(desautorizou, { assinar: 'ok' });
    expect(r.status).toBe(200);
    expect(app.accounts.find((a) => a.account_ref === 'loja-1')).toMatchObject({ status: 'disconnected', access_token: null, refresh_token: null });
    expect(app.accounts.find((a) => a.account_ref === 'outra')!.status).toBe('connected');
    expect(app.envios).toHaveLength(1);
    const corpo = JSON.parse(app.envios[0]!.body);
    expect(corpo).toMatchObject({ event: 'account.disconnected', customer_ref: 'loja-1' });
    expect(corpo.data.account.status).toBe('disconnected');
    expect(app.envios[0]!.body).not.toMatch(/APP_USR|token/);
  });

  it('action diferente ou tópico outro: 200 sem consultar o MP; erro de rede: 500', async () => {
    const valida = vi.fn(async () => false);
    app = await sobe({ oauth: oauthFalso({ contaAindaValida: valida }) });
    await semear(app);
    expect((await aviso({ ...desautorizou, action: 'application.authorized' })).status).toBe(200);
    expect((await aviso({ type: 'payment', data: { id: '1' } })).status).toBe(200);
    expect(valida).not.toHaveBeenCalled();
    await app.fechar();
    app = await sobe({ oauth: oauthFalso({ contaAindaValida: async () => { throw new MercadoPagoError(504, 'timeout', 'x'); } }) });
    await semear(app);
    expect((await aviso(desautorizou)).status).toBe(500);
    expect(app.accounts[0]!.status).toBe('connected');
  });
});

describe('renovarContas', () => {
  const montar = async (oauth: Parameters<typeof oauthFalso>[0], expira: Date) => {
    app = await sobe({ oauth: oauthFalso(oauth) });
    const conta = await semear(app, { expira });
    const deps = { repos: app.repos, entrega: { repos: app.repos, post: async (u: string, i: { body: string; headers: Record<string, string> }) => { app.envios.push({ url: u, ...i }); return { status: 200 }; } }, oauth: oauthFalso(oauth) };
    return { conta, deps };
  };
  const agora = new Date('2026-11-20T12:00:00Z');
  const em = (dias: number) => new Date(agora.getTime() + dias * 86400_000);

  it('vence em 10 dias: renova e guarda os tokens novos', async () => {
    const renovar = vi.fn(async () => tokens);
    const { deps } = await montar({ renovarToken: renovar }, em(10));
    const r = await renovarContas(deps, agora);
    expect(r).toEqual({ renovadas: 1, expiradas: 0, erros: 0 });
    expect(renovar).toHaveBeenCalledWith(expect.objectContaining({ client_id: CONFIG_LOJAS.client_id }), REF);
    expect(app.accounts[0]).toMatchObject({ status: 'connected', access_token: tokens.access_token, refresh_token: tokens.refresh_token });
    expect(new Date(app.accounts[0]!.expires_at!).getTime()).toBe(agora.getTime() + tokens.expires_in * 1000);
    expect(app.accounts[0]!.last_refresh_at).toBe(agora.toISOString());
  });

  it('vence daqui a 60 dias: não mexe', async () => {
    const renovar = vi.fn(async () => tokens);
    const { deps } = await montar({ renovarToken: renovar }, em(60));
    expect(await renovarContas(deps, agora)).toEqual({ renovadas: 0, expiradas: 0, erros: 0 });
    expect(renovar).not.toHaveBeenCalled();
  });

  it('invalid_grant: expired, tokens apagados e callback account.disconnected', async () => {
    const { deps } = await montar({ renovarToken: async () => { throw new MercadoPagoError(400, 'invalid_grant', 'HTTP 400'); } }, em(10));
    const r = await renovarContas(deps, agora);
    expect(r.expiradas).toBe(1);
    expect(app.accounts[0]).toMatchObject({ status: 'expired', access_token: null, refresh_token: null });
    const corpo = JSON.parse(app.envios[0]!.body);
    expect(corpo).toMatchObject({ event: 'account.disconnected', customer_ref: 'loja-1' });
    expect(corpo.data.account.status).toBe('expired');
  });

  it('erro 500: guarda last_error e segue connected; já vencida e com erro: expired', async () => {
    const { deps } = await montar({ renovarToken: async () => { throw new MercadoPagoError(500, 'http_500', 'HTTP 500'); } }, em(10));
    const r = await renovarContas(deps, agora);
    expect(r).toEqual({ renovadas: 0, expiradas: 0, erros: 1 });
    expect(app.accounts[0]).toMatchObject({ status: 'connected', last_error: expect.stringContaining('500') });
    expect(app.envios).toHaveLength(0);
    await app.fechar();

    const v = await montar({ renovarToken: async () => { throw new MercadoPagoError(500, 'http_500', 'HTTP 500'); } }, em(-1));
    expect((await renovarContas(v.deps, agora)).expiradas).toBe(1);
    expect(app.accounts[0]!.status).toBe('expired');
  });

  it('um erro numa conta não para as outras', async () => {
    let n = 0;
    const { deps } = await montar({ renovarToken: async () => { if (n++ === 0) throw new Error('x'); return tokens; } }, em(10));
    await semear(app, { ref: 'loja-2', expira: em(5) });
    const r = await renovarContas(deps, agora);
    expect(r.renovadas + r.erros + r.expiradas).toBe(2);
    expect(r.renovadas).toBe(1);
  });
});
