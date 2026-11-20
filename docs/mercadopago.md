# Mercado Pago no hub

O hub (`BE-ZITO-PAYMENTS`) fala com o Mercado Pago (MP) em nome dos projetos. Nenhum projeto guarda credencial do MP nem chama a API dele: chama o hub com a `api_key` do projeto e recebe callbacks assinados.

Endereço fixo do hub: `https://pagamentos.zitosolutions.com.br` (também em `https://be-zito-payments-production.up.railway.app`).

## Contrato com os projetos (fonte da verdade)

### API do hub
Todas as rotas abaixo: JSON, cabeçalho **`x-api-key: <api_key do projeto>`**, gateway **`mercadopago`** (a config ativa do projeto com `gateway = 'mercadopago'`; sem ela → 409 `{ "error": "gateway_not_configured" }`). Valores sempre em **centavos inteiros**; datas ISO 8601. Erros: `{ "error": "<codigo>", "message": "<texto curto>" }` com 400 (validação), 401 (api_key), 404 (recurso), 409, 502 (`gateway_error`: o MP recusou ou caiu; `message` traz o `message` do MP, nunca o token).

| Método e rota | Corpo | Resposta |
|---|---|---|
| `POST /v1/subscriptions` | `{ reference, payer_email, reason, amount_cents, frequency_months: 1 \| 12, back_url, start_date? }` | **201** `Subscription` (com `init_point`) — `preapproval` **sem plano**, `status: pending`; a pessoa autoriza o cartão no checkout do MP |
| `POST /v1/plans` | `{ reason, amount_cents, frequency_months, back_url }` | **201** `{ id, init_point, status }` — `preapproval_plan` |
| `POST /v1/subscriptions/card` | `{ reference, payer_email, plan_id, card_token_id }` | **201** `Subscription` — `preapproval` com plano, `status: authorized` (cartão tokenizado no navegador do projeto) |
| `GET /v1/subscriptions/:id` | — | `Subscription` |
| `GET /v1/subscriptions?reference=...` | — | `Subscription` mais recente com esse `external_reference`, ou 404 |
| `PATCH /v1/subscriptions/:id` | `{ amount_cents }` | `Subscription` (vale a partir da próxima cobrança) |
| `POST /v1/subscriptions/:id/cancel` | — | `Subscription` (idempotente: já cancelada → 200 igual) |
| `POST /v1/pix` | `{ reference, payer_email, description, amount_cents, expires_at, idempotency_key }` | **201** `Payment` com `pix` |
| `GET /v1/payments/:id` | — | `Payment` |
| `POST /v1/payments/:id/refund` | `{ idempotency_key }` | `Payment` (integral) |
| `GET /v1/config` | — | `{ gateway: "mercadopago", ambiente: "teste" \| "producao" }` (o projeto usa para mostrar "modo de teste" antes de qualquer cobrança) |

```
Subscription = { id, reference, status: "pending" | "authorized" | "paused" | "cancelled", amount_cents,
                 frequency_months, payer_email, init_point: string | null, next_payment_date: string | null,
                 ambiente: "teste" | "producao" }
Payment      = { id, reference, status: "pending" | "approved" | "rejected" | "cancelled" | "expired" | "refunded" | "charged_back",
                 status_detail: string | null, amount_cents, fee_cents: number | null, method: "pix" | "credit_card" | "debit_card" | "other",
                 approved_at: string | null, subscription_id: string | null,
                 pix: { qr_code, qr_code_base64, expires_at } | null, ambiente }
```
`reference` = `external_reference` do MP. `status` do `Subscription` normaliza a grafia do MP (se o MP devolver `canceled`, o hub responde `cancelled`). `Payment.status` = o do MP, exceto Pix vencido (`cancelled` + `status_detail: expired`) que vira `expired`.

### Callback do hub para o projeto
`POST <projects.callback_url>`, `Content-Type: application/json`, com os cabeçalhos:
- `X-Zito-Event-Id: <id da entrega>` (uuid do `payment_events`; o mesmo em todas as tentativas)
- `X-Zito-Signature: t=<unix em segundos>,v1=<hex>` com `v1 = HMAC-SHA256(callback_secret do projeto, "<t>.<corpo cru>")`. O projeto recusa se `|agora − t| > 300 s` ou se não bater (comparação em tempo constante).

