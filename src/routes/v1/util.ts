import { Request } from 'express';
import { ZodError, ZodType } from 'zod';

export class HttpError extends Error {
  constructor(public status: number, public code: string, message: string) {
    super(message);
  }
}

export function validar<T>(schema: ZodType<T>, dados: unknown): T {
  const r = schema.safeParse(dados ?? {});
  if (r.success) return r.data;
  throw r.error;
}

export function resumoZod(err: ZodError): string {
  const i = err.issues[0];
  if (!i) return 'Dados inválidos';
  const campo = i.path.join('.');
  return campo ? `${campo}: ${i.message}` : i.message;
}

export function param(req: Request, nome: string): string {
  const v = req.params[nome];
  return Array.isArray(v) ? (v[0] ?? '') : (v ?? '');
}
