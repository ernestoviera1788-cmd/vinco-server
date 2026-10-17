// VINCÓ — authentication & account actions.
//
// NOTE (code delivery): no SMS/email provider is configured yet, so OTP and
// password-reset codes are never actually delivered. In non-production
// (NODE_ENV !== 'production') the generated code is returned as `devCode` so
// the native app can complete verification/reset flows during development.
// Before production launch: wire a real provider here and stop exposing
// devCode (or gate it behind an explicit debug flag).
import { randomInt, timingSafeEqual } from 'node:crypto';
import { query, queryOne, tx } from '../db.js';
import {
  biz,
  INVALID_ARGS,
  INVALID_EMAIL,
  INVALID_PASSWORD,
  EMAIL_TAKEN,
  PHONE_TAKEN,
  UNDERAGE,
  INVALID_BIRTHDATE,
  TERMS_NOT_ACCEPTED,
  INVALID_CREDENTIALS,
  USER_NOT_FOUND,
  OTP_INVALID,
  OTP_EXPIRED,
  RESET_CODE_INVALID,
  RESET_CODE_EXPIRED,
  INVALID_LOCALE,
  INVALID_CONFIRM,
  NOT_FOUND,
  FORBIDDEN,
  ACCOUNT_SUSPENDED,
  ACCOUNT_BANNED,
  ACCOUNT_DELETED,
} from '../errors.js';
import {
  reqString,
  optString,
  reqBoolean,
  reqEnum,
  validEmail,
  validPassword,
  parseBirthDate,
  ageOf,
  validOtp,
} from '../validation.js';
import {
  hashPassword,
  verifyPassword,
  hashCode,
  createSession,
  revokeSession,
} from '../auth.js';
import { registerAction, ActionContext } from '../rpc.js';
import { getFullUser } from '../users.js';

// ---------- helpers ----------

function safeEqual(a: string, b: string): boolean {
  const ba = Buffer.from(a, 'utf8');
  const bb = Buffer.from(b, 'utf8');
  if (ba.length !== bb.length) return false;
  return timingSafeEqual(ba, bb);
}

function iso(v: any): string | null {
  if (v === null || v === undefined) return null;
  return v instanceof Date ? v.toISOString() : String(v);
}

// Compact user object returned by register/login (never includes password_hash).
function toAuthUser(r: any) {
  return {
    id: r.id,
    email: r.email,
    phone: r.phone ?? null,
    firstName: r.first_name,
    birthDate: typeof r.birth_date === 'string' ? r.birth_date.slice(0, 10) : iso(r.birth_date)?.slice(0, 10),
    gender: r.gender,
    city: r.city,
    state: r.state ?? null,
    country: r.country,
    locale: r.locale,
    role: r.role,
    status: r.status,
    emailVerified: !!r.email_verified,
    phoneVerified: !!r.phone_verified,
    createdAt: iso(r.created_at),
  };
}

function newCode(): string {
  return String(randomInt(0, 1_000_000)).padStart(6, '0');
}

// Resolves an email-or-phone identifier to an active user row (or null).
// Used by login / password-reset; never reveals existence to the caller.
async function findActiveUserByIdentifier(identifier: string): Promise<any | null> {
  const idNorm = identifier.trim();
  if (validEmail(idNorm)) {
    return queryOne(`SELECT * FROM users WHERE email = $1 AND status = 'active'`, [idNorm.toLowerCase()]);
  }
  return queryOne(`SELECT * FROM users WHERE phone = $1 AND status = 'active'`, [idNorm]);
}

function withDevCode(payload: Record<string, unknown>, code: string): Record<string, unknown> {
  if (process.env.NODE_ENV !== 'production') payload.devCode = code;
  return payload;
}

