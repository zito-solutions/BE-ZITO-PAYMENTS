import { Repos } from '../repositories/types';

export const CHAVES_LOJAS = [
  'MP_LOJAS_AMBIENTE',
  'MP_LOJAS_CLIENT_ID',
  'MP_LOJAS_CLIENT_SECRET',
  'MP_LOJAS_WEBHOOK_SECRET',
  'MP_LOJAS_REDIRECT_URI',
] as const;

export interface CredenciaisLojas {
  client_id: string;
  client_secret: string;
  webhook_secret: string;
  ambiente: 'teste' | 'producao';
  redirect_uri: string;
}

/** O arquivo só pode ser do dono: nenhuma permissão para grupo ou outros. */
export function permissaoOk(mode: number): boolean {
  return (mode & 0o077) === 0;
}

/** Valida as chaves do arquivo (já lido com dotenv.parse). Nunca devolve valor no erro. */
export function lerCredenciaisLojas(env: Record<string, string | undefined>): CredenciaisLojas {
  const faltando = CHAVES_LOJAS.filter((k) => !env[k]);
  if (faltando.length) throw new Error(`Credenciais sem: ${faltando.join(', ')}`);
  const ambiente = env['MP_LOJAS_AMBIENTE'];
  if (ambiente !== 'teste' && ambiente !== 'producao') throw new Error('MP_LOJAS_AMBIENTE deve ser "teste" ou "producao"');
  let redirect: URL;
  try {
    redirect = new URL(env['MP_LOJAS_REDIRECT_URI']!);
  } catch {
    throw new Error('MP_LOJAS_REDIRECT_URI não é uma URL');
  }
  if (redirect.protocol !== 'https:') throw new Error('MP_LOJAS_REDIRECT_URI precisa ser https');
  return {
    client_id: env['MP_LOJAS_CLIENT_ID']!,
    client_secret: env['MP_LOJAS_CLIENT_SECRET']!,
    webhook_secret: env['MP_LOJAS_WEBHOOK_SECRET']!,
    ambiente,
    redirect_uri: env['MP_LOJAS_REDIRECT_URI']!,
  };
}

/** Desativa as configs `mercadopago_lojas` antigas do projeto e grava a nova cifrada. */
export async function registrarConfigLojas(p: {
  repos: Pick<Repos, 'projects' | 'configs'>;
  projectId: string;
  credenciais: CredenciaisLojas;
  encrypt: (texto: string) => string;
}): Promise<string> {
  const projeto = await p.repos.projects.findById(p.projectId);
  if (!projeto) throw new Error('Projeto não encontrado');
  await p.repos.configs.deactivateAll(projeto.id, 'mercadopago_lojas');
  await p.repos.configs.insertEncrypted(projeto.id, 'mercadopago_lojas', p.encrypt(JSON.stringify(p.credenciais)));
  return `config mercadopago_lojas registrada para o projeto ${projeto.id} (${p.credenciais.ambiente})`;
}
