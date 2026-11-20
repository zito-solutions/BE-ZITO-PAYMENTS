import { Request, Response } from 'express';
import type { AppDeps } from '../app';
import { AvisoInvalidoError } from '../gateways/mercadopago/webhook';
import { criarEEntregar } from '../callbacks/entregar';
import { WebhookResult } from '../gateways/gateway.interface';

function um(v: string | string[] | undefined | unknown): string | undefined {
  const x = Array.isArray(v) ? v[0] : v;
  return typeof x === 'string' ? x : undefined;
}

function payloadDoEvento(rawBody: Buffer, result: WebhookResult): unknown {
  let aviso: unknown = null;
  try {
    aviso = JSON.parse(rawBody.toString('utf-8'));
  } catch {
    aviso = null;
  }
  return { aviso, data: result.data ?? { subscription: null, payment: null } };
}

export function createWebhookHandler(deps: AppDeps) {
  return async function handleWebhook(req: Request, res: Response): Promise<void> {
    const gateway = um(req.params['gateway']) ?? '';
    const projectId = um(req.headers['x-project-id']) ?? um(req.query['project_id']);

    if (!projectId) {
      res.status(400).json({ error: 'Missing x-project-id header' });
      return;
    }

    try {
      const project = await deps.repos.projects.findById(projectId);
      if (!project) {
        res.status(404).json({ error: 'Project not found' });
        return;
      }

      const gatewayConfig = await deps.repos.configs.findActive(project.id, gateway);
      if (!gatewayConfig) {
        res.status(404).json({ error: 'No active gateway config found' });
        return;
      }

      let handler;
      try {
        handler = deps.buildGateway(gatewayConfig);
      } catch {
        res.status(400).json({ error: `Unsupported gateway: ${gateway}` });
        return;
      }

      const rawBody = Buffer.isBuffer(req.body) ? req.body : Buffer.alloc(0);
      const query: Record<string, string | undefined> = {};
      for (const [k, v] of Object.entries(req.query)) query[k] = um(v);

      let result: WebhookResult | null;
      try {
        result = await handler.handleWebhookEvent({ rawBody, headers: req.headers, query });
      } catch (err) {
        if (gateway === 'stripe') {
          console.error(`[${project.name}] [${gateway}] webhook validation failed:`, err);
          res.status(400).json({ error: 'Webhook validation failed' });
          return;
        }
        if (err instanceof AvisoInvalidoError) {
          console.error(`[${project.name}] [${gateway}] aviso recusado: ${err.motivo}`);
          res.status(401).json({ error: 'Invalid signature' });
          return;
        }
        // erro ao consultar o gateway: 500 para ele tentar de novo
        console.error(`[${project.name}] [${gateway}] erro ao tratar o aviso:`, err instanceof Error ? err.message : err);
        res.status(500).json({ error: 'Failed to process webhook' });
        return;
      }

      if (!result || !result.customer_ref) {
        res.status(200).json({ received: true, processed: false });
        return;
      }

      console.log(`[${project.name}] [${gateway}] evento recebido: ${result.event}`);

      const existente = await deps.repos.events.findByGatewayEventId(result.gateway_event_id);
      if (existente) {
        // se o evento chegou a ser gravado mas a entrega não foi criada, cria agora
        if (!(await deps.repos.deliveries.getByEventId(existente.id))) {
          await criarEEntregar(deps.entrega, project, existente);
        }
        res.status(200).json({ received: true, processed: false, reason: 'duplicate' });
        return;
      }

      const evento = await deps.repos.events.insert({
        project_id: project.id,
        gateway,
        event_type: result.event,
        customer_ref: result.customer_ref,
        gateway_event_id: result.gateway_event_id,
        payload: payloadDoEvento(rawBody, result),
      });
      if (!evento) {
        res.status(200).json({ received: true, processed: false, reason: 'duplicate' });
        return;
      }

      await criarEEntregar(deps.entrega, project, evento);
      res.status(200).json({ received: true, processed: true });
    } catch (err) {
      console.error(`[webhook] [${gateway}] erro interno:`, err instanceof Error ? err.message : err);
      res.status(500).json({ error: 'Internal error' });
    }
  };
}
