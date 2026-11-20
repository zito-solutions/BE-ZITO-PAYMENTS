import { Repos } from './types';

export * from './types';

/** O Supabase só é carregado quando alguém pede os repositórios reais (os testes passam um fake). */
export function getSupabaseRepos(): Repos {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  return (require('./supabase') as typeof import('./supabase')).supabaseRepos;
}
