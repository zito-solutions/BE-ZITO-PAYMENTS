import { EntregaDeps } from '../callbacks/entregar';
import { MercadoPagoError } from '../gateways/mercadopago/mercadopago.client';
import { OAuthGateway } from '../gateways/mercadopago/oauth';
import { Repos } from '../repositories/types';
import { emitirEventoDeConta, GATEWAY_LOJAS, lerConfigLojas, paraConnectedAccount } from './contas';

const DIA_MS = 24 * 3_600_000;
const ANTECEDENCIA_MS = 30 * DIA_MS;
const LOTE = 20;
const INTERVALO_MS = 6 * 3_600_000;
const PRIMEIRA_MS = 60_000;

export interface RenovarDeps {
  repos: Repos;
  entrega: EntregaDeps;
  oauth: OAuthGateway;
}

export interface ResultadoRenovacao {
  renovadas: number;
  expiradas: number;
  erros: number;
}

/** Renova os tokens que vencem em até 30 dias. Um erro numa conta não para as outras. */
export async function renovarContas(deps: RenovarDeps, agora: Date = new Date()): Promise<ResultadoRenovacao> {
  const r: ResultadoRenovacao = { renovadas: 0, expiradas: 0, erros: 0 };
  const contas = await deps.repos.accounts.listToRefresh(new Date(agora.getTime() + ANTECEDENCIA_MS), LOTE);

  for (const conta of contas) {
    try {
      const project = await deps.repos.projects.findById(conta.project_id);
      const cfg = lerConfigLojas(project ? await deps.repos.configs.findActive(project.id, GATEWAY_LOJAS) : null);
      const vencida = !!conta.expires_at && new Date(conta.expires_at) < agora;

      const expirar = async (motivo: string) => {
        const nova = await deps.repos.accounts.markDisconnected(conta.id, 'expired', agora, motivo);
        r.expiradas++;
        if (project && cfg) await emitirEventoDeConta(deps, project, 'account.disconnected', paraConnectedAccount(nova, cfg.ambiente), agora);
      };

      if (!project || !cfg || !conta.refresh_token) {
        if (vencida) await expirar('sem config ou refresh token');
        else {
          await deps.repos.accounts.setLastError(conta.id, 'sem config ou refresh token');
          r.erros++;
        }
        continue;
      }

      try {
        const t = await deps.oauth.renovarToken(cfg, conta.refresh_token);
        await deps.repos.accounts.updateTokens(conta.id, {
          access_token: t.access_token,
          refresh_token: t.refresh_token,
          public_key: t.public_key,
          expires_at: new Date(agora.getTime() + t.expires_in * 1000).toISOString(),
          last_refresh_at: agora.toISOString(),
        });
        r.renovadas++;
      } catch (err) {
        const status = err instanceof MercadoPagoError ? err.status : 0;
        const motivo = err instanceof MercadoPagoError ? `renovação recusada: ${err.status} ${err.code}` : 'renovação falhou';
        if (status === 400 || status === 401 || vencida) {
          await expirar(motivo);
        } else {
          await deps.repos.accounts.setLastError(conta.id, motivo);
          r.erros++;
        }
      }
    } catch (err) {
      r.erros++;
      console.error(`[${GATEWAY_LOJAS}] renovação da conta ${conta.id} falhou:`, err instanceof Error ? err.message : 'erro');
    }
  }
  return r;
}

/** Um ciclo a cada 6 h, e um 1 min depois de subir. */
export function iniciarRenovacao(deps: RenovarDeps): { parar: () => void } {
  let rodando = false;
  const ciclo = () => {
    if (rodando) return;
    rodando = true;
    renovarContas(deps)
      .then((r) => {
        if (r.renovadas || r.expiradas || r.erros) console.log(`[${GATEWAY_LOJAS}] renovação: ${r.renovadas} renovadas, ${r.expiradas} expiradas, ${r.erros} erros`);
      })
      .catch((err) => console.error(`[${GATEWAY_LOJAS}] erro na renovação:`, err instanceof Error ? err.message : 'erro'))
      .finally(() => {
        rodando = false;
      });
  };
  const primeira = setTimeout(ciclo, PRIMEIRA_MS);
  const intervalo = setInterval(ciclo, INTERVALO_MS);
  return { parar: () => { clearTimeout(primeira); clearInterval(intervalo); } };
}