// Shared core of requestpasswordreset / recoverpassword.
async function doRequestPasswordReset(identifier: string): Promise<Record<string, unknown>> {
  const user = await findActiveUserByIdentifier(identifier);
  if (!user) return { ok: true }; // never enumerate accounts
  const code = newCode();
  await tx(async (client) => {
    await client.query(`UPDATE password_resets SET used_at = now() WHERE user_id = $1 AND used_at IS NULL`, [user.id]);
    await client.query(
      `INSERT INTO password_resets (user_id, code_hash, expires_at)
       VALUES ($1, $2, now() + interval '15 minutes')`,
      [user.id, hashCode(code)]
    );
  });
  return withDevCode({ ok: true }, code);
}

// ---------- actions ----------

registerAction('register', async (args, ctx) => {
  const emailRaw = reqString(args, 'email', 1, 254);
  if (!validEmail(emailRaw)) biz(INVALID_EMAIL);
  const email = emailRaw.toLowerCase();

  const password = args?.password;
  if (typeof password !== 'string' || !validPassword(password)) biz(INVALID_PASSWORD);

  const firstName = reqString(args, 'firstName', 1, 40);

  const birthRaw = reqString(args, 'birthDate', 10, 10);
  const birth = parseBirthDate(birthRaw);
  if (!birth) biz(INVALID_BIRTHDATE);
  if (ageOf(birth) < 18) biz(UNDERAGE); // strict 18+

  const gender = reqString(args, 'gender', 1, 40);
  const city = reqString(args, 'city', 1, 100);
  const state = optString(args, 'state', 100);
  const country = reqString(args, 'country', 1, 100);
  const phoneRaw = optString(args, 'phone', 24);
  if (phoneRaw !== null && phoneRaw.length < 7) biz(INVALID_ARGS, 'arg phone');
  const phone = phoneRaw;

  const locale = reqEnum(args, 'locale', ['en', 'es'] as const);
  const acceptedTerms = reqBoolean(args, 'acceptedTerms');
  if (!acceptedTerms) biz(TERMS_NOT_ACCEPTED);

  if (await queryOne(`SELECT 1 FROM users WHERE email = $1`, [email])) biz(EMAIL_TAKEN);
  if (phone && (await queryOne(`SELECT 1 FROM users WHERE phone = $1`, [phone]))) biz(PHONE_TAKEN);

  const birthIso = birth.toISOString().slice(0, 10);
  let userRow: any;
  try {
    userRow = await tx(async (client) => {
      const ins = await client.query(
        `INSERT INTO users (email, phone, password_hash, first_name, birth_date, gender, city, state, country, locale, terms_accepted_at)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10, now())
         RETURNING *`,
        [email, phone, hashPassword(password), firstName, birthIso, gender, city, state, country, locale]
      );
      const u = ins.rows[0];
      await client.query(`INSERT INTO profiles (user_id) VALUES ($1)`, [u.id]);
      await client.query(`INSERT INTO notification_settings (user_id) VALUES ($1)`, [u.id]);
      return u;
    });
  } catch (e: any) {
    // Race-safe fallback if two concurrent registers pass the pre-checks.
    if (e?.code === '23505') {
      if (e?.constraint === 'users_phone_key') biz(PHONE_TAKEN);
      biz(EMAIL_TAKEN);
    }
    throw e;
  }

  const { token, expiresAt } = await createSession(userRow.id, ctx.ip, ctx.userAgent);
  return { user: toAuthUser(userRow), token, expiresAt };
}, { auth: 'none' });

registerAction('login', async (args, ctx) => {
  const identifier = reqString(args, 'identifier', 1, 254);
  const password = args?.password;
  if (typeof password !== 'string' || password.length === 0) biz(INVALID_CREDENTIALS);

  const row = await findActiveUserByIdentifier(identifier);
  // Same error whether the account is missing or the password is wrong.
  if (!row || !verifyPassword(password, row.password_hash)) biz(INVALID_CREDENTIALS);
  if (row.status === 'suspended') biz(ACCOUNT_SUSPENDED);
  if (row.status === 'banned') biz(ACCOUNT_BANNED);
  if (row.status === 'deleted') biz(ACCOUNT_DELETED);

  await query(`UPDATE users SET last_login_at = now() WHERE id = $1`, [row.id]);
  const { token, expiresAt } = await createSession(row.id, ctx.ip, ctx.userAgent);
  return { user: toAuthUser(row), token, expiresAt };
}, { auth: 'none' });

