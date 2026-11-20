# BE-ZITO-PAYMENTS

Backend de pagamentos centralizado para os produtos da Zito AI Solutions.
Suporta múltiplos gateways (Stripe, MercadoPago, etc) e múltiplos projetos.

## Mercado Pago

O hub também cobra pelo Mercado Pago (assinaturas com cartão, Pix avulso e reembolso) e avisa os projetos por
callback assinado (HMAC-SHA256) com retry. Contrato da API `/v1`, do webhook e do callback, como cadastrar um
projeto e o que o sandbox mostrou: [`docs/mercadopago.md`](docs/mercadopago.md).

- `npm test`: testes sem rede.
- `npm run test:sandbox`: testes de rede no sandbox do MP (lê `~/.dittu-mp-teste.env`; recusa permissão aberta e ambiente diferente de `teste`).
- `scripts/registrar-projeto.ts`: cria o projeto e a config cifrada do Mercado Pago.
