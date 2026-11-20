import fs from 'node:fs';
import path from 'node:path';
import { beforeAll, describe, expect, it } from 'vitest';
import { MercadoPagoClient, MercadoPagoError } from '../../src/gateways/mercadopago/mercadopago.client';
import { MercadoPagoGateway } from '../../src/gateways/mercadopago/mercadopago.gateway';
import { emailComprador, lerCredenciais } from './credenciais';

const cred = lerCredenciais();
const client = new MercadoPagoClient(cred.access_token);
const mp = new MercadoPagoGateway({ access_token: cred.access_token, webhook_secret: cred.webhook_secret, ambiente: 'teste' }, client);

const ts = Date.now();
let email = '';
const back_url = 'https://pagamentos.zitosolutions.com.br/sucesso';
const OBS: Record<string, unknown> = {};
const SAIDA = process.env['SANDBOX_SAIDA']; // pasta opcional para guardar as respostas (sem segredos)

function guardar(nome: string, valor: unknown) {
  OBS[nome] = valor;
  if (SAIDA) {
    fs.mkdirSync(SAIDA, { recursive: true });
    fs.writeFileSync(path.join(SAIDA, `${nome}.json`), JSON.stringify(valor, null, 2));
  }
}

// Visa de teste: o Mastercard 5031 4332 1540 6351 é recusado para recorrência (Unsupported_credit_card_for_recurring_payment)
async function tokenCartao(titular: string, numero = '4235647728025682'): Promise<string> {
  const res = await fetch(`https://api.mercadopago.com/v1/card_tokens?public_key=${encodeURIComponent(cred.public_key)}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      card_number: numero,
      security_code: '123',
      expiration_month: 11,
      expiration_year: 2030,
      cardholder: { name: titular, identification: { type: 'CPF', number: '12345678909' } },
    }),
  });
  const j = (await res.json()) as { id?: string; message?: string };
  if (!res.ok || !j.id) throw new Error(`card_token falhou: ${res.status} ${j.message}`);
  return j.id;
}

describe('sandbox do Mercado Pago (rede)', () => {
  beforeAll(async () => {
    email = await emailComprador(cred);
  });

  let planoId = '';
  let assinaturaId = '';
  let pendenteId = '';
  let pixId = '';

  it('cria plano', async () => {
    const plano = await mp.criarPlano({ reason: 'Teste hub Zito', amount_cents: 1990, frequency_months: 1, back_url });
    guardar('plano', plano);
    expect(plano.id).toBeTruthy();
    planoId = plano.id;
  });

  it('assinatura com cartão aprovado (APRO)', async () => {
    const card_token_id = await tokenCartao('APRO');
    const s = await mp.criarAssinaturaComCartao({ reference: `sandbox-apro-${ts}`, payer_email: email, plan_id: planoId, card_token_id });
    guardar('assinatura_cartao_apro', s);
    guardar('assinatura_cartao_apro_bruta', await mp.obterAssinaturaBruta(s.id));
    expect(s.status).toBe('authorized');
    assinaturaId = s.id;
  });

  it('assinatura com cartão recusado (OTHE)', async () => {
    const card_token_id = await tokenCartao('OTHE');
    try {
      const s = await mp.criarAssinaturaComCartao({ reference: `sandbox-othe-${ts}`, payer_email: email, plan_id: planoId, card_token_id });
      guardar('assinatura_cartao_othe', s);
    } catch (e) {
      guardar('assinatura_cartao_othe_erro', e instanceof MercadoPagoError ? { status: e.status, code: e.code, message: e.message } : String(e));
    }
  });

  it('consulta por id e por referência', async () => {
    const s = await mp.obterAssinatura(assinaturaId);
    expect(s.id).toBe(assinaturaId);
    // a busca por referência é indexada com atraso: tenta por até ~30 s
    let porRef = null;
    for (let i = 0; i < 10 && !porRef; i++) {
      porRef = await mp.buscarAssinaturaPorReferencia(`sandbox-apro-${ts}`);
      if (!porRef) await new Promise((r) => setTimeout(r, 3000));
    }
    guardar('busca_por_referencia', porRef);
    expect(porRef?.id).toBe(assinaturaId);
  });

  it('atualiza o valor', async () => {
    const s = await mp.atualizarValor(assinaturaId, 2490);
    guardar('assinatura_atualizada', s);
    expect(s.amount_cents).toBe(2490);
  });

  it('cancela (e cancelar de novo devolve igual)', async () => {
    const s = await mp.cancelarAssinatura(assinaturaId);
    guardar('assinatura_cancelada', s);
    expect(s.status).toBe('cancelled');
    expect((await mp.cancelarAssinatura(assinaturaId)).status).toBe('cancelled');
  });

  it('assinatura pendente com init_point', async () => {
    const s = await mp.criarAssinaturaPendente({
      reference: `sandbox-pend-${ts}`, payer_email: email, reason: 'Dittu teste', amount_cents: 1990, frequency_months: 1, back_url,
    });
    guardar('assinatura_pendente', s);
    expect(s.status).toBe('pending');
    expect(s.init_point).toBeTruthy();
    pendenteId = s.id;
  });

  it('assinatura pendente com start_date daqui a 30 dias', async () => {
    try {
      const s = await mp.criarAssinaturaPendente({
        reference: `sandbox-start-${ts}`, payer_email: email, reason: 'Dittu teste', amount_cents: 1990, frequency_months: 1, back_url,
        start_date: new Date(Date.now() + 30 * 86400_000).toISOString(),
      });
      guardar('assinatura_start_date', { aceito: true, bruta: await mp.obterAssinaturaBruta(s.id) });
    } catch (e) {
      guardar('assinatura_start_date', { aceito: false, erro: e instanceof MercadoPagoError ? { status: e.status, code: e.code, message: e.message } : String(e) });
    }
  });

  it('Pix com expiração de 30 min e idempotência (o sandbox desta conta bloqueia /v1/payments)', async () => {
    const dados = {
      reference: `sandbox-pix-${ts}`, payer_email: email, description: 'Teste Pix', amount_cents: 1990,
      expires_at: new Date(Date.now() + 30 * 60_000).toISOString(), idempotency_key: `idem-${ts}`,
    };
    try {
      const a = await mp.criarPix(dados);
      const b = await mp.criarPix(dados);
      guardar('pix', a);
      guardar('pix_bruto', await mp.obterPagamentoBruto(a.id));
      expect(a.pix?.qr_code).toBeTruthy();
      expect(b.id).toBe(a.id);
      pixId = a.id;
    } catch (e) {
      // sandbox: "Unauthorized use of live credentials" (401) e o método pix nem aparece em /v1/payment_methods
      expect(e).toBeInstanceOf(MercadoPagoError);
      guardar('pix_bloqueado', { status: (e as MercadoPagoError).status, message: (e as MercadoPagoError).message });
    }
  });

  it('consulta o Pix pelo id (se o sandbox deixou criar)', async () => {
    if (!pixId) return;
    const p = await mp.obterPagamento(pixId);
    expect(p.status).toBe('pending');
  });

  it('pagamento da 1ª parcela da assinatura aprovada: status, taxa, subscription_id e reembolso', async () => {
    // a cobrança da 1ª parcela aparece alguns segundos depois da autorização
    type Lista = { results: Array<{ id: number; payment?: { id: number } }> };
    let lista: Lista = { results: [] };
    for (let i = 0; i < 10 && !lista.results[0]?.payment?.id; i++) {
      lista = await client.request<Lista>('GET', '/authorized_payments/search', { query: { preapproval_id: assinaturaId } });
      if (!lista.results[0]?.payment?.id) await new Promise((r) => setTimeout(r, 3000));
    }
    guardar('cobrancas_da_assinatura', lista);
    const pagamentoId = String(lista.results[0]?.payment?.id ?? '');
    expect(pagamentoId).toBeTruthy();
    const p = await mp.obterPagamento(pagamentoId);
    guardar('pagamento_parcela', p);
    guardar('pagamento_parcela_bruto', await mp.obterPagamentoBruto(pagamentoId));
    try {
      guardar('cobranca_bruta', await mp.obterPagamentoDeAssinaturaBruto(String(lista.results[0]!.id)));
    } catch {
      /* só registro: a cobrança às vezes demora a ser lida pelo id */
    }
    expect(p.status).toBe('approved');
    expect(p.subscription_id).toBe(assinaturaId);
    expect(p.fee_cents).toBeGreaterThan(0);
    try {
      guardar('reembolso_parcela', await mp.reembolsar(pagamentoId, `refund-${ts}`));
    } catch (e) {
      guardar('reembolso_parcela_erro', { status: (e as MercadoPagoError).status, message: (e as MercadoPagoError).message });
    }
  });

  it('GET de assinatura inexistente dá 404 tratado', async () => {
    await expect(mp.obterAssinatura('0123456789abcdef0123456789abcdef')).rejects.toBeInstanceOf(MercadoPagoError);
    expect(pendenteId).toBeTruthy();
  });
});
