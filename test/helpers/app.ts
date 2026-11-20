import { AddressInfo } from 'net';
import { vi } from 'vitest';
import { createApp } from '../../src/app';
import { StripeGateway } from '../../src/gateways/stripe/stripe.gateway';
import { MercadoPagoGateway } from '../../src/gateways/mercadopago/mercadopago.gateway';
import { MPClient } from '../../src/gateways/mercadopago/mercadopago.client';
import { PostFn } from '../../src/callbacks/entregar';
import { fakeRepos, projetoExemplo } from './fakes';

export const SEGREDO_MP = 'segredo-do-webhook-mp';
export const TOKEN_MP = 'APP_USR-token-que-nunca-pode-aparecer';

export async function subirApp(mpClient: MPClient, opts: { comConfigMP?: boolean } = {}) {
  const f = fakeRepos({
    projects: [{ ...projetoExemplo }],
    configs: [
      ...(opts.comConfigMP === false
        ? []
        : [{ id: 'c1', project_id: projetoExemplo.id, gateway: 'mercadopago', config: { access_token: TOKEN_MP, webhook_secret: SEGREDO_MP, ambiente: 'teste' } }]),
      { id: 'c2', project_id: projetoExemplo.id, gateway: 'stripe', config: { secret_key: 'sk', webhook_secret: 'whsec', price_id: 'p', success_url: 's', cancel_url: 'c' } },
    ],
  });
  const stripe = { webhooks: { constructEvent: vi.fn() } };
  const envios: Array<{ url: string; headers: Record<string, string>; body: string }> = [];
  const post: PostFn = async (url, init) => {
    envios.push({ url, ...init });
    return { status: 200 };
  };
  const buildMercadoPago = (c: { config: Record<string, string> }) => new MercadoPagoGateway(c.config as never, mpClient);
  const app = createApp({
    repos: f.repos,
    entrega: { repos: f.repos, post },
    buildMercadoPago,
    buildGateway: (c) =>
      c.gateway === 'stripe'
        ? new StripeGateway(c.config as never, stripe as never)
        : c.gateway === 'mercadopago'
          ? buildMercadoPago(c)
          : (() => { throw new Error('Unsupported'); })(),
  });
  const server = app.listen(0);
  const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  return { ...f, stripe, envios, url, fechar: () => new Promise<void>((r) => server.close(() => r())) };
}
