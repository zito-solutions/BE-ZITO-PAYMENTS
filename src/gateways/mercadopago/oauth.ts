import { MercadoPagoError } from './mercadopago.client';

const BASE_URL = 'https://api.mercadopago.com';
const AUTH_URL = 'https://auth.mercadopago.com.br/authorization';
const TIMEOUT_MS = 10_000;

export interface CredenciaisAppLojas {
  client_id: string;
  client_secret: string;
  redirect_uri: string;
}

export interface TokensMP {
  access_token: string;
  refresh_token: string;
  public_key: string | null;
  user_id: number | string;
  expires_in: number;
}

export interface OAuthGateway {
  trocarCodigo(cfg: CredenciaisAppLojas, code: string): Promise<TokensMP>;
  renovarToken(cfg: CredenciaisAppLojas, refreshToken: string): Promise<TokensMP>;
  /** true em 200, false em 401/403; lança nos outros. */
  contaAindaValida(accessToken: string): Promise<boolean>;
}

type FetchLike = (url: string, init: RequestInit) => Promise<Response>;

export function montarLinkDeAutorizacao(p: { client_id: string; redirect_uri: string; state: string }): string {
  const q = new URLSearchParams({
    client_id: p.client_id,
    response_type: 'code',
    platform_id: 'mp',
    state: p.state,
    redirect_uri: p.redirect_uri,
  });
  return `${AUTH_URL}?${q.toString()}`;
}

async function chamar(fetchImpl: FetchLike, method: string, url: string, headers: Record<string, string>, body?: unknown) {
  let res: Response;
  try {
    res = await fetchImpl(url, {
      method,
      headers: { Accept: 'application/json', ...headers, ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}) },
      body: body !== undefined ? JSON.stringify(body) : undefined,
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
  } catch (err) {
    const timeout = err instanceof Error && (err.name === 'TimeoutError' || err.name === 'AbortError');
    throw new MercadoPagoError(
      504,
      timeout ? 'timeout' : 'network_error',
      timeout ? 'O Mercado Pago não respondeu a tempo' : 'Não foi possível falar com o Mercado Pago'
    );
  }
  const text = await res.text();
  let json: unknown = null;
  try {
    json = text ? JSON.parse(text) : null;
  } catch {
    json = null;
  }
  return { res, json: (json ?? {}) as Record<string, unknown> };
}

function erroDoMP(status: number, json: Record<string, unknown>): MercadoPagoError {
  const code = typeof json['error'] === 'string' ? json['error'] : `http_${status}`;
  // só o código e o status: o corpo do MP pode repetir o code ou o token
  return new MercadoPagoError(status, code, `HTTP ${status}`);
}

export function criarOAuthGateway(fetchImpl: FetchLike = fetch): OAuthGateway {
  async function token(corpo: Record<string, string>): Promise<TokensMP> {
    const { res, json } = await chamar(fetchImpl, 'POST', `${BASE_URL}/oauth/token`, {}, corpo);
    if (!res.ok) throw erroDoMP(res.status, json);
    const { access_token, refresh_token, public_key, user_id, expires_in } = json as Record<string, unknown>;
    if (typeof access_token !== 'string' || typeof refresh_token !== 'string' || user_id === undefined || user_id === null) {
      throw new MercadoPagoError(502, 'invalid_response', 'Resposta inesperada do Mercado Pago');
    }
    return {
      access_token,
      refresh_token,
      public_key: typeof public_key === 'string' ? public_key : null,
      user_id: user_id as number | string,
      expires_in: typeof expires_in === 'number' ? expires_in : 15_552_000, // 180 dias, o padrão do MP
    };
  }

  return {
    trocarCodigo: (cfg, code) =>
      token({
        client_id: cfg.client_id,
        client_secret: cfg.client_secret,
        grant_type: 'authorization_code',
        code,
        redirect_uri: cfg.redirect_uri,
      }),
    renovarToken: (cfg, refreshToken) =>
      token({
        client_id: cfg.client_id,
        client_secret: cfg.client_secret,
        grant_type: 'refresh_token',
        refresh_token: refreshToken,
      }),
    async contaAindaValida(accessToken) {
      const { res, json } = await chamar(fetchImpl, 'GET', `${BASE_URL}/users/me`, { Authorization: `Bearer ${accessToken}` });
      if (res.ok) return true;
      if (res.status === 401 || res.status === 403) return false;
      throw erroDoMP(res.status, json);
    },
  };
}

export const oauthMercadoPago: OAuthGateway = criarOAuthGateway();
