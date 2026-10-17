// Input validation shared by all actions. All messages are English;
// the native app maps stable error codes to en/es strings.
import { biz, INVALID_ARGS } from './errors.js';

export function reqString(args: any, name: string, min = 1, max = 10000): string {
  const v = args?.[name];
  if (typeof v !== 'string' || v.length < min || v.length > max) biz(INVALID_ARGS, `arg ${name}`);
  return v.trim();
}

export function optString(args: any, name: string, max = 10000): string | null {
  const v = args?.[name];
  if (v === undefined || v === null || v === '') return null;
  if (typeof v !== 'string' || v.length > max) biz(INVALID_ARGS, `arg ${name}`);
  const t = v.trim();
  return t === '' ? null : t;
}

export function reqBoolean(args: any, name: string): boolean {
  const v = args?.[name];
  if (typeof v !== 'boolean') biz(INVALID_ARGS, `arg ${name}`);
  return v;
}

export function optBoolean(args: any, name: string, def: boolean): boolean {
  const v = args?.[name];
  if (v === undefined || v === null) return def;
  if (typeof v !== 'boolean') biz(INVALID_ARGS, `arg ${name}`);
  return v;
}

export function reqInt(args: any, name: string, min: number, max: number): number {
  const v = args?.[name];
  if (typeof v !== 'number' || !Number.isInteger(v) || v < min || v > max) biz(INVALID_ARGS, `arg ${name}`);
  return v;
}

export function reqEnum<T extends string>(args: any, name: string, allowed: readonly T[]): T {
  const v = args?.[name];
  if (typeof v !== 'string' || !(allowed as readonly string[]).includes(v)) biz(INVALID_ARGS, `arg ${name}`);
  return v as T;
}

export function reqArray<T>(args: any, name: string, min: number, max: number, itemCheck?: (x: any) => T): T[] {
  const v = args?.[name];
  if (!Array.isArray(v) || v.length < min || v.length > max) biz(INVALID_ARGS, `arg ${name}`);
  return itemCheck ? v.map(itemCheck) : (v as T[]);
}

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;
export function validEmail(email: string): boolean {
  return EMAIL_RE.test(email) && email.length <= 254;
}

export function validPassword(pw: string): boolean {
  return pw.length >= 10 && pw.length <= 100;
}

// Parses YYYY-MM-DD strictly and rejects impossible dates (e.g. 2000-13-99).
export function parseBirthDate(s: string): Date | null {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(s);
  if (!m) return null;
  const y = +m[1], mo = +m[2], d = +m[3];
  const dt = new Date(Date.UTC(y, mo - 1, d));
  if (dt.getUTCFullYear() !== y || dt.getUTCMonth() !== mo - 1 || dt.getUTCDate() !== d) return null;
  return dt;
}

export function ageOf(birth: Date, now = new Date()): number {
  let age = now.getUTCFullYear() - birth.getUTCFullYear();
  const m = now.getUTCMonth() - birth.getUTCMonth();
  if (m < 0 || (m === 0 && now.getUTCDate() < birth.getUTCDate())) age--;
  return age;
}

export function validOtp(code: string): boolean {
  return /^\d{6}$/.test(code);
}

export function uuid(): string {
  return crypto.randomUUID();
}

export function token(): string {
  const b = crypto.getRandomValues(new Uint8Array(32));
  return Buffer.from(b).toString('base64url');
}
