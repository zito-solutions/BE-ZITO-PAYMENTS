import { Request, Response, Router } from 'express';
import type { AppDeps } from '../app';
import { emitirEventoDeConta, GATEWAY_LOJAS, lerConfigLojas, paraConnectedAccount } from '../contas/contas';

const PAGINA_INVALIDA = `<!doctype html><html lang="pt-BR"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Link de conexão</title></head><body style="font-family:system-ui,sans-serif;max-width:32rem;margin:4rem auto;padding:0 1rem"><p>Este link de conexão não vale mais. Volte ao painel e tente de novo.</p></body></html>`;

function um(v: unknown): string | undefined {
  const x = Array.isArray(v) ? v[0] : v;
  return typeof x === 'string' && x ? x : undefined;
}

function voltar(res: Response, returnUrl: string, params: Record<string, string>): void {
  const u = new URL(returnUrl);
  for (const [k, v] of Object.entries(params)) u.searchParams.set(k, v);
  res.redirect(303, u.toString());
}

export function createOAuthRouter(deps: AppDeps): Router {
  const router = Router();

  // Volta do OAuth: pública (a pessoa vem do MP). Nunca põe token na URL nem no log.
  router.get('/mercadopago/retorno', async (req: Request, res: Response) => {
    const state = um(req.query['state']);
    try {
      const agora = new Date();
      const linha = state ? await deps.repos.oauthStates.consume(state, agora) : null;
      if (!linha) {
        res.status(400).type('html').send(PAGINA_INVALIDA);
        return;
      }
      if (new Date(linha.expires_at) < agora) {
        voltar(res, linha.return_url, { mp: 'erro', motivo: 'expirado' });
        return;
      }
      const code = um(req.query['code']);
      if (um(req.query['error']) || !code) {
        voltar(res, linha.return_url, { mp: 'erro', motivo: 'negado' });
        return;
      }

      const project = await deps.repos.projects.findById(linha.project_id);
      const cfg = lerConfigLojas(project ? await deps.repos.configs.findActive(project.id, GATEWAY_LOJAS) : null);
      if (!project || !cfg) {
        console.error(`[${project?.name ?? '-'}] [${GATEWAY_LOJAS}] oauth falhou: sem config`);
        voltar(res, linha.return_url, { mp: 'erro', motivo: 'falha' });
        return;
      }

      let tokens;
      try {
        tokens = await deps.oauth.trocarCodigo(cfg, code);
      } catch (err) {
        const status = (err as { status?: number }).status ?? 0;
        const codigo = (err as { code?: string }).code ?? 'erro';
        console.error(`[${project.name}] [${GATEWAY_LOJAS}] oauth falhou: ${status} ${codigo}`);
        voltar(res, linha.return_url, { mp: 'erro', motivo: 'falha' });
        return;
      }

      const conta = await deps.repos.accounts.upsertConnected({
        project_id: project.id,
        account_ref: linha.account_ref,
        mp_user_id: String(tokens.user_id),
        access_token: tokens.access_token,
        refresh_token: tokens.refresh_token,
        public_key: tokens.public_key,
        expires_at: new Date(agora.getTime() + tokens.expires_in * 1000).toISOString(),
        connected_at: agora.toISOString(),
      });
      console.log(`[${project.name}] [${GATEWAY_LOJAS}] conta conectada`);
      await emitirEventoDeConta(deps, project, 'account.connected', paraConnectedAccount(conta, cfg.ambiente), agora);
      voltar(res, linha.return_url, { mp: 'conectado' });
    } catch (err) {
      console.error(`[${GATEWAY_LOJAS}] retorno do oauth: erro interno:`, err instanceof Error ? err.message : 'erro');
      res.status(500).type('html').send(PAGINA_INVALIDA);
    }
  });

  return router;
}
