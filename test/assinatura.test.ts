import { describe, expect, it } from 'vitest';
import { verificarAssinaturaMP } from '../src/gateways/mercadopago/assinatura';
import { assinarAvisoMP } from './helpers/assinaturaMP';

const segredo = 'segredo-webhook-de-teste';
const agora = new Date('2026-11-20T12:00:00Z');
const ts = agora.getTime();
const base = { dataId: '123456', requestId: 'req-abc-1', segredo, agora };

describe('verificarAssinaturaMP', () => {
  it('aceita assinatura válida', () => {
    const xSignature = assinarAvisoMP({ segredo, dataId: '123456', requestId: 'req-abc-1', ts });
    expect(verificarAssinaturaMP({ ...base, xSignature, xRequestId: 'req-abc-1' })).toEqual({ ok: true });
  });

  it('aceita ts em segundos, ordem livre e espaços', () => {
    const s = assinarAvisoMP({ segredo, dataId: '123456', requestId: 'req-abc-1', ts: Math.floor(ts / 1000) });
    const [t, v1] = s.split(',');
    expect(verificarAssinaturaMP({ ...base, xSignature: ` ${v1} , ${t} `, xRequestId: 'req-abc-1' }).ok).toBe(true);
  });

  it('recusa segredo errado', () => {
    const xSignature = assinarAvisoMP({ segredo: 'outro', dataId: '123456', requestId: 'req-abc-1', ts });
    expect(verificarAssinaturaMP({ ...base, xSignature, xRequestId: 'req-abc-1' })).toEqual({ ok: false, motivo: 'assinatura' });
  });

  it('recusa v1 alterado', () => {
    const xSignature = assinarAvisoMP({ segredo, dataId: '123456', requestId: 'req-abc-1', ts }).replace(/.$/, (c) => (c === '0' ? '1' : '0'));
    expect(verificarAssinaturaMP({ ...base, xSignature, xRequestId: 'req-abc-1' })).toEqual({ ok: false, motivo: 'assinatura' });
  });

  it('recusa sem cabeçalho', () => {
    expect(verificarAssinaturaMP({ ...base, xSignature: undefined, xRequestId: 'req-abc-1' })).toEqual({ ok: false, motivo: 'sem_cabecalho' });
    expect(verificarAssinaturaMP({ ...base, xSignature: '  ', xRequestId: 'req-abc-1' })).toEqual({ ok: false, motivo: 'sem_cabecalho' });
  });

  it('recusa sem v1 (ou sem ts)', () => {
    expect(verificarAssinaturaMP({ ...base, xSignature: `ts=${ts}`, xRequestId: 'req-abc-1' })).toEqual({ ok: false, motivo: 'formato' });
    expect(verificarAssinaturaMP({ ...base, xSignature: 'v1=abcdef', xRequestId: 'req-abc-1' })).toEqual({ ok: false, motivo: 'formato' });
  });

  it('sem x-request-id o par sai do manifesto', () => {
    const { createHmac } = require('crypto') as typeof import('crypto');
    const v1 = createHmac('sha256', segredo).update(`id:123456;ts:${ts};`).digest('hex');
    expect(verificarAssinaturaMP({ ...base, xSignature: `ts=${ts},v1=${v1}`, xRequestId: undefined }).ok).toBe(true);
    // e quem assinou COM request-id não passa sem ele
    const comReq = assinarAvisoMP({ segredo, dataId: '123456', requestId: 'req-abc-1', ts });
    expect(verificarAssinaturaMP({ ...base, xSignature: comReq, xRequestId: undefined }).ok).toBe(false);
  });

  it('dataId alfanumérico entra em minúsculas no manifesto', () => {
    const xSignature = assinarAvisoMP({ segredo, dataId: 'ABC123', requestId: 'r', ts });
    expect(verificarAssinaturaMP({ ...base, dataId: 'ABC123', xSignature, xRequestId: 'r' }).ok).toBe(true);
  });

  it('recusa aviso expirado', () => {
    const velho = ts - 3600_000;
    const xSignature = assinarAvisoMP({ segredo, dataId: '123456', requestId: 'req-abc-1', ts: velho });
    expect(verificarAssinaturaMP({ ...base, xSignature, xRequestId: 'req-abc-1' })).toEqual({ ok: false, motivo: 'expirada' });
    expect(verificarAssinaturaMP({ ...base, xSignature, xRequestId: 'req-abc-1', toleranciaSeg: 7200 }).ok).toBe(true);
  });
});
