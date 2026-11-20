import { Request, Response } from 'express';
import type { AppDeps } from '../app';
import { emitirEventoDeConta, GATEWAY_LOJAS, lerConfigLojas, paraConnectedAccount } from '../contas/contas';
import { verificarAssinaturaMP } from '../gateways/mercadopago/assinatura';

function um(v: unknown): string | undefined {
  const x = Array.isArray(v) ? v[0] : v;
  return typeof x === 'string' && x ? x : undefined;
}

interface CorpoAviso {
  type?: string;
  action?: string;
  user_id?: string | number;
  data?: { id?: string | number };
}

/** Webhook das lojas: `POST /webhook/mercadopago-lojas?project_id=<id>`. Tópico `mp-connect` aqui; `payment` na TASK-398. */
export function createWebhookLojasHandler(deps: AppDeps) {
  return async function handleLojas(req: Request, res: Response): Promise<void> {
    const projectId = um(req.query['project_id']);
    if (!projectId) {
      res.status(400).json({ error: 'Missing project_id' });
      return;
    }

    try {
      const project = await deps.repos.projects.findById(projectId);
      const cfg = project ? lerConfigLojas(await deps.repos.configs.findActive(project.id, GATEWAY_LOJAS)) : null;
      if (!project || !cfg) {
        res.status(404).json({ error: 'Project or config not found' });
        return;
      }

      const rawBody = Buffer.isBuffer(req.body) ? req.body : Buffer.alloc(0);
      let corpo: CorpoAviso = {};
      try {
        const j = JSON.parse(rawBody.toString('utf-8')) as unknown;
        if (j && typeof j === 'object') corpo = j as CorpoAviso;
      } catch {
        corpo = {};
      }
      const topico = um(req.query['type']) ?? um(req.query['topic']) ?? corpo.type;
      const dataIdBruto = um(req.query['data.id']) ?? um(req.query['id']) ?? corpo.data?.id;
      const dataId = dataIdBruto !== undefined ? String(dataIdBruto) : undefined;

      const xSignature = um(req.headers['x-signature']);
      if (xSignature) {
        const v = verificarAssinaturaMP({ xSignature, xRequestId: um(req.headers['x-request-id']), dataId, segredo: cfg.webhook_secret });
        if (!v.ok) {
          console.error(`[${project.name}] [${GATEWAY_LOJAS}] aviso recusado: ${v.motivo}`);
          res.status(401).json({ error: 'Invalid signature' });
          return;
        }
      }
      console.log(`[${project.name}] [${GATEWAY_LOJAS}] webhook ${topico ?? '-'} assinado: ${xSignature ? 'sim' : 'não'}`);

      if (topico !== 'mp-connect' || corpo.action !== 'application.deauthorized' || corpo.user_id === undefined) {
        res.status(200).json({ received: true, processed: false });
        return;
      }

      let desconectou = 0;
      const contas = await deps.repos.accounts.findConnectedByMpUserId(project.id, String(corpo.user_id));
      for (const conta of contas) {
        // o aviso pode não vir assinado: só desconecta se o MP confirmar que o token não vale mais
        if (!conta.access_token) continue;
        if (await deps.oauth.contaAindaValida(conta.access_token)) continue;
        const agora = new Date();
        const nova = await deps.repos.accounts.markDisconnected(conta.id, 'disconnected', agora);
        await emitirEventoDeConta(deps, project, 'account.disconnected', paraConnectedAccount(nova, cfg.ambiente), agora);
        desconectou++;
      }
      res.status(200).json({ received: true, processed: desconectou > 0 });
    } catch (err) {
      // erro de rede ao confirmar no MP: 500 para ele tentar de novo
      console.error(`[webhook] [${GATEWAY_LOJAS}] erro interno:`, err instanceof Error ? err.message : 'erro');
      res.status(500).json({ error: 'Internal error' });
    }
  };
}
