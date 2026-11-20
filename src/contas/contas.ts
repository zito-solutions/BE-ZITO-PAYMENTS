import { Ambiente, ConnectedAccount } from '../gateways/gateway.interface';
import { CredenciaisAppLojas } from '../gateways/mercadopago/oauth';
import { criarEEntregar, EntregaDeps } from '../callbacks/entregar';
import { AccountRow, Repos } from '../repositories/types';
import { GatewayConfig, Project } from '../payments/payment.types';

export const GATEWAY_LOJAS = 'mercadopago_lojas';

export interface ConfigLojas extends CredenciaisAppLojas {
  webhook_secret: string;
  ambiente: Ambiente;
}

/** Lê a config `mercadopago_lojas` já decifrada; null se faltar campo. */
export function lerConfigLojas(c: GatewayConfig | null): ConfigLojas | null {
  if (!c) return null;
  const { client_id, client_secret, webhook_secret, ambiente, redirect_uri } = c.config;
  if (!client_id || !client_secret || !redirect_uri) return null;
  if (ambiente !== 'teste' && ambiente !== 'producao') return null;
  return { client_id, client_secret, webhook_secret: webhook_secret ?? '', ambiente, redirect_uri };
}

/** Só os campos do contrato: nunca token. */
export function paraConnectedAccount(a: AccountRow, ambiente: Ambiente): ConnectedAccount {
  return {
    account_ref: a.account_ref,
    status: a.status,
    mp_user_id: a.mp_user_id,
    connected_at: a.connected_at ? new Date(a.connected_at).toISOString() : null,
    expires_at: a.expires_at ? new Date(a.expires_at).toISOString() : null,
    ambiente,
  };
}

/** Grava o evento account.* e entrega o callback. Nunca lança por falha na entrega. */
export async function emitirEventoDeConta(
  deps: { repos: Pick<Repos, 'events' | 'deliveries' | 'projects'>; entrega: EntregaDeps },
  project: Project,
  evento: 'account.connected' | 'account.disconnected',
  conta: ConnectedAccount,
  quando: Date
): Promise<void> {
  const acao = evento === 'account.connected' ? 'connected' : 'disconnected';
  const gravado = await deps.repos.events.insert({
    project_id: project.id,
    gateway: 'mercadopago',
    event_type: evento,
    customer_ref: conta.account_ref,
    gateway_event_id: `mp-lojas:account:${conta.account_ref}:${acao}:${quando.getTime()}`,
    payload: { data: { subscription: null, payment: null, account: conta } },
  });
  if (!gravado) return;
  try {
    await criarEEntregar(deps.entrega, project, gravado);
  } catch (err) {
    console.error(`[${project.name}] [${GATEWAY_LOJAS}] callback ${evento} não foi criado:`, err instanceof Error ? err.message : err);
  }
}
