import 'dotenv/config';
import { createApp } from './app';
import { buildGateway, buildMercadoPago } from './payments/payment.service';
import { getSupabaseRepos } from './repositories';
import { iniciarFila } from './callbacks/fila';
import { oauthMercadoPago } from './gateways/mercadopago/oauth';
import { buildCheckoutLojas } from './gateways/mercadopago/lojas';
import { iniciarRenovacao } from './contas/renovar';

const PORT = process.env.PORT ?? 3001;

const repos = getSupabaseRepos();
const entrega = { repos };
const app = createApp({ repos, entrega, buildGateway, buildMercadoPago, oauth: oauthMercadoPago, buildCheckoutLojas });

app.listen(PORT, () => {
  console.log(`BE-ZITO-PAYMENTS running on port ${PORT}`);
});

// um processo só no Railway: a fila de callbacks roda aqui dentro
iniciarFila(entrega);
iniciarRenovacao({ repos, entrega, oauth: oauthMercadoPago });
