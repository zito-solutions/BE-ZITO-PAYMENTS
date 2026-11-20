const BASE_URL = 'https://api.mercadopago.com';
const TIMEOUT_MS = 10_000;

/** Erro do Mercado Pago sem token nem corpo da requisição. */
export class MercadoPagoError extends Error {
  constructor(
    public readonly status: number,
    public readonly code: string,
    message: string
  ) {
    super(message);
    this.name = 'MercadoPagoError';
  }
}

export interface MPRequestOptions {
  body?: unknown;
  query?: Record<string, string | undefined>;
  idempotencyKey?: string;
}

export interface MPClient {
  request<T = unknown>(method: string, path: string, options?: MPRequestOptions): Promise<T>;
}

type FetchLike = (url: string, init: RequestInit) => Promise<Response>;

export class MercadoPagoClient implements MPClient {
  constructor(
    private readonly accessToken: string,
    private readonly fetchImpl: FetchLike = fetch,
    private readonly baseUrl: string = BASE_URL
  ) {}

  async request<T = unknown>(method: string, path: string, options: MPRequestOptions = {}): Promise<T> {
    const url = new URL(this.baseUrl + path);
    for (const [k, v] of Object.entries(options.query ?? {})) {
      if (v !== undefined) url.searchParams.set(k, v);
    }

    const headers: Record<string, string> = {
      Authorization: `Bearer ${this.accessToken}`,
      Accept: 'application/json',
    };
    if (options.body !== undefined) headers['Content-Type'] = 'application/json';
    if (options.idempotencyKey) headers['X-Idempotency-Key'] = options.idempotencyKey;

    let res: Response;
    try {
      res = await this.fetchImpl(url.toString(), {
        method,
        headers,
        body: options.body !== undefined ? JSON.stringify(options.body) : undefined,
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
    if (text) {
      try {
        json = JSON.parse(text);
      } catch {
        json = null;
      }
    }

    if (!res.ok) {
      const obj = (json ?? {}) as { message?: unknown; error?: unknown; code?: unknown };
      const message = typeof obj.message === 'string' && obj.message ? obj.message : `HTTP ${res.status}`;
      const code = typeof obj.error === 'string' ? obj.error : typeof obj.code === 'string' ? obj.code : `http_${res.status}`;
      throw new MercadoPagoError(res.status, code, message);
    }

    return json as T;
  }
}
