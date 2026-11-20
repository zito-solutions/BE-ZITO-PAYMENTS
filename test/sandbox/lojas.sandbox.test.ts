import { describe, expect, it } from 'vitest';
import { GATEWAY_LOJAS, lerConfigLojas } from '../../src/contas/contas';
import { buildCheckoutLojas } from '../../src/gateways/mercadopago/lojas';

// Roda só com MP_LOJAS_SELLER_ACCOUNT_REF (a conta da vendedora de teste já conectada).
// Uso: railway run --service be-zito-payments npm run test:sandbox:lojas
// Variáveis opcionais: MP_LOJAS_PROJECT_NAME (padrão "Dittu").
const ref = process.env['MP_LOJAS_SELLER_ACCOUNT_REF'];

describe.skipIf(!ref)('checkout das lojas no sandbox (TASK-394)', () => {
  it('cria uma preferência de R$ 1,00 e consulta por referência (lista vazia)', async () => {
    const { getSupabaseRepos } = await import('../../src/repositories');
    const repos = getSupabaseRepos();
    const projeto = await repos.projects.findByName(process.env['MP_LOJAS_PROJECT_NAME'] ?? 'Dittu');
    if (!projeto) throw new Error('projeto não encontrado');
    const cfg = lerConfigLojas(await repos.configs.findActive(projeto.id, GATEWAY_LOJAS));
    if (!cfg) throw new Error('projeto sem config mercadopago_lojas');
    const conta = await repos.accounts.findByRef(projeto.id, ref!);
    if (!conta || conta.status !== 'connected' || !conta.access_token) throw new Error('conta não conectada');

    const lojas = buildCheckoutLojas(cfg.ambiente, conta.access_token);
    const reference = `sandbox-lojas-${Date.now()}`;
    const pref = await lojas.criarPreferencia(
      {
        account_ref: ref!,
        reference,
        items: [{ title: 'Teste do hub', quantity: 1, unit_price_cents: 100 }],
        shipping_cents: 0,
        payer: { name: 'Cliente Ficticia' },
        back_url: 'https://pagamentos.zitosolutions.com.br/sucesso',
        expires_at: new Date(Date.now() + 60 * 60_000).toISOString(),
        max_installments: 1,
      },
      { project_id: projeto.id, account_ref: ref!, base: new URL(cfg.redirect_uri).origin }
    );
    expect(pref.id).toBeTruthy();
    expect(await lojas.buscarPorReferencia(reference, ref!)).toEqual([]);
    console.log(`preferência criada: ${pref.id} (${pref.ambiente})`);
  });
});
