import { StripeGateway } from '../gateways/stripe/stripe.gateway';
import { MercadoPagoGateway } from '../gateways/mercadopago/mercadopago.gateway';
import { PaymentGateway } from '../gateways/gateway.interface';
import { GatewayConfig } from './payment.types';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type AnyConfig = any;

export function buildGateway(gatewayConfig: GatewayConfig): PaymentGateway {
  switch (gatewayConfig.gateway) {
    case 'stripe':
      return new StripeGateway(gatewayConfig.config as AnyConfig);
    case 'mercadopago':
      return buildMercadoPago(gatewayConfig);
    default:
      throw new Error(`Unsupported gateway: ${gatewayConfig.gateway}`);
  }
}

export function buildMercadoPago(gatewayConfig: GatewayConfig): MercadoPagoGateway {
  return new MercadoPagoGateway(gatewayConfig.config as AnyConfig);
}
