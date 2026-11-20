import { Router } from 'express';
import express from 'express';
import { createWebhookHandler } from '../webhook/webhook.controller';
import type { AppDeps } from '../app';

export function createWebhookRoute(deps: AppDeps): Router {
  const router = Router();

  // MUST use express.raw() before express.json() for Stripe signature validation
  router.post('/:gateway', express.raw({ type: 'application/json' }), createWebhookHandler(deps));

  return router;
}
