import { EntregaDeps, tentarEntrega } from './entregar';

const INTERVALO_MS = 30_000;
const LOTE = 20;
const TRAVA_MS = 2 * 60_000;

/** Um ciclo: pega as entregas vencidas (marcando-as antes) e tenta cada uma. Devolve quantas tentou. */
export async function processarFila(deps: EntregaDeps): Promise<number> {
  const agora = (deps.agora ?? (() => new Date()))();
  const devidas = await deps.repos.deliveries.claimDue(LOTE, agora, new Date(agora.getTime() + TRAVA_MS));

  for (const entrega of devidas) {
    try {
      const [evento, project] = await Promise.all([
        deps.repos.events.getById(entrega.event_id),
        deps.repos.projects.findById(entrega.project_id),
      ]);
      if (!evento || !project) {
        console.error(`[callback] entrega ${entrega.id} sem evento ou projeto`);
        continue;
      }
      await tentarEntrega(deps, entrega, evento, project);
    } catch (err) {
      console.error(`[callback] erro ao reenviar a entrega ${entrega.id}:`, err instanceof Error ? err.message : err);
    }
  }
  return devidas.length;
}

export function iniciarFila(deps: EntregaDeps, intervaloMs: number = INTERVALO_MS): NodeJS.Timeout {
  let rodando = false;
  return setInterval(() => {
    if (rodando) return;
    rodando = true;
    processarFila(deps)
      .catch((err) => console.error('[callback] erro na fila:', err instanceof Error ? err.message : err))
      .finally(() => {
        rodando = false;
      });
  }, intervaloMs);
}
