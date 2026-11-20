import { describe, expect, it } from 'vitest';
import { lerCredenciaisLojas, permissaoOk, registrarConfigLojas } from '../src/registro/registrar-lojas';
import { fakeRepos, projetoExemplo } from './helpers/fakes';

const env = {
  MP_LOJAS_AMBIENTE: 'teste', MP_LOJAS_CLIENT_ID: '1', MP_LOJAS_CLIENT_SECRET: 's', MP_LOJAS_WEBHOOK_SECRET: 'w',
  MP_LOJAS_REDIRECT_URI: 'https://pagamentos.zitosolutions.com.br/oauth/mercadopago/retorno',
};

describe('registrar config das lojas', () => {
  it('recusa permissão mais aberta que 600', () => {
    expect(permissaoOk(0o600)).toBe(true);
    expect(permissaoOk(0o400)).toBe(true);
    expect(permissaoOk(0o640)).toBe(false);
    expect(permissaoOk(0o644)).toBe(false);
  });

  it('recusa chave faltando sem imprimir valores', () => {
    const { MP_LOJAS_CLIENT_SECRET: _, ...resto } = env;
    expect(() => lerCredenciaisLojas(resto)).toThrow('MP_LOJAS_CLIENT_SECRET');
    expect(() => lerCredenciaisLojas({ ...env, MP_LOJAS_AMBIENTE: 'x' })).toThrow(/AMBIENTE/);
    expect(() => lerCredenciaisLojas({ ...env, MP_LOJAS_REDIRECT_URI: 'http://x.com' })).toThrow(/https/);
  });

  it('desativa a config antiga e grava a nova cifrada; a mensagem só tem id e ambiente', async () => {
    const f = fakeRepos({ projects: [{ ...projetoExemplo }], configs: [{ id: 'velha', project_id: projetoExemplo.id, gateway: 'mercadopago_lojas', config: {} }] });
    const msg = await registrarConfigLojas({
      repos: f.repos, projectId: projetoExemplo.id, credenciais: lerCredenciaisLojas(env), encrypt: (t) => `cifrado(${t.length})`,
    });
    expect(msg).toBe(`config mercadopago_lojas registrada para o projeto ${projetoExemplo.id} (teste)`);
    const ativas = f.configs.filter((c) => c.is_active && c.gateway === 'mercadopago_lojas');
    expect(ativas).toHaveLength(1);
    expect(ativas[0]!.id).not.toBe('velha');
    await expect(registrarConfigLojas({ repos: f.repos, projectId: 'nao-existe', credenciais: lerCredenciaisLojas(env), encrypt: (t) => t })).rejects.toThrow();
  });
});
