import express, { Express } from 'express';
import path from 'node:path';
import { PaymentGateway } from './gateways/gateway.interface';
import { GatewayConfig } from './payments/payment.types';
import { Repos } from './repositories/types';
import { EntregaDeps } from './callbacks/entregar';
import { MercadoPagoGateway } from './gateways/mercadopago/mercadopago.gateway';
import { createWebhookRoute } from './routes/webhook.route';
import { createV1Router } from './routes/v1';
import checkoutRoute from './routes/checkout.route';
import subscriptionRoute from './routes/subscription.route';
import payRoute from './routes/pay.route';

export interface AppDeps {
  repos: Repos;
  entrega: EntregaDeps;
  buildGateway: (config: GatewayConfig) => PaymentGateway;
  buildMercadoPago: (config: GatewayConfig) => MercadoPagoGateway;
}

export function createApp(deps: AppDeps): Express {
  const app = express();

  // webhook route uses express.raw() internally, must be registered BEFORE express.json()
  app.use('/webhook', createWebhookRoute(deps));

  app.use(express.json());
  app.use(express.static(path.join(__dirname, 'public')));

  app.get('/health', (_req, res) => {
    res.json({ status: 'ok' });
  });

  app.get('/sucesso', (_req, res) => {
    res.sendFile(path.join(__dirname, '../public/sucesso.html'));
  });

  app.get('/cancelado', (_req, res) => {
    res.sendFile(path.join(__dirname, '../public/cancelado.html'));
  });

  app.use('/checkout', checkoutRoute);
  app.use('/subscription', subscriptionRoute);
  app.use('/pay', payRoute);
  app.use('/v1', createV1Router(deps));

  return app;
}
