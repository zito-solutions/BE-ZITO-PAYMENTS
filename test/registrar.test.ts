import { describe, expect, it } from 'vitest';
import { registrarProjeto } from '../src/registro/registrar';
import { fakeRepos, projetoExemplo } from './helpers/fakes';

const credenciais = { access_token: 'tok', webhook_secret: 'seg', ambiente: 'teste' as const };
const encrypt = (t: string) => `cifrado(${t.length})`;

describe('registrarProjeto', () => {
  it('cria projeto novo com id fixo opcional e config cifrada', async () => {
    const f = fakeRepos();
    const id = 'dbc14d97-bb12-44bb-8f3d-39f7201a3f43';
    const r = await registrarProjeto({ repos: f.repos, nome: 'Dittu', callbackUrl: 'https://api.dittu.com.br/webhooks/zito-payments', id, credenciais, encrypt });
    expect(r).toMatchObject({ projectId: id, novo: true });
    expect(r.apiKey).toMatch(/^[0-9a-f]{64}$/);
    expect(f.configs).toHaveLength(1);
    expect(f.configs[0]).toMatchObject({ project_id: id, gateway: 'mercadopago', is_active: true });
  });

  it('sem id gera um uuid', async () => {
    const f = fakeRepos();
    const r = await registrarProjeto({ repos: f.repos, nome: 'Dittu', callbackUrl: 'https://x', credenciais, encrypt });
    expect(r.projectId).toMatch(/^[0-9a-f-]{36}$/);
  });

  it('projeto existente: mantém chaves, atualiza a URL e desativa a config antiga', async () => {
    const f = fakeRepos({ projects: [{ ...projetoExemplo }], configs: [{ id: 'velha', project_id: projetoExemplo.id, gateway: 'mercadopago', config: {} }] });
    const r = await registrarProjeto({ repos: f.repos, nome: 'Dittu', callbackUrl: 'https://nova', credenciais, encrypt });
    expect(r).toMatchObject({ projectId: projetoExemplo.id, apiKey: projetoExemplo.api_key, callbackSecret: projetoExemplo.callback_secret, novo: false });
    expect(f.projects[0]!.callback_url).toBe('https://nova');
    expect(f.configs.filter((c) => c.is_active)).toHaveLength(1);
    expect(f.configs[0]!.is_active).toBe(false);
  });

  it('recusa id que não é uuid e id diferente do projeto existente', async () => {
    const f = fakeRepos({ projects: [{ ...projetoExemplo }] });
    await expect(registrarProjeto({ repos: f.repos, nome: 'Novo', callbackUrl: 'x', id: 'abc', credenciais, encrypt })).rejects.toThrow('uuid');
    await expect(
      registrarProjeto({ repos: f.repos, nome: 'Dittu', callbackUrl: 'x', id: 'dbc14d97-bb12-44bb-8f3d-39f7201a3f43', credenciais, encrypt })
    ).rejects.toThrow('outro id');
  });
});
