import { Project } from '../payments/payment.types';
import { DeliveryRow, EventRow, Repos } from '../repositories/types';
import { assinarCallback } from './assinar';

/** Espera depois da n-ésima falha: 1 min, 5 min, 15 min, 1 h, 6 h, 24 h. A 7ª falha encerra. */
export const ESPERAS_MS = [60_000, 5 * 60_000, 15 * 60_000, 3_600_000, 6 * 3_600_000, 24 * 3_600_000];
export const MAX_TENTATIVAS = ESPERAS_MS.length + 1;
const TIMEOUT_MS = 10_000;

export type PostFn = (url: string, init: { headers: Record<string, string>; body: string }) => Promise<{ status: number }>;

const postPadrao: PostFn = async (url, init) => {
  const res = await fetch(url, {
    method: 'POST',
    headers: init.headers,
    body: init.body,
    redirect: 'manual',
    signal: AbortSignal.timeout(TIMEOUT_MS),
  });
  return { status: res.status };
};

export interface EntregaDeps {
  repos: Pick<Repos, 'deliveries' | 'events' | 'projects'>;
  post?: PostFn;
  agora?: () => Date;
}

/** Corpo do callback, sempre reconstruído do evento gravado: o reenvio sai igual ao original. */
export function montarCorpo(evento: EventRow): string {
  const payload = (evento.payload ?? {}) as { data?: { subscription?: unknown; payment?: unknown; account?: unknown } };
  return JSON.stringify({
    id: evento.id,
    event: evento.event_type,
    customer_ref: evento.customer_ref,
    gateway: evento.gateway,
    project_id: evento.project_id,
    occurred_at: new Date(evento.processed_at).toISOString(),
    data: {
      subscription: payload.data?.subscription ?? null,
      payment: payload.data?.payment ?? null,
      account: payload.data?.account ?? null,
    },
  });
}

/** Cria a entrega do evento e tenta na hora. Nunca lança por falha do projeto. */
export async function criarEEntregar(deps: EntregaDeps, project: Project, evento: EventRow): Promise<void> {
  const entrega = await deps.repos.deliveries.create(evento.id, project.id);
  await tentarEntrega(deps, entrega, evento, project);
}

/** Uma tentativa de envio: atualiza a entrega (delivered, próxima tentativa ou failed). */
export async function tentarEntrega(
  deps: EntregaDeps,
  entrega: DeliveryRow,
  evento: EventRow,
  project: Project
): Promise<void> {
  const agora = deps.agora ?? (() => new Date());
  const post = deps.post ?? postPadrao;
  const corpo = montarCorpo(evento);

  let statusCode: number | null = null;
  let erro: string | null = null;
  try {
    const res = await post(project.callback_url, {
      headers: {
        'Content-Type': 'application/json',
        'X-Zito-Event-Id': evento.id,
        'X-Zito-Signature': assinarCallback(project.callback_secret, corpo, agora()),
      },
      body: corpo,
    });
    statusCode = res.status;
    if (res.status < 200 || res.status >= 300) erro = `HTTP ${res.status}`;
  } catch (err) {
    erro = err instanceof Error && (err.name === 'TimeoutError' || err.name === 'AbortError') ? 'timeout' : 'erro de rede';
  }

  const tentativas = entrega.attempts + 1;
  if (!erro) {
    await deps.repos.deliveries.update(entrega.id, {
      status: 'delivered',
      attempts: tentativas,
      last_status_code: statusCode,
      last_error: null,
      delivered_at: agora().toISOString(),
    });
    return;
  }

  if (tentativas >= MAX_TENTATIVAS) {
    await deps.repos.deliveries.update(entrega.id, {
      status: 'failed',
      attempts: tentativas,
      last_status_code: statusCode,
      last_error: erro,
    });
    console.error(`[callback] entrega ${entrega.id} do projeto ${project.id} falhou ${tentativas} vezes e foi encerrada`);
    return;
  }

  await deps.repos.deliveries.update(entrega.id, {
    status: 'pending',
    attempts: tentativas,
    next_attempt_at: new Date(agora().getTime() + ESPERAS_MS[tentativas - 1]!).toISOString(),
    last_status_code: statusCode,
    last_error: erro,
  });
}
