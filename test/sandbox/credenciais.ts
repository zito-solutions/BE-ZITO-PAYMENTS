import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { parse } from 'dotenv';

export interface CredenciaisSandbox {
  access_token: string;
  public_key: string;
  webhook_secret: string;
  payer_email?: string;
}

/** Lê ~/.dittu-mp-teste.env. Recusa permissão aberta e ambiente diferente de "teste". Nunca imprime valores. */
export function lerCredenciais(): CredenciaisSandbox {
  const arquivo = path.join(os.homedir(), '.dittu-mp-teste.env');
  if ((fs.statSync(arquivo).mode & 0o077) !== 0) throw new Error('~/.dittu-mp-teste.env precisa ter permissão 600');
  const env = parse(fs.readFileSync(arquivo));
  if (env['MP_AMBIENTE'] !== 'teste') throw new Error('MP_AMBIENTE precisa ser "teste"');
  for (const k of ['MP_ACCESS_TOKEN', 'MP_PUBLIC_KEY', 'MP_WEBHOOK_SECRET']) {
    if (!env[k]) throw new Error(`Faltou ${k} no arquivo de credenciais`);
  }
  return {
    access_token: env['MP_ACCESS_TOKEN']!,
    public_key: env['MP_PUBLIC_KEY']!,
    webhook_secret: env['MP_WEBHOOK_SECRET']!,
    payer_email: env['MP_PAYER_EMAIL'] ?? process.env['MP_PAYER_EMAIL'],
  };
}

const ARQUIVO_COMPRADOR = path.join(os.homedir(), '.dittu-mp-comprador-teste.env');

/**
 * E-mail do comprador de teste. O sandbox só aceita pagador que seja usuário de teste do MP.
 * Ordem: MP_PAYER_EMAIL (ambiente ou arquivo de credenciais) -> ~/.dittu-mp-comprador-teste.env ->
 * cria um usuário de teste (POST /users/test_user, o token de vendedor de teste pode) e guarda nesse arquivo (600).
 */
export async function emailComprador(cred: CredenciaisSandbox): Promise<string> {
  if (cred.payer_email) return cred.payer_email;
  if (fs.existsSync(ARQUIVO_COMPRADOR)) {
    const e = parse(fs.readFileSync(ARQUIVO_COMPRADOR))['MP_PAYER_EMAIL'];
    if (e) return e;
  }
  const res = await fetch('https://api.mercadopago.com/users/test_user', {
    method: 'POST',
    headers: { Authorization: `Bearer ${cred.access_token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ site_id: 'MLB' }),
  });
  const j = (await res.json()) as { email?: string };
  if (!res.ok || !j.email) throw new Error(`Não consegui criar um comprador de teste (HTTP ${res.status}); ponha MP_PAYER_EMAIL`);
  fs.writeFileSync(ARQUIVO_COMPRADOR, `MP_PAYER_EMAIL=${j.email}\n`, { mode: 0o600 });
  return j.email;
}