registerAction('requestverification', async (args, ctx: ActionContext) => {
  const user = ctx.user!;
  const channel = reqEnum(args, 'channel', ['email', 'phone'] as const);
  if (channel === 'phone' && !user.phone) biz(INVALID_ARGS, 'no phone on account');

  const code = newCode();
  await tx(async (client) => {
    // Burn any previous unconsumed codes for this channel.
    await client.query(
      `UPDATE otp_codes SET used_at = now() WHERE user_id = $1 AND channel = $2 AND used_at IS NULL`,
      [user.id, channel]
    );
    await client.query(
      `INSERT INTO otp_codes (user_id, channel, code_hash, purpose, expires_at)
       VALUES ($1, $2, $3, 'verification', now() + interval '10 minutes')`,
      [user.id, channel, hashCode(code)]
    );
  });
  return withDevCode({ ok: true, channel }, code);
}, { auth: 'user' });

registerAction('verifyotp', async (args, ctx: ActionContext) => {
  const user = ctx.user!;
  const channel = reqEnum(args, 'channel', ['email', 'phone'] as const);
  const code = reqString(args, 'code', 1, 16);
  if (!validOtp(code)) biz(OTP_INVALID);

  const row: any = await queryOne(
    `SELECT * FROM otp_codes
     WHERE user_id = $1 AND channel = $2 AND purpose = 'verification' AND used_at IS NULL
     ORDER BY created_at DESC LIMIT 1`,
    [user.id, channel]
  );
  if (!row) biz(OTP_INVALID);
  if (row.attempts >= 5) biz(OTP_INVALID); // max 5 attempts per code
  if (new Date(row.expires_at).getTime() <= Date.now()) {
    await query(`UPDATE otp_codes SET attempts = attempts + 1 WHERE id = $1`, [row.id]);
    biz(OTP_EXPIRED);
  }
  if (!safeEqual(hashCode(code), row.code_hash)) {
    await query(`UPDATE otp_codes SET attempts = attempts + 1 WHERE id = $1`, [row.id]);
    biz(OTP_INVALID);
  }

  await tx(async (client) => {
    await client.query(`UPDATE otp_codes SET used_at = now() WHERE id = $1`, [row.id]);
    const col = channel === 'email' ? 'email_verified' : 'phone_verified'; // enum-derived, safe
    await client.query(`UPDATE users SET ${col} = TRUE, updated_at = now() WHERE id = $1`, [user.id]);
  });
  return { ok: true, channel };
}, { auth: 'user' });

registerAction('getme', async (args, ctx: ActionContext) => {
  const user = ctx.user!;
  const full = await getFullUser(user.id);
  if (!full) biz(USER_NOT_FOUND);
  const settings: any = await queryOne(`SELECT * FROM notification_settings WHERE user_id = $1`, [user.id]);
  return {
    ...full,
    settings: settings
      ? {
          likes: !!settings.likes,
          matches: !!settings.matches,
          messages: !!settings.messages,
          security: !!settings.security,
          marketing: !!settings.marketing,
        }
      : null,
  };
}, { auth: 'user' });

registerAction('logout', async (args, _ctx: ActionContext) => {
  await revokeSession(args.token);
  return { ok: true };
}, { auth: 'user' });

registerAction('listsessions', async (args, ctx: ActionContext) => {
  const user = ctx.user!;
  const currentToken: string = args.token;
  const rows = await query(
    `SELECT id, created_at, expires_at, last_used_at, ip, user_agent, token
     FROM sessions
     WHERE user_id = $1 AND revoked_at IS NULL AND expires_at > now()
     ORDER BY created_at DESC`,
    [user.id]
  );
  return {
    sessions: rows.map((r: any) => ({
      id: r.id,
      createdAt: iso(r.created_at),
      expiresAt: iso(r.expires_at),
      lastUsedAt: iso(r.last_used_at),
      ip: r.ip ?? null,
      userAgent: r.user_agent ?? null,
      current: r.token === currentToken,
    })),
  };
}, { auth: 'user' });

