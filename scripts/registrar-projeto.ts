/**
 * Registra um projeto no hub e a config do Mercado Pago (cifrada).
 *
 *   railway run --service be-zito-payments npx ts-node scripts/registrar-projeto.ts \
 *     --nome Dittu --callback-url https://api.dittu.com.br/webhooks/zito-payments \
 *     --credenciais ~/.dittu-mp-teste.env --saida ~/.dittu-zito-payments.env \
 *     [--id <uuid fixo>]
 *
 * Grava ZITO_PAYMENTS_PROJECT_ID, ZITO_PAYMENTS_API_KEY e ZITO_PAYMENTS_CALLBACK_SECRET no arquivo de
 * saída (permissão 600). Imprime só o id do projeto.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { parse } from 'dotenv';
import { encrypt } from '../src/crypto/config.crypto';
import { getSupabaseRepos } from '../src/repositories';
import { registrarProjeto } from '../src/registro/registrar';

function args(): Record<string, string> {
  const out: Record<string, string> = {};
  const a = process.argv.slice(2);
  for (let i = 0; i < a.length; i += 2) {
    const k = a[i];
    const v = a[i + 1];
    if (!k?.startsWith('--') || v === undefined) throw new Error(`Argumento inválido: ${k}`);
    out[k.slice(2)] = v;
  }
  return out;
}

const caminho = (p: string) => (p.startsWith('~') ? path.join(os.homedir(), p.slice(1)) : path.resolve(p));

async function main(): Promise<void> {
  const a = args();
  for (const k of ['nome', 'callback-url', 'credenciais', 'saida']) {
    if (!a[k]) throw new Error(`Faltou --${k}`);
  }

  const arquivoCred = caminho(a['credenciais']!);
  if ((fs.statSync(arquivoCred).mode & 0o077) !== 0) {
    throw new Error('O arquivo de credenciais precisa ter permissão 600');
  }
  const env = parse(fs.readFileSync(arquivoCred));
  const access_token = env['MP_ACCESS_TOKEN'];
  const webhook_secret = env['MP_WEBHOOK_SECRET'];
  const ambiente = env['MP_AMBIENTE'];
  if (!access_token || !webhook_secret) throw new Error('Credenciais sem MP_ACCESS_TOKEN ou MP_WEBHOOK_SECRET');
  if (ambiente !== 'teste' && ambiente !== 'producao') throw new Error('MP_AMBIENTE deve ser "teste" ou "producao"');

  const r = await registrarProjeto({
    repos: getSupabaseRepos(),
    nome: a['nome']!,
    callbackUrl: a['callback-url']!,
    id: a['id'],
    credenciais: { access_token, webhook_secret, ambiente },
    encrypt,
  });

  const saida = caminho(a['saida']!);
  fs.writeFileSync(
    saida,
    `ZITO_PAYMENTS_PROJECT_ID=${r.projectId}\nZITO_PAYMENTS_API_KEY=${r.apiKey}\nZITO_PAYMENTS_CALLBACK_SECRET=${r.callbackSecret}\n`,
    { mode: 0o600 }
  );
  fs.chmodSync(saida, 0o600);

  console.log(`projeto ${a['nome']} registrado: ${r.projectId}`);
}

main().catch((err) => {
  console.error(`Erro: ${err instanceof Error ? err.message : 'falha'}`);
  process.exit(1);
});
