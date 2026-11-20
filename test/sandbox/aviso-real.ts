/**
 * Confere se o aviso REAL do Mercado Pago (notification_url por recurso) chega assinado e se o hub aceita.
 * Sobe o hub local com repositório fake (sem Supabase), abre um túnel do cloudflared, cria assinaturas no
 * sandbox com notification_url apontando para o túnel e mostra o que chegou (sem segredos).
 *
 * RESULTADO (2026-11-20): a API de assinaturas (/preapproval) ignora o notification_url (não guarda o campo), então
 * nenhum aviso chega por aqui; para assinaturas só vale o webhook cadastrado no painel. Pagamentos (/v1/payments)
 * ficam bloqueados nessa conta de teste. O script fica para quando a conta permitir Pix.
 *
 *   SUPABASE_URL=http://localhost:1 SUPABASE_SERVICE_ROLE_KEY=falsa npx tsx test/sandbox/aviso-real.ts
 *   (as variáveis do Supabase são só para o import carregar; nada é chamado. NÃO use railway run.)
 */
import { execFile, spawn } from 'node:child_process';
import express from 'express';
import { createApp } from '../../src/app';
import { MercadoPagoClient } from '../../src/gateways/mercadopago/mercadopago.client';
import { MercadoPagoGateway } from '../../src/gateways/mercadopago/mercadopago.gateway';
import { StripeGateway } from '../../src/gateways/stripe/stripe.gateway';
import { fakeRepos, projetoExemplo } from '../helpers/fakes';
import { emailComprador, lerCredenciais } from './credenciais';

const cred = lerCredenciais();
const PORTA = 3901;
const PROJETO = 'teste';

async function main() {
  const f = fakeRepos({
    projects: [{ ...projetoExemplo, id: PROJETO, callback_url: `http://127.0.0.1:${PORTA}/_callback` }],
    configs: [{ id: 'c', project_id: PROJETO, gateway: 'mercadopago', config: { access_token: cred.access_token, webhook_secret: cred.webhook_secret, ambiente: 'teste' } }],
  });
  const build = (c: { config: Record<string, string> }) => new MercadoPagoGateway(c.config as never);
  const hub = createApp({
    repos: f.repos, entrega: { repos: f.repos }, buildMercadoPago: build,
    buildGateway: (c) => (c.gateway === 'mercadopago' ? build(c) : new StripeGateway(c.config as never)),
  });

  const log: string[] = [];
  const outer = express();
  outer.post('/_callback', express.json(), (req, res) => {
    log.push(`callback do hub: event=${req.body.event} customer_ref=${req.body.customer_ref} assinado=${String(req.headers['x-zito-signature'] ?? '').startsWith('t=')}`);
    res.sendStatus(200);
  });
  outer.use((req, res, next) => {
    if (req.path.startsWith('/webhook')) {
      const q = new URL(req.url, 'http://x').searchParams;
      const sig = String(req.headers['x-signature'] ?? '');
      const ts = /ts=(\d+)/.exec(sig)?.[1];
      res.on('finish', () =>
        log.push(
          `aviso: ${req.path} type=${q.get('type') ?? q.get('topic')} data.id=${q.get('data.id') ?? q.get('id')} ` +
            `x-signature=${sig ? 'sim' : 'NAO'} ts=${ts ? `${ts.length} digitos` : '-'} x-request-id=${req.headers['x-request-id'] ? 'sim' : 'NAO'} -> hub respondeu ${res.statusCode}`
        )
      );
    }
    next();
  });
  outer.use(hub);
  const server = outer.listen(PORTA);

  const tunel = spawn('cloudflared', ['tunnel', '--url', `http://localhost:${PORTA}`, '--no-autoupdate'], { stdio: ['ignore', 'pipe', 'pipe'] });
  const url = await new Promise<string>((resolve, reject) => {
    const t = setTimeout(() => reject(new Error('túnel não abriu')), 40000);
    const ler = (d: Buffer) => {
      const m = /https:\/\/(?!api\.)[a-z0-9-]+\.trycloudflare\.com/.exec(d.toString());
      if (m) { clearTimeout(t); resolve(m[0]); }
    };
    tunel.stdout.on('data', ler);
    tunel.stderr.on('data', ler);
  });
  console.log(`túnel aberto: ${new URL(url).host}`);
  // o túnel leva alguns segundos para propagar: espera responder de fora
  let no_ar = false;
  for (let i = 0; i < 20 && !no_ar; i++) {
    // curl assíncrono (o servidor precisa continuar respondendo). O resolvedor local às vezes não acha o nome
    // recém-criado, então resolve por fora (1.1.1.1) e fixa o IP no curl.
    const host = new URL(url).host;
    no_ar = await new Promise<boolean>((resolve) =>
      execFile('dig', ['+short', host, '@1.1.1.1'], (_e, ips) => {
        const ip = ips?.split('\n')[0]?.trim();
        if (!ip) return resolve(false);
        execFile('curl', ['-s', '-m', '8', '--resolve', `${host}:443:${ip}`, '-o', '/dev/null', '-w', '%{http_code}', `${url}/health`], (_e2, out) => resolve(out === '200'));
      })
    );
    if (!no_ar) await new Promise((r) => setTimeout(r, 3000));
  }
  console.log(`túnel responde de fora: ${no_ar}`);

  const notification_url = `${url}/webhook/mercadopago?project_id=${PROJETO}`;
  const client = new MercadoPagoClient(cred.access_token);
  const email = await emailComprador(cred);
  const ts = Date.now();

  const tk = await fetch(`https://api.mercadopago.com/v1/card_tokens?public_key=${encodeURIComponent(cred.public_key)}`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ card_number: '4235647728025682', security_code: '123', expiration_month: 11, expiration_year: 2030, cardholder: { name: 'APRO', identification: { type: 'CPF', number: '12345678909' } } }),
  });
  const card_token_id = ((await tk.json()) as { id: string }).id;

  const sub = await client.request<{ id: string }>('POST', '/preapproval', {
    body: {
      reason: 'Aviso real', external_reference: `aviso-${ts}`, payer_email: email, card_token_id, back_url: 'https://pagamentos.zitosolutions.com.br/sucesso',
      notification_url, status: 'authorized',
      auto_recurring: { frequency: 1, frequency_type: 'months', transaction_amount: 19.9, currency_id: 'BRL' },
    },
  });
  const bruta = await client.request<{ notification_url?: string }>('GET', `/preapproval/${sub.id}`);
  console.log(`assinatura criada com notification_url (o MP guardou: ${bruta.notification_url === notification_url})`);
  await new Promise((r) => setTimeout(r, 40000));
  await client.request('PUT', `/preapproval/${sub.id}`, { body: { status: 'cancelled' } });
  console.log('assinatura cancelada');
  await new Promise((r) => setTimeout(r, 90000));

  console.log('--- o que chegou ---');
  log.forEach((l) => console.log(l));
  console.log(`eventos gravados no hub: ${f.events.map((e) => e.event_type).join(', ') || '(nenhum)'}`);
  tunel.kill();
  server.close();
  process.exit(0);
}

main().catch((e) => { console.error('erro:', e instanceof Error ? e.message : e); process.exit(1); });
