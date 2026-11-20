import { randomUUID } from 'crypto';
import { GatewayConfig, Project } from '../../src/payments/payment.types';
import {
  AccountRow,
  AccountsRepo,
  OAuthStateRow,
  OAuthStatesRepo,
  DeliveriesRepo,
  DeliveryRow,
  EventRow,
  EventsRepo,
  ConfigsRepo,
  ProjectsRepo,
  Repos,
} from '../../src/repositories/types';
import { MPClient, MPRequestOptions } from '../../src/gateways/mercadopago/mercadopago.client';

export function fakeRepos(opts: { projects?: Project[]; configs?: GatewayConfig[] } = {}) {
  const projects: Project[] = opts.projects ?? [];
  const configs: Array<GatewayConfig & { is_active: boolean }> = (opts.configs ?? []).map((c) => ({ ...c, is_active: true }));
  const events: EventRow[] = [];
  const deliveries: DeliveryRow[] = [];

  const p: ProjectsRepo = {
    async findById(id) { return projects.find((x) => x.id === id) ?? null; },
    async findByApiKey(k) { return projects.find((x) => x.api_key === k) ?? null; },
    async findByName(n) { return projects.find((x) => x.name === n) ?? null; },
    async create(d) {
      const novo: Project = { id: d.id ?? randomUUID(), name: d.name, api_key: d.api_key, callback_url: d.callback_url, callback_secret: 'segredo-gerado' };
      projects.push(novo);
      return novo;
    },
    async updateCallbackUrl(id, url) { const x = projects.find((y) => y.id === id); if (x) x.callback_url = url; },
  };
  const c: ConfigsRepo = {
    async findActive(projectId, gateway) {
      return configs.find((x) => x.project_id === projectId && x.is_active && (!gateway || x.gateway === gateway)) ?? null;
    },
    async deactivateAll(projectId, gateway) {
      configs.filter((x) => x.project_id === projectId && x.gateway === gateway).forEach((x) => (x.is_active = false));
    },
    async insertEncrypted(projectId, gateway, enc) {
      configs.push({ id: randomUUID(), project_id: projectId, gateway, config: { cifrado: enc }, is_active: true });
    },
  };
  const e: EventsRepo = {
    async findByGatewayEventId(g) { return events.find((x) => x.gateway_event_id === g) ?? null; },
    async getById(id) { return events.find((x) => x.id === id) ?? null; },
    async insert(row) {
      if (events.some((x) => x.gateway_event_id === row.gateway_event_id)) return null;
      const novo: EventRow = { ...row, id: randomUUID(), processed_at: new Date().toISOString() };
      events.push(novo);
      return novo;
    },
  };
  const d: DeliveriesRepo = {
    async create(eventId, projectId) {
      const novo: DeliveryRow = {
        id: randomUUID(), event_id: eventId, project_id: projectId, status: 'pending', attempts: 0,
        next_attempt_at: new Date().toISOString(), last_status_code: null, last_error: null, delivered_at: null,
        created_at: new Date().toISOString(),
      };
      deliveries.push(novo);
      return { ...novo };
    },
    async getById(id) { return deliveries.find((x) => x.id === id) ?? null; },
    async getByEventId(id) { return deliveries.find((x) => x.event_id === id) ?? null; },
    async update(id, patch) { Object.assign(deliveries.find((x) => x.id === id)!, patch); },
    async claimDue(limit, now, lockUntil) {
      const out: DeliveryRow[] = [];
      for (const x of deliveries) {
        if (out.length >= limit) break;
        if (x.status === 'pending' && new Date(x.next_attempt_at) <= now) {
          x.next_attempt_at = lockUntil.toISOString();
          out.push({ ...x });
        }
      }
      return out;
    },
    async listFailed(projectId) {
      return deliveries
        .filter((x) => x.project_id === projectId && x.status === 'failed')
        .map((x) => ({
          id: x.id, event: events.find((y) => y.id === x.event_id)?.event_type ?? '', attempts: x.attempts,
          last_status_code: x.last_status_code, last_error: x.last_error, created_at: x.created_at,
        }));
    },
    async resetToPending(id, projectId, now) {
      const x = deliveries.find((y) => y.id === id && y.project_id === projectId && y.status === 'failed');
      if (!x) return false;
      Object.assign(x, { status: 'pending', attempts: 0, next_attempt_at: now.toISOString() });
      return true;
    },
  };
  const accounts: AccountRow[] = [];
  const states: OAuthStateRow[] = [];
  const a: AccountsRepo = {
    async findByRef(pid, ref) { return accounts.find((x) => x.project_id === pid && x.account_ref === ref) ?? null; },
    async findConnectedByMpUserId(pid, mp) {
      return accounts.filter((x) => x.project_id === pid && x.mp_user_id === mp && x.status === 'connected');
    },
    async upsertConnected(r) {
      const agora = new Date().toISOString();
      let x = accounts.find((y) => y.project_id === r.project_id && y.account_ref === r.account_ref);
      if (!x) {
        x = { id: randomUUID(), gateway: 'mercadopago', created_at: agora, disconnected_at: null, last_refresh_at: null } as AccountRow;
        accounts.push(x);
      }
      Object.assign(x, {
        project_id: r.project_id, account_ref: r.account_ref, status: 'connected', mp_user_id: r.mp_user_id,
        access_token: r.access_token, refresh_token: r.refresh_token, public_key: r.public_key, expires_at: r.expires_at,
        connected_at: r.connected_at, disconnected_at: null, last_error: null, updated_at: agora,
      });
      return { ...x };
    },
    async markDisconnected(id, status, now, lastError) {
      const x = accounts.find((y) => y.id === id)!;
      Object.assign(x, { status, access_token: null, refresh_token: null, disconnected_at: now.toISOString(), last_error: lastError ?? null });
      return { ...x };
    },
    async updateTokens(id, t) {
      Object.assign(accounts.find((y) => y.id === id)!, { ...t, last_error: null });
    },
    async setLastError(id, msg) { accounts.find((y) => y.id === id)!.last_error = msg; },
    async listToRefresh(before, limit) {
      return accounts.filter((x) => x.status === 'connected' && x.expires_at && new Date(x.expires_at) < before).slice(0, limit).map((x) => ({ ...x }));
    },
  };
  const o: OAuthStatesRepo = {
    async create(r) { states.push({ ...r, used_at: null, created_at: new Date().toISOString() }); },
    async consume(state, now) {
      const x = states.find((y) => y.state === state && !y.used_at);
      if (!x) return null;
      x.used_at = now.toISOString();
      return { ...x };
    },
  };
  const repos: Repos = { projects: p, configs: c, events: e, deliveries: d, accounts: a, oauthStates: o };
  return { repos, projects, configs, events, deliveries, accounts, states };
}

export const projetoExemplo: Project = {
  id: '11111111-1111-4111-8111-111111111111',
  name: 'Dittu',
  api_key: 'chave-de-teste',
  callback_url: 'https://dittu.exemplo/webhooks/zito-payments',
  callback_secret: 'segredo-do-callback',
};

/** Cliente do MP falso: rotas "METODO /caminho" -> resposta (ou função), e registro das chamadas. */
export class FakeMPClient implements MPClient {
  calls: Array<{ method: string; path: string; options?: MPRequestOptions }> = [];
  constructor(private routes: Record<string, unknown | ((o?: MPRequestOptions) => unknown)>) {}
  async request<T>(method: string, path: string, options?: MPRequestOptions): Promise<T> {
    this.calls.push({ method, path, options });
    const r = this.routes[`${method} ${path}`];
    if (r === undefined) throw new Error(`rota não prevista no teste: ${method} ${path}`);
    const v = typeof r === 'function' ? (r as (o?: MPRequestOptions) => unknown)(options) : r;
    if (v instanceof Error) throw v;
    return v as T;
  }
}