Corpo:
```
{
  "id": "<mesmo X-Zito-Event-Id>",
  "event": "subscription.activated" | "subscription.payment_approved" | "subscription.payment_failed" | "subscription.cancelled"
         | "payment.approved" | "payment.expired" | "payment.refunded",
  "customer_ref": "<reference>",
  "gateway": "mercadopago",
  "project_id": "<uuid>",
  "occurred_at": "<ISO>",
  "data": { "subscription": Subscription | null, "payment": Payment | null }
}
```
Os campos `event`, `customer_ref`, `gateway` e `project_id` continuam iguais aos de hoje (o callback do Stripe ganha `id`, `occurred_at`, `data` e os cabeçalhos, sem perder nada).
- Resposta **2xx** do projeto = entregue. Qualquer outra coisa ou timeout de 10 s = **nova tentativa**: 1 min, 5 min, 15 min, 1 h, 6 h, 24 h (7 tentativas no total), depois `failed`.
- O projeto deve ser idempotente pelo `id` (pode receber o mesmo evento mais de uma vez) e **não depender da ordem** (pode buscar o estado atual com `GET /v1/subscriptions/:id` ou `GET /v1/payments/:id`).

### Como o hub transforma o aviso do MP em evento
| Aviso do MP | O hub consulta | Evento | `gateway_event_id` (deduplicação) |
|---|---|---|---|
| `subscription_preapproval` | `GET /preapproval/{id}` | `authorized` → `subscription.activated`; `cancelled` → `subscription.cancelled`; outros → nenhum (200) | `mp:preapproval:<id>:<status>:<last_modified>` |
| `subscription_authorized_payment` | `GET /authorized_payments/{id}` e, se houver, `GET /v1/payments/{payment.id}` | pagamento `approved` → `subscription.payment_approved`; `rejected` → `subscription.payment_failed`; outros → nenhum | `mp:authorized_payment:<id>:<status do pagamento>` |
| `payment` | `GET /v1/payments/{id}` | de assinatura (tem `subscription_id`): só `refunded`/`charged_back` → `payment.refunded` (o resto vem pelo aviso de cima); avulso: `approved` → `payment.approved`; `expired` → `payment.expired`; `refunded`/`charged_back` → `payment.refunded`; outros → nenhum | `mp:payment:<id>:<status>` |


## Como o MP avisa o hub

`POST /webhook/mercadopago?project_id=<id do projeto>` (a URL é cadastrada no painel do MP). O hub:

1. acha o projeto pelo `project_id` e a config ativa `mercadopago` dele (`webhook_secret` cifrado);
2. valida o `x-signature` com esse segredo: manifesto `id:<data.id em minúsculas>;request-id:<x-request-id>;ts:<ts>;`, HMAC-SHA256 hex. **O `project_id` da query não entra na assinatura.** Falhou: 401. Janela do `ts`: 10 minutos;
3. consulta o recurso no MP (nunca confia no corpo do aviso) e gera o evento da tabela acima;
4. grava em `payment_events` (deduplicado por `gateway_event_id`), cria a entrega em `callback_deliveries` e tenta na hora;
5. erro ao consultar o MP: 500 (o MP tenta de novo). Recurso que o MP diz não existir (404, ex.: aviso de simulação do painel): 200 sem evento.

Falhas de entrega: `GET /v1/callbacks/failed` lista as `failed` do projeto e `POST /v1/callbacks/:id/retry` volta uma para `pending`. A fila (`setInterval` de 30 s no `src/index.ts`) reenvia as vencidas; cada envio refaz a assinatura com `t` novo e manda o mesmo corpo.

## Cadastrar um projeto e a config do MP

Depois do deploy, com as credenciais num arquivo `.env` de permissão 600 (`MP_AMBIENTE`, `MP_ACCESS_TOKEN`, `MP_PUBLIC_KEY`, `MP_WEBHOOK_SECRET`):

```
railway run --service be-zito-payments npx ts-node scripts/registrar-projeto.ts \
  --nome Dittu \
  --callback-url https://api.dittu.com.br/webhooks/zito-payments \
  --credenciais ~/.dittu-mp-teste.env \
  --saida ~/.dittu-zito-payments.env \
  [--id dbc14d97-bb12-44bb-8f3d-39f7201a3f43]
```

