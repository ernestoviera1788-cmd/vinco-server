// Password hashing (PBKDF2) + session management.
// The session token travels INSIDE args.token on every authenticated action.
import { pbkdf2Sync, randomBytes, createHash, timingSafeEqual } from 'node:crypto';
import { query, queryOne } from './db.js';
import { biz, INVALID_TOKEN, ACCOUNT_SUSPENDED, ACCOUNT_BANNED, ACCOUNT_DELETED, ADMIN_ONLY } from './errors.js';

const PBKDF2_ITERATIONS = 210_000;
const KEY_LEN = 64;
const DIGEST = 'sha512';
const SESSION_TTL_DAYS = 30;

export interface AuthUser {
  id: string;
  email: string;
  phone: string | null;
  firstName: string;
  role: string;
  locale: string;
  emailVerified: boolean;
  phoneVerified: boolean;
  status: string;
}

export function hashPassword(password: string): string {
  const salt = randomBytes(32).toString('base64');
  const hash = pbkdf2Sync(password, salt, PBKDF2_ITERATIONS, KEY_LEN, DIGEST).toString('base64');
  return `pbkdf2$${PBKDF2_ITERATIONS}$${salt}$${hash}`;
}

export function verifyPassword(password: string, stored: string): boolean {
  const parts = stored.split('$');
  if (parts.length !== 4 || parts[0] !== 'pbkdf2') return false;
  const iterations = parseInt(parts[1], 10);
  const salt = parts[2];
  const expected = Buffer.from(parts[3], 'base64');
  const actual = pbkdf2Sync(password, salt, iterations, KEY_LEN, DIGEST);
  if (actual.length !== expected.length) return false;
  return timingSafeEqual(actual, expected);
}

export function hashCode(code: string): string {
  return createHash('sha256').update(code).digest('hex');
}

export function newSessionToken(): string {
  return randomBytes(32).toString('base64url');
}

export async function createSession(userId: string, ip: string | null, userAgent: string | null): Promise<{ token: string; expiresAt: string }> {
  const t = newSessionToken();
  const expiresAt = new Date(Date.now() + SESSION_TTL_DAYS * 86400_000).toISOString();
  await query(
    `INSERT INTO sessions (id, user_id, token, expires_at, ip, user_agent) VALUES (gen_random_uuid(), $1, $2, $3, $4, $5)`,
    [userId, t, expiresAt, ip, userAgent]
  );
  return { token: t, expiresAt };
}

function rowToUser(r: any): AuthUser {
  return {
    id: r.id,
    email: r.email,
    phone: r.phone,
    firstName: r.first_name,
    role: r.role,
    locale: r.locale,
    emailVerified: !!r.email_verified,
    phoneVerified: !!r.phone_verified,
    status: r.status,
  };
}

// Resolves args.token to an active user. Throws INVALID_TOKEN on any failure
// (missing/unknown/expired/revoked token) — the app force-logs-out on it.
export async function requireAuth(args: any): Promise<AuthUser> {
  const t = args?.token;
  if (typeof t !== 'string' || t.length < 10) biz(INVALID_TOKEN);
  const row = await queryOne(
    `SELECT u.* FROM sessions s JOIN users u ON u.id = s.user_id
     WHERE s.token = $1 AND s.revoked_at IS NULL AND s.expires_at > now()`,
    [t]
  );
  if (!row) biz(INVALID_TOKEN);
  const user = rowToUser(row);
  if (user.status === 'suspended') biz(ACCOUNT_SUSPENDED);
  if (user.status === 'banned') biz(ACCOUNT_BANNED);
  if (user.status === 'deleted') biz(ACCOUNT_DELETED);
  await query(`UPDATE sessions SET last_used_at = now() WHERE token = $1`, [t]);
  return user;
}

export async function requireRole(args: any, roles: string[]): Promise<AuthUser> {
  const user = await requireAuth(args);
  if (!roles.includes(user.role)) biz(ADMIN_ONLY);
  return user;
}

export async function revokeSession(token: string): Promise<void> {
  await query(`UPDATE sessions SET revoked_at = now() WHERE token = $1`, [token]);
}

export async function revokeAllUserSessions(userId: string): Promise<void> {
  await query(`UPDATE sessions SET revoked_at = now() WHERE user_id = $1 AND revoked_at IS NULL`, [userId]);
}
