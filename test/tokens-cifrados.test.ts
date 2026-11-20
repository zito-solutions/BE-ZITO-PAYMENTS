import { beforeAll, describe, expect, it, vi } from 'vitest';

const gravado: Record<string, unknown>[] = [];
vi.mock('../src/database/supabase.client', () => {
  const cadeia = (linha?: () => unknown): unknown =>
    new Proxy(() => {}, {
      get: (_t, p) => (p === 'then' ? undefined : p === 'single' ? async () => ({ data: linha?.(), error: null }) : cadeia(linha)),
      apply: () => cadeia(linha),
    });
  return {
    supabase: {
      schema: () => ({
        from: () => ({
          upsert: (row: Record<string, unknown>) => { gravado.push(row); return cadeia(() => row); },
        }),
      }),
    },
  };
});

describe('repositório Supabase das contas', () => {
  beforeAll(() => { process.env['ENCRYPTION_KEY'] = 'k'.repeat(32); });

  it('grava os tokens cifrados e devolve em texto puro para o código', async () => {
    const { supabaseRepos } = await import('../src/repositories/supabase');
    const conta = await supabaseRepos.accounts.upsertConnected({
      project_id: 'p', account_ref: 'loja-1', mp_user_id: '1', access_token: 'APP_USR-acesso', refresh_token: 'TG-refresh',
      public_key: 'pk', expires_at: new Date().toISOString(), connected_at: new Date().toISOString(),
    });
    const linha = gravado[0]!;
    expect(String(linha['access_token'])).not.toContain('APP_USR');
    expect(String(linha['refresh_token'])).not.toContain('TG-refresh');
    expect(String(linha['access_token'])).toMatch(/^[0-9a-f]{32}:[0-9a-f]+$/);
    expect(conta).toMatchObject({ access_token: 'APP_USR-acesso', refresh_token: 'TG-refresh' });
  });
});
