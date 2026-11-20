# Mercado Pago das lojas no hub (frente B)

Cada loja do Dittu recebe pelo Mercado Pago (MP) da própria lojista: ela autoriza a aplicação "Dittu Lojas" na conta dela por OAuth e o hub guarda os tokens (cifrados) e fala com o MP em nome dela. O Dittu só chama a API do hub. Fonte da verdade do contrato: `backlog/tasks/TASK-396.md` no workspace; a TASK-398 implementa a parte de checkout.

## Contrato da frente B

### Configuração do projeto
Nova config em `payments.payment_configs` com `gateway = 'mercadopago_lojas'`, JSON cifrado (mesmo `encrypt` de `src/crypto/config.crypto.ts`):
`{ client_id, client_secret, webhook_secret, ambiente: "teste" | "producao", redirect_uri }`. A **base pública do hub** é sempre `new URL(redirect_uri).origin` (não crie variável de ambiente nova).

### Tipos
```
ConnectedAccount = { account_ref, status: "connected" | "disconnected" | "expired",
                     mp_user_id: string | null, connected_at: string | null, expires_at: string | null,
                     ambiente: "teste" | "producao" }

PaymentLoja = Payment (o mesmo da TASK-387) + { account_ref, installments: number | null,
                     refunded_cents: number, disputed: boolean }
   status: approved | pending | rejected | cancelled | expired | refunded | charged_back
   (MP "in_mediation" vira status "approved" com disputed: true; reembolso parcial fica "approved" com refunded_cents > 0)

Preferencia = { id, init_point, expires_at, ambiente }
```
`account_ref` é o id da conta no projeto (no Dittu, o `store.id`). Valores em centavos inteiros; datas ISO 8601 em UTC.

### API (cabeçalho `x-api-key`; sem config `mercadopago_lojas` ativa → 409 `gateway_not_configured`; erros no formato da TASK-387)
| Método e rota | Corpo | Resposta | Task |
|---|---|---|---|
| `POST /v1/accounts/connect` | `{ account_ref, return_url }` | **201** `{ authorize_url, expires_at }` | 396 |
| `GET /v1/accounts/:account_ref` | — | `ConnectedAccount` (404 `not_found` se nunca conectou) | 396 |
| `DELETE /v1/accounts/:account_ref` | — | `ConnectedAccount` com `status: "disconnected"` (idempotente; 404 se nunca existiu) | 396 |
| `POST /v1/checkout/preferences` | `{ account_ref, reference, items: [{ title, quantity, unit_price_cents }], shipping_cents, payer: { name, phone? }, back_url, expires_at, max_installments }` | **201** `Preferencia` | 398 |
| `GET /v1/checkout/payments/:id?account_ref=` | — | `PaymentLoja` | 398 |
| `GET /v1/checkout/payments?account_ref=&reference=` | — | `{ payments: PaymentLoja[] }` (mais novo primeiro; vazio se nenhum) | 398 |
| `POST /v1/checkout/payments/:id/refund` | `{ account_ref, amount_cents?, idempotency_key }` | `PaymentLoja` (sem `amount_cents` = integral) | 398 |

Erros próprios: 409 `account_not_connected` (conta inexistente ou não `connected`) nas rotas de checkout; 422 `refund_rejected` (o MP recusou o estorno; `message` traz o `message` do MP, ex.: sem saldo).

### Volta do OAuth (pública, sem chave): `GET /oauth/mercadopago/retorno?code=&state=`
Redireciona (303) para o `return_url` guardado no `state` com `?mp=conectado`, ou `?mp=erro&motivo=negado|expirado|falha`. `state` desconhecido ou já usado: página HTML simples, 400, "Este link de conexão não vale mais. Volte ao painel e tente de novo." Nunca põe token na URL nem no log.

### Webhook das lojas (público): `POST /webhook/mercadopago-lojas?project_id=<id>[&account_ref=<ref>]`
Tópicos: `mp-connect` (esta task), `payment` (TASK-398). Outros: 200 sem fazer nada.

### Callbacks novos (mesmo envelope, cabeçalhos, assinatura e retry da TASK-387)
O `data` do corpo ganha a chave **`account: ConnectedAccount | null`** (em todos os eventos, também nos antigos, com `null`). O campo `gateway` continua `"mercadopago"`.
| Evento | `customer_ref` | `data` | Task |
|---|---|---|---|
| `account.connected` | `account_ref` | `account` | 396 |
| `account.disconnected` | `account_ref` | `account` (status `disconnected` ou `expired`) | 396 |
| `order.payment_approved` | `reference` | `payment: PaymentLoja`, `account` | 398 |
| `order.payment_expired` | `reference` | `payment`, `account` | 398 |
| `order.payment_refunded` | `reference` | `payment` (com `refunded_cents`), `account` | 398 |
| `order.payment_disputed` | `reference` | `payment` (`disputed: true` ou `charged_back`), `account` | 398 |

## Como registrar a config das lojas
Arquivo fora de qualquer repositório, permissão 600 (`~/.dittu-mp-lojas-teste.env`), com `MP_LOJAS_AMBIENTE` (`teste` ou `producao`), `MP_LOJAS_CLIENT_ID`, `MP_LOJAS_CLIENT_SECRET`, `MP_LOJAS_WEBHOOK_SECRET` e `MP_LOJAS_REDIRECT_URI` (`https://<hub>/oauth/mercadopago/retorno`, a mesma cadastrada na aplicação do MP). Depois:

```
railway run --service be-zito-payments npx ts-node scripts/registrar-config-lojas.ts \
  --projeto <id do projeto> --credenciais ~/.dittu-mp-lojas-teste.env
```
O script recusa arquivo com permissão mais aberta que 600 ou com chave faltando, desativa as configs `mercadopago_lojas` antigas do projeto, grava a nova cifrada e imprime só `config mercadopago_lojas registrada para o projeto <id> (<ambiente>)`. A URL do webhook a cadastrar na aplicação do MP: `<hub>/webhook/mercadopago-lojas?project_id=<id>` (tópicos `mp-connect` e `payment`).

## Como funciona
- **Conectar:** `POST /v1/accounts/connect` grava um `state` (32 bytes em hex, uso único, 10 minutos) e devolve o link `auth.mercadopago.com.br/authorization`. A lojista autoriza e o MP volta em `/oauth/mercadopago/retorno`; o hub troca o `code` por tokens, grava em `payments.connected_accounts` (cifrados com a `ENCRYPTION_KEY`, como as configs), emite `account.connected` e redireciona para o `return_url` com `?mp=conectado` ou `?mp=erro&motivo=negado|expirado|falha`.
- **Desvincular pelo MP:** o aviso `mp-connect` (`application.deauthorized`) só desconecta depois de o hub confirmar com `GET /users/me` que o token não vale mais (o aviso pode vir sem assinatura; nada do corpo é confiado além do `user_id`). Emite `account.disconnected`.
- **Desvincular pelo Dittu:** `DELETE /v1/accounts/:ref` apaga os tokens e marca `disconnected`, sem callback.
- **Renovação:** a cada 6 h (e 1 min depois de subir) o hub renova as contas `connected` cujo token vence em até 30 dias. Se o MP recusar (400/401, `invalid_grant`) ou a conta já tiver vencido e a renovação falhar, vira `expired`, os tokens são apagados e sai `account.disconnected` com `status: "expired"`. Outro erro grava `last_error` e tenta no próximo ciclo. Um erro numa conta não para as outras.
- Tokens nunca saem em resposta, log, erro ou callback.

## O que o sandbox mostrou (TASK-394)
(a preencher na TASK-394)
