import { Router } from 'express';
import express from 'express';
import { createWebhookHandler } from '../webhook/webhook.controller';
import { createWebhookLojasHandler } from '../webhook/lojas.controller';
import type { AppDeps } from '../app';

export function createWebhookRoute(deps: AppDeps): Router {
  const router = Router();

  // lojas do Dittu (OAuth do MP): antes do '/:gateway' para não cair no gateway genérico
  router.post('/mercadopago-lojas', express.raw({ type: '*/*' }), createWebhookLojasHandler(deps));

  // MUST use express.raw() before express.json() for Stripe signature validation
  router.post('/:gateway', express.raw({ type: 'application/json' }), createWebhookHandler(deps));

  return router;
}
