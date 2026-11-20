import { randomBytes } from 'crypto';
import { Repos } from '../repositories/types';

export interface CredenciaisMP {
  access_token: string;
  webhook_secret: string;
  ambiente: 'teste' | 'producao';
}

export interface RegistrarParams {
  repos: Pick<Repos, 'projects' | 'configs'>;
  nome: string;
  callbackUrl: string;
  /** id fixo opcional (uuid) para um projeto novo; o webhook do MP já pode apontar para ele. */
  id?: string;
  credenciais: CredenciaisMP;
  encrypt: (texto: string) => string;
}

export interface Registrado {
  projectId: string;
  apiKey: string;
  callbackSecret: string;
  novo: boolean;
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Cria (ou atualiza, pelo nome) o projeto e troca a config mercadopago por uma nova cifrada. */
export async function registrarProjeto(p: RegistrarParams): Promise<Registrado> {
  if (p.id && !UUID.test(p.id)) throw new Error('--id precisa ser um uuid');

  let projeto = await p.repos.projects.findByName(p.nome);
  let novo = false;

  if (projeto) {
    if (p.id && projeto.id !== p.id) {
      throw new Error(`O projeto "${p.nome}" já existe com outro id; não vou trocar o id`);
    }
    if (projeto.callback_url !== p.callbackUrl) {
      await p.repos.projects.updateCallbackUrl(projeto.id, p.callbackUrl);
    }
  } else {
    if (p.id && (await p.repos.projects.findById(p.id))) {
      throw new Error('Já existe outro projeto com esse id');
    }
    projeto = await p.repos.projects.create({
      ...(p.id ? { id: p.id } : {}),
      name: p.nome,
      api_key: randomBytes(32).toString('hex'),
      callback_url: p.callbackUrl,
    });
    novo = true;
  }

  await p.repos.configs.deactivateAll(projeto.id, 'mercadopago');
  await p.repos.configs.insertEncrypted(projeto.id, 'mercadopago', p.encrypt(JSON.stringify(p.credenciais)));

  return { projectId: projeto.id, apiKey: projeto.api_key, callbackSecret: projeto.callback_secret, novo };
}