registerAction('revokesession', async (args, ctx: ActionContext) => {
  const user = ctx.user!;
  const sessionId = reqString(args, 'sessionId', 1, 64);
  const row: any = await queryOne(`SELECT id, user_id FROM sessions WHERE id = $1`, [sessionId]);
  if (!row) biz(NOT_FOUND);
  if (row.user_id !== user.id) biz(FORBIDDEN);
  await query(`UPDATE sessions SET revoked_at = now() WHERE id = $1`, [sessionId]);
  return { ok: true };
}, { auth: 'user' });

registerAction('requestpasswordreset', async (args) => {
  const identifier = reqString(args, 'identifier', 1, 254);
  reqEnum(args, 'locale', ['en', 'es'] as const); // validated now; used when localized delivery is wired
  return doRequestPasswordReset(identifier);
}, { auth: 'none' });

registerAction('completepasswordreset', async (args) => {
  const identifier = reqString(args, 'identifier', 1, 254);
  const code = reqString(args, 'code', 1, 16);
  const newPassword = args?.newPassword;
  if (typeof newPassword !== 'string' || !validPassword(newPassword)) biz(INVALID_PASSWORD);
  reqEnum(args, 'locale', ['en', 'es'] as const);

  const user = await findActiveUserByIdentifier(identifier);
  if (!user) biz(RESET_CODE_INVALID); // never enumerate accounts

  const pr: any = await queryOne(
    `SELECT * FROM password_resets WHERE user_id = $1 AND used_at IS NULL ORDER BY created_at DESC LIMIT 1`,
    [user.id]
  );
  if (!pr) biz(RESET_CODE_INVALID);
  if (new Date(pr.expires_at).getTime() <= Date.now()) biz(RESET_CODE_EXPIRED);
  if (!validOtp(code) || !safeEqual(hashCode(code), pr.code_hash)) biz(RESET_CODE_INVALID);

  await tx(async (client) => {
    await client.query(`UPDATE password_resets SET used_at = now() WHERE id = $1`, [pr.id]);
    await client.query(`UPDATE users SET password_hash = $1, updated_at = now() WHERE id = $2`, [
      hashPassword(newPassword),
      user.id,
    ]);
    await client.query(`UPDATE sessions SET revoked_at = now() WHERE user_id = $1 AND revoked_at IS NULL`, [user.id]);
  });
  return { ok: true };
}, { auth: 'none' });

registerAction('recoverpassword', async (args) => {
  const email = reqString(args, 'email', 1, 254);
  if (!validEmail(email)) biz(INVALID_EMAIL);
  reqEnum(args, 'locale', ['en', 'es'] as const);
  return doRequestPasswordReset(email);
}, { auth: 'none' });

registerAction('deleteaccount', async (args, ctx: ActionContext) => {
  const user = ctx.user!;
  if (args?.confirm !== 'DELETE') biz(INVALID_CONFIRM);
  await tx(async (client) => {
    await client.query(`UPDATE users SET status = 'deleted', updated_at = now() WHERE id = $1`, [user.id]);
    await client.query(`UPDATE sessions SET revoked_at = now() WHERE user_id = $1 AND revoked_at IS NULL`, [user.id]);
  });
  return { ok: true };
}, { auth: 'user' });

registerAction('updatelocale', async (args, ctx: ActionContext) => {
  const user = ctx.user!;
  const locale = args?.locale;
  if (locale !== 'en' && locale !== 'es') biz(INVALID_LOCALE);
  await query(`UPDATE users SET locale = $1, updated_at = now() WHERE id = $2`, [locale, user.id]);
  return { ok: true, locale };
}, { auth: 'user' });
