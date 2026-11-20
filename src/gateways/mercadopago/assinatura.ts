import { createHmac, timingSafeEqual } from 'crypto';

export type MotivoAssinatura = 'sem_cabecalho' | 'formato' | 'assinatura' | 'expirada';

export type ResultadoAssinatura = { ok: true } | { ok: false; motivo: MotivoAssinatura };

export interface VerificarAssinaturaParams {
  xSignature: string | undefined;
  xRequestId: string | undefined;
  dataId: string | undefined;
  segredo: string;
  agora?: Date;
  /** Janela aceita entre o `ts` do aviso e agora. Padrão 600 s. */
  toleranciaSeg?: number;
}

const TOLERANCIA_PADRAO_SEG = 600;

/**
 * Valida o cabeçalho `x-signature` dos avisos do Mercado Pago:
 * `ts=<ts>,v1=<hmac>`, com v1 = HMAC-SHA256 hex do manifesto
 * `id:<data.id>;request-id:<x-request-id>;ts:<ts>;` usando o webhook_secret.
 */
export function verificarAssinaturaMP(params: VerificarAssinaturaParams): ResultadoAssinatura {
  const { xSignature, xRequestId, dataId, segredo } = params;
  if (!xSignature || !xSignature.trim()) return { ok: false, motivo: 'sem_cabecalho' };

  let ts: string | undefined;
  let v1: string | undefined;
  for (const parte of xSignature.split(',')) {
    const i = parte.indexOf('=');
    if (i < 0) continue;
    const chave = parte.slice(0, i).trim();
    const valor = parte.slice(i + 1).trim();
    if (chave === 'ts') ts = valor;
    else if (chave === 'v1') v1 = valor;
  }
  if (!ts || !v1 || !/^\d+$/.test(ts) || !/^[0-9a-fA-F]+$/.test(v1)) return { ok: false, motivo: 'formato' };

  let manifesto = '';
  if (dataId) manifesto += `id:${/^[a-zA-Z0-9]+$/.test(dataId) ? dataId.toLowerCase() : dataId};`;
  if (xRequestId) manifesto += `request-id:${xRequestId};`;
  manifesto += `ts:${ts};`;

  const esperado = createHmac('sha256', segredo).update(manifesto).digest();
  const recebido = Buffer.from(v1.toLowerCase(), 'hex');
  if (recebido.length !== esperado.length || !timingSafeEqual(recebido, esperado)) {
    return { ok: false, motivo: 'assinatura' };
  }

  // O MP manda o ts em milissegundos; aceita segundos também.
  const tsNum = Number(ts);
  const tsMs = tsNum > 1e11 ? tsNum : tsNum * 1000;
  const agoraMs = (params.agora ?? new Date()).getTime();
  const toleranciaMs = (params.toleranciaSeg ?? TOLERANCIA_PADRAO_SEG) * 1000;
  if (Math.abs(agoraMs - tsMs) > toleranciaMs) return { ok: false, motivo: 'expirada' };

  return { ok: true };
}
