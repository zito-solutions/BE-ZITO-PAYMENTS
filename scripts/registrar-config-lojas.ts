/**
 * Registra a config `mercadopago_lojas` (aplicação "Dittu Lojas", OAuth das lojistas) de um projeto, cifrada.
 *
 *   railway run --service be-zito-payments npx ts-node scripts/registrar-config-lojas.ts \
 *     --projeto <id do projeto> --credenciais ~/.dittu-mp-lojas-teste.env
 *
 * O arquivo (permissão 600) tem MP_LOJAS_AMBIENTE, MP_LOJAS_CLIENT_ID, MP_LOJAS_CLIENT_SECRET,
 * MP_LOJAS_WEBHOOK_SECRET e MP_LOJAS_REDIRECT_URI. Imprime só o id do projeto e o ambiente.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { parse } from 'dotenv';
import { encrypt } from '../src/crypto/config.crypto';
import { getSupabaseRepos } from '../src/repositories';
import { lerCredenciaisLojas, permissaoOk, registrarConfigLojas } from '../src/registro/registrar-lojas';

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
  for (const k of ['projeto', 'credenciais']) {
    if (!a[k]) throw new Error(`Faltou --${k}`);
  }
  const arquivo = caminho(a['credenciais']!);
  if (!permissaoOk(fs.statSync(arquivo).mode)) throw new Error('O arquivo de credenciais precisa ter permissão 600');
  const credenciais = lerCredenciaisLojas(parse(fs.readFileSync(arquivo)));

  console.log(await registrarConfigLojas({ repos: getSupabaseRepos(), projectId: a['projeto']!, credenciais, encrypt }));
}

main().catch((err) => {
  console.error(`Erro: ${err instanceof Error ? err.message : 'falha'}`);
  process.exit(1);
});
