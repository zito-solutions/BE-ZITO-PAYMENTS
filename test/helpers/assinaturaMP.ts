import { createHmac } from 'crypto';

/** Monta o x-signature como o Mercado Pago faz. */
export function assinarAvisoMP(opts: { segredo: string; dataId: string; requestId: string; ts?: number }): string {
  const ts = opts.ts ?? Date.now();
  const dataId = /^[a-zA-Z0-9]+$/.test(opts.dataId) ? opts.dataId.toLowerCase() : opts.dataId;
  const manifesto = `id:${dataId};request-id:${opts.requestId};ts:${ts};`;
  const v1 = createHmac('sha256', opts.segredo).update(manifesto).digest('hex');
  return `ts=${ts},v1=${v1}`;
}