- Cria o projeto (ou atualiza a URL do callback se o `--nome` já existir), gera a `api_key` (32 bytes hex) se for novo e desativa as configs `mercadopago` antigas dele. O `callback_secret` nasce na migração (coluna com padrão aleatório).
- `--id` (opcional) fixa o id de um projeto novo, para o webhook do MP já poder apontar para ele antes do registro. Recusa id que já exista em outro projeto ou diferente do projeto de mesmo nome.
- Grava `ZITO_PAYMENTS_PROJECT_ID`, `ZITO_PAYMENTS_API_KEY` e `ZITO_PAYMENTS_CALLBACK_SECRET` no arquivo de `--saida` (permissão 600) e imprime só `projeto <nome> registrado: <project_id>`.
- Webhook no painel do MP: `https://pagamentos.zitosolutions.com.br/webhook/mercadopago?project_id=<project_id>` com "Planos e assinaturas" e "Pagamentos".

## Testes

- `npm test`: sem rede (assinatura, conversão, eventos, webhook, callback, rotas `/v1`, Stripe).
- `npm run test:sandbox`: rede, sandbox do MP. Lê `~/.dittu-mp-teste.env`; recusa permissão mais aberta que 600 e `MP_AMBIENTE` diferente de `teste`. Para o comprador de teste, exporte `MP_PAYER_EMAIL` (ou ponha no arquivo); sem ele o MP recusa assinatura pendente (ver abaixo). Com `SANDBOX_SAIDA=<pasta>` guarda as respostas para consulta.
- `test/sandbox/aviso-real.ts`: sobe o hub local com repositório fake e um túnel do cloudflared e confere o aviso real do MP.

## O que o sandbox mostrou (2026-11-20)

Rodado com `npm run test:sandbox` (12 testes) e testes manuais, na aplicação "Dittu Assinaturas".

**Credencial.** O `MP_ACCESS_TOKEN` do arquivo é `APP_USR-...` de um **usuário de teste vendedor** (`/users/me`: tag `test_user`, site `MLB`); a chave pública também é `APP_USR-...`. Funcionou para plano, assinatura, busca, atualização e cancelamento. O pagador precisa ser **usuário de teste comprador**: com e-mail inventado (`test_user_<n>@testuser.com`) o MP responde `User bad request` (assinatura pendente) ou `Unauthorized use of live credentials` (pagamentos). O próprio token de vendedor cria um comprador (`POST /users/test_user` com `{"site_id":"MLB"}`); o teste de sandbox faz isso sozinho e guarda o e-mail em `~/.dittu-mp-comprador-teste.env` (600). Se o CEO preferir, basta pôr `MP_PAYER_EMAIL` no `~/.dittu-mp-teste.env`.

**Cartões.** O Mastercard `5031 4332 1540 6351` (titular `APRO`) **não serve para recorrência**: `Unsupported_credit_card_for_recurring_payment`. O Visa de teste `4235 6477 2802 5682` (CVV `123`, `11/30`, titular `APRO`, CPF `12345678909`) autoriza a assinatura. Titular `OTHE` (recusa): o MP devolve 400 `rejected` / `CC_VAL_433 Credit card validation has failed` e ainda deixa uma assinatura `cancelled` criada. O token do cartão sai de `POST /v1/card_tokens?public_key=...`.

**Assinatura com cartão (sem plano e com plano).** `POST /preapproval` com `card_token_id` e `status: authorized` volta `201 authorized` e **cobra a 1ª parcela na hora**: a cobrança aparece em `GET /authorized_payments/search?preapproval_id=` uns 3 a 6 segundos depois (`status: processed`, `payment.status: approved`, `status_detail: accredited`), e `next_payment_date` fica 1 mês à frente. Não deu para esperar a 2ª parcela (1 mês). Com plano, o hub lê o plano e repete `reason`, `back_url` e `auto_recurring` no corpo.

**Status vistos de `preapproval`:** `pending` (checkout ainda não autorizado), `authorized`, `cancelled` (grafia com dois "l" nas respostas deste sandbox; o hub aceita `canceled` também). **Pagamento da parcela:** `approved`; `rejected` não foi reproduzido (cartão recusado nem chega a criar a parcela).

**Assinatura pendente.** `POST /preapproval` sem plano e sem cartão, `status: pending`, volta `201` com `init_point` (`https://www.mercadopago.com.br/subscriptions/checkout?preapproval_id=...&activation=true`); `payer_email` volta **vazio** na resposta enquanto pendente.

