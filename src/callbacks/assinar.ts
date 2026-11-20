import { createHmac } from 'crypto';

/** `t=<unix em segundos>,v1=<HMAC-SHA256 hex de "<t>.<corpo cru>">` */
export function assinarCallback(segredo: string, corpoCru: string, agora: Date = new Date()): string {
  const t = Math.floor(agora.getTime() / 1000);
  const v1 = createHmac('sha256', segredo).update(`${t}.${corpoCru}`).digest('hex');
  return `t=${t},v1=${v1}`;
}
