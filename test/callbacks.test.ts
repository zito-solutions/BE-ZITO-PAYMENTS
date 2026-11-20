import { createHmac } from 'crypto';
import { describe, expect, it } from 'vitest';
import { assinarCallback } from '../src/callbacks/assinar';
import { criarEEntregar, ESPERAS_MS, montarCorpo, PostFn } from '../src/callbacks/entregar';
import { processarFila } from '../src/callbacks/fila';
import { fakeRepos, projetoExemplo } from './helpers/fakes';

describe('assinarCallback', () => {
  it('gera t=<segundos>,v1=HMAC-SHA256("<t>.<corpo>")', () => {
    const agora = new Date('2026-11-20T12:00:00Z');
    const corpo = '{"a":1}';
    const t = Math.floor(agora.getTime() / 1000);
    expect(t).toBe(1795176000);
    const esperado = createHmac('sha256', 'seg').update(`${t}.${corpo}`).digest('hex');
    expect(assinarCallback('seg', corpo, agora)).toBe(`t=${t},v1=${esperado}`);
  });
});

function montar() {
  const f = fakeRepos({ projects: [{ ...projetoExemplo }] });
  let agora = new Date('2026-11-20T12:00:00Z');
  const envios: Array<{ url: string; headers: Record<string, string>; body: string }> = [];
  let resposta: number | Error = 200;
  const post: PostFn = async (url, init) => {
    envios.push({ url, ...init });
    if (resposta instanceof Error) throw resposta;
    return { status: resposta };
  };
  const deps = { repos: f.repos, post, agora: () => agora };
  return { f, deps, envios, set: (r: number | Error) => (resposta = r), avancar: (ms: number) => (agora = new Date(agora.getTime() + ms)) };
}

async function novoEvento(f: ReturnType<typeof fakeRepos>) {
  const ev = await f.repos.events.insert({
    project_id: projetoExemplo.id, gateway: 'mercadopago', event_type: 'payment.approved', customer_ref: 'loja-1',
    gateway_event_id: 'mp:payment:1:approved', payload: { data: { subscription: null, payment: { id: '1' } } },
  });
  return ev!;
}

describe('entrega do callback', () => {
  it('entrega na hora com cabeçalhos e assinatura', async () => {
    const m = montar();
    const ev = await novoEvento(m.f);
    await criarEEntregar(m.deps, projetoExemplo, ev);

    expect(m.envios).toHaveLength(1);
    const e = m.envios[0]!;
    expect(e.url).toBe(projetoExemplo.callback_url);
    expect(e.headers['X-Zito-Event-Id']).toBe(ev.id);
    const [t, v1] = e.headers['X-Zito-Signature']!.split(',').map((p) => p.split('=')[1]!);
    expect(v1).toBe(createHmac('sha256', projetoExemplo.callback_secret).update(`${t}.${e.body}`).digest('hex'));
    const corpo = JSON.parse(e.body);
    expect(corpo).toMatchObject({ id: ev.id, event: 'payment.approved', customer_ref: 'loja-1', gateway: 'mercadopago', project_id: projetoExemplo.id });
    expect(corpo.data.payment.id).toBe('1');
    expect(corpo.data.subscription).toBeNull();
    expect(m.f.deliveries[0]).toMatchObject({ status: 'delivered', attempts: 1, last_status_code: 200 });
  });

  it('falha agenda a próxima tentativa em 1 min', async () => {
    const m = montar();
    m.set(500);
    const ev = await novoEvento(m.f);
    await criarEEntregar(m.deps, projetoExemplo, ev);
    const d = m.f.deliveries[0]!;
    expect(d).toMatchObject({ status: 'pending', attempts: 1, last_status_code: 500, last_error: 'HTTP 500' });
    expect(new Date(d.next_attempt_at).getTime()).toBe(new Date('2026-11-20T12:01:00Z').getTime());
  });

  it('timeout e erro de rede contam como falha, sem vazar detalhes', async () => {
    const m = montar();
    const e = new Error('segredo no texto'); e.name = 'TimeoutError';
    m.set(e);
    await criarEEntregar(m.deps, projetoExemplo, await novoEvento(m.f));
    expect(m.f.deliveries[0]!.last_error).toBe('timeout');
  });

  it('segue a escada 1 min, 5 min, 15 min, 1 h, 6 h, 24 h e na 7ª falha vira failed', async () => {
    const m = montar();
    m.set(503);
    await criarEEntregar(m.deps, projetoExemplo, await novoEvento(m.f));
    const d = m.f.deliveries[0]!;
    for (let i = 1; i <= 6; i++) {
      expect(d.status).toBe('pending');
      expect(new Date(d.next_attempt_at).getTime() - m.deps.agora().getTime()).toBe(ESPERAS_MS[i - 1]);
      m.avancar(ESPERAS_MS[i - 1]!);
      expect(await processarFila(m.deps)).toBe(1);
    }
    expect(d).toMatchObject({ status: 'failed', attempts: 7 });
    expect(m.envios).toHaveLength(7);
    expect(await processarFila(m.deps)).toBe(0);
  });

  it('a fila reenvia o mesmo corpo (assinatura refeita) e entrega no sucesso', async () => {
    const m = montar();
    m.set(500);
    await criarEEntregar(m.deps, projetoExemplo, await novoEvento(m.f));
    m.set(200);
    expect(await processarFila(m.deps)).toBe(0); // ainda não venceu
    m.avancar(61_000);
    expect(await processarFila(m.deps)).toBe(1);
    expect(m.envios[1]!.body).toBe(m.envios[0]!.body);
    expect(m.envios[1]!.headers['X-Zito-Event-Id']).toBe(m.envios[0]!.headers['X-Zito-Event-Id']);
    expect(m.envios[1]!.headers['X-Zito-Signature']).not.toBe(m.envios[0]!.headers['X-Zito-Signature']);
    expect(m.f.deliveries[0]).toMatchObject({ status: 'delivered', attempts: 2 });
  });

  it('dois ciclos seguidos não enviam a mesma entrega duas vezes', async () => {
    const m = montar();
    m.set(500);
    await criarEEntregar(m.deps, projetoExemplo, await novoEvento(m.f));
    m.avancar(61_000);
    const [a, b] = await Promise.all([processarFila(m.deps), processarFila(m.deps)]);
    expect(a + b).toBe(1);
  });

  it('montarCorpo é determinístico', async () => {
    const m = montar();
    const ev = await novoEvento(m.f);
    expect(montarCorpo(ev)).toBe(montarCorpo(ev));
  });
});