**`start_date` (TASK-407): aceito.** Com `start_date` daqui a 30 dias o MP aceita, grava `auto_recurring.start_date` e transforma em `free_trial: { frequency: 1, frequency_type: months, first_invoice_offset: 30 }`; `next_payment_date` passa a ser a data do `start_date`. Ou seja, dá para dar um período grátis iniciando a cobrança numa data futura.

**Atualizar valor e cancelar.** `PUT /preapproval/{id}` com `auto_recurring.transaction_amount` e `currency_id` atualiza (resposta já traz o valor novo); `status: cancelled` cancela. O hub consulta antes de cancelar para ser idempotente.

**Taxa.** Parcela de R$ 19,90 no cartão: `fee_details = [{ type: mercadopago_fee, amount: 0.5, fee_payer: collector }]` (R$ 0,50 no sandbox; `charges_details` mostra duas linhas de R$ 0,50, mas `fee_details` traz uma só, e o hub usa `fee_details`). Não vale como tabela de taxa real.

**Busca por referência.** `GET /preapproval/search?external_reference=...` **ignora o filtro** neste sandbox (devolve todas as assinaturas da conta, 10 por página). O que filtra é `q=<referência>`. O hub manda os dois, com `sort=date_created:desc&limit=100`, e confere `external_reference` igual no resultado. A busca e a lista de cobranças também têm pequeno atraso depois da criação (alguns segundos).

**De onde vem o `subscription_id` do pagamento.** `point_of_interaction.transaction_data.subscription_id` (com `type: SUBSCRIPTIONS`, `subscription_sequence.number`); `metadata` vem `{}` e não há `subscription_id` na raiz. O `GET /authorized_payments/{id}` traz `preapproval_id`, `external_reference`, `payment.{id,status,status_detail}`.

**Datas.** O MP devolve `-04:00` em todos (`2026-11-20T09:45:26.000-04:00`) e o instante confere com UTC; o hub converte `next_payment_date`, `approved_at` e `pix.expires_at` para UTC (`...Z`). Na ida (`start_date`, `date_of_expiration`) usa `-03:00` com `.000`, como o contrato pede.

**Pix: NÃO foi possível testar neste sandbox.** `POST /v1/payments` responde `401 Unauthorized use of live credentials` para Pix **e para cartão avulso**, com o comprador de teste e com qualquer e-mail, e `/v1/payment_methods` não lista `pix` para esta conta. O mesmo erro vale para o reembolso (`POST /v1/payments/{id}/refunds`). Portanto ficaram **sem confirmação no sandbox**: QR code, status do Pix vencido (o hub assume `cancelled` + `status_detail: expired` -> `expired`, como o contrato manda), idempotência do Pix (a mesma `idempotency_key` devolvendo o mesmo pagamento) e reembolso. Essas partes estão cobertas só pelos testes sem rede, com JSON no formato do manual do MP. A decisão de aprovar o Pix em produção deve ter um teste real de R$ 1 (CEO) antes de abrir. O hub traduz o erro como `502 gateway_error` com a mensagem do MP.

**Aviso (webhook) do MP.** `notification_url` no `POST /preapproval` é **ignorado** (o MP não guarda o campo; confirmado lendo a assinatura de volta), então não chega aviso por recurso para assinaturas: só vale o webhook do painel, e o hub não manda `notification_url`. Foi montado o túnel do cloudflared com o hub local (`test/sandbox/aviso-real.ts`) e nada chegou. Por isso **o formato real do `x-signature` ainda não foi visto**: o hub segue o manual do MP (`ts` em milissegundos; o verificador aceita segundos também; manifesto com `id`, `request-id` e `ts`; `data.id` alfanumérico em minúsculas). O primeiro aviso real (TASK-408, com o webhook do painel apontando para o hub) é a confirmação. Se vier `401` em tudo, olhe o log `aviso recusado: <motivo>` (`formato`, `assinatura` ou `expirada`) antes de mexer em qualquer coisa. O `project_id` na query não participa da assinatura.

**Outras surpresas.** (1) Limite de requisições (`local_rate_limited`) depois de muitas criações seguidas. (2) A janela do `ts` do aviso é de 10 minutos no hub (o manual não fixa); como o hub sempre consulta o recurso e deduplica, repetir um aviso antigo é inofensivo. (3) O 404 do MP ao consultar o recurso de um aviso vira `200 processed:false`, para o aviso de simulação do painel não ficar em retry.

