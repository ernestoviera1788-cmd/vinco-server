// VINCÓ admin / moderation RPC actions.
// Role gating: moderation (reports, photos, suspicious) → MODERATOR+;
// user management, commerce, announcements, settings, analytics → ADMIN+.
// Any state change is recorded with audit(actorId, action, targetType, targetId, details).
import { registerAction, ActionHandler, ActionContext } from '../rpc.js';
import { query, queryOne } from '../db.js';
import { audit } from '../audit.js';
import { getFullUser } from '../users.js';
import { stripeConfigured, createRefund } from '../stripe.js';
import { notifyUser } from '../notify.js';
import {
  biz, INVALID_ARGS, INVALID_STATUS, INVALID_CONFIRM,
  USER_NOT_FOUND, REPORT_NOT_FOUND, PHOTO_NOT_FOUND, PAYMENT_NOT_FOUND,
  CANNOT_MODIFY_SUPER_ADMIN, ADMIN_ONLY,
} from '../errors.js';
import {
  reqString, optString, optBoolean, reqInt, reqEnum, reqArray, parseBirthDate,
} from '../validation.js';

const MOD_ROLES = ['MODERATOR', 'ADMIN', 'SUPER_ADMIN'];
const ADMIN_ROLES = ['ADMIN', 'SUPER_ADMIN'];

const USER_ROLES = ['USER', 'MODERATOR', 'ADMIN', 'SUPER_ADMIN'] as const;
const USER_STATUSES = ['active', 'suspended', 'banned', 'deleted'] as const;
const REPORT_STATUSES = ['open', 'reviewing', 'resolved', 'dismissed'] as const;
const PHOTO_STATUSES = ['pending', 'approved', 'rejected'] as const;
const PAYMENT_STATUSES = ['pending', 'completed', 'failed', 'refunded', 'partially_refunded'] as const;
const PLAN_INTERVALS = ['monthly', 'quarterly', 'annual'] as const;
const SEGMENTS = ['all', 'premium', 'new', 'region'] as const;

function actorOf(ctx: ActionContext) {
  const actor = ctx.user;
  if (!actor) biz(ADMIN_ONLY);
  return actor;
}

// SUPER_ADMIN targets can only be modified/banned/deleted by a SUPER_ADMIN actor.
async function guardSuperAdmin(targetId: string, actorRole: string): Promise<void> {
  if (actorRole === 'SUPER_ADMIN') return;
  const t: any = await queryOne(`SELECT role FROM users WHERE id = $1`, [targetId]);
  if (t && t.role === 'SUPER_ADMIN') biz(CANNOT_MODIFY_SUPER_ADMIN);
}

function optInt(args: any, name: string, def: number, min: number, max: number): number {
  const v = args?.[name];
  if (v === undefined || v === null) return def;
  if (typeof v !== 'number' || !Number.isInteger(v) || v < min || v > max) biz(INVALID_ARGS, `arg ${name}`);
  return v;
}

function optEnum<T extends string>(args: any, name: string, allowed: readonly T[], def: T | null): T | null {
  const v = args?.[name];
  if (v === undefined || v === null) return def;
  if (typeof v !== 'string' || !(allowed as readonly string[]).includes(v)) biz(INVALID_ARGS, `arg ${name}`);
  return v as T;
}

function reqId(args: any, name: string): string {
  return reqString(args, name, 1, 64);
}

function countToNum(v: any): number {
  return Number(v ?? 0);
}

// ============================ overview ============================

const overviewHandler: ActionHandler = async (_args, _ctx) => {
  const r: any = await queryOne(`
    SELECT
      (SELECT COUNT(*) FROM users WHERE status <> 'deleted') AS "usersTotal",
      (SELECT COUNT(*) FROM users WHERE created_at > now() - interval '24 hours' AND status <> 'deleted') AS "usersNew24h",
      (SELECT COUNT(*) FROM subscriptions WHERE status = 'active' AND current_period_end > now()) AS "activeSubscriptions",
      (SELECT COUNT(*) FROM payments WHERE status = 'completed' AND created_at >= date_trunc('day', now())) AS "paymentsToday",
      (SELECT COUNT(*) FROM reports WHERE status = 'open') AS "openReports",
      (SELECT COUNT(*) FROM profile_photos WHERE status = 'pending') AS "pendingPhotos",
      (SELECT COUNT(*) FROM matches) AS "matchesTotal",
      (SELECT COUNT(*) FROM messages) AS "messagesTotal"
  `);
  return {
    usersTotal: countToNum(r.usersTotal),
    usersNew24h: countToNum(r.usersNew24h),
    activeSubscriptions: countToNum(r.activeSubscriptions),
    paymentsToday: countToNum(r.paymentsToday),
    openReports: countToNum(r.openReports),
    pendingPhotos: countToNum(r.pendingPhotos),
    matchesTotal: countToNum(r.matchesTotal),
    messagesTotal: countToNum(r.messagesTotal),
  };
};

registerAction('getadminoverview', overviewHandler, { auth: 'admin', roles: ADMIN_ROLES });
registerAction('admingetoverview', overviewHandler, { auth: 'admin', roles: ADMIN_ROLES });

// ============================ users ============================

registerAction('listadminusers', async (args, ctx) => {
  actorOf(ctx);
  const search = optString(args, 'search', 100);
  const role = optEnum(args, 'role', USER_ROLES, null as unknown as (typeof USER_ROLES)[number] | null);
  const status = optEnum(args, 'status', USER_STATUSES, null as unknown as (typeof USER_STATUSES)[number] | null);
  const limit = optInt(args, 'limit', 20, 1, 100);
  const offset = optInt(args, 'offset', 0, 0, 1_000_000);

  const conds: string[] = [];
  const params: any[] = [];
  let i = 1;
  if (search) {
    conds.push(`(email ILIKE $${i} OR first_name ILIKE $${i})`);
    params.push(`%${search}%`);
    i++;
  }
  if (role) { conds.push(`role = $${i}`); params.push(role); i++; }
  if (status) { conds.push(`status = $${i}`); params.push(status); i++; }
  const where = conds.length ? `WHERE ${conds.join(' AND ')}` : '';

  const totalRow: any = await queryOne(`SELECT COUNT(*) AS c FROM users ${where}`, params);
  const rows = await query(
    `SELECT id, email, first_name, role, status, created_at
     FROM users ${where} ORDER BY created_at DESC LIMIT $${i} OFFSET $${i + 1}`,
    [...params, limit, offset]
  );
  return {
    users: rows.map((u: any) => ({
      id: u.id,
      email: u.email,
      firstName: u.first_name,
      role: u.role,
      status: u.status,
      createdAt: u.created_at,
    })),
    total: countToNum(totalRow?.c),
  };
}, { auth: 'admin', roles: ADMIN_ROLES });

registerAction('getadminuserdetail', async (args, ctx) => {
  actorOf(ctx);
  const userId = reqId(args, 'userId');
  const user = await getFullUser(userId);
  if (!user) biz(USER_NOT_FOUND);

  const sessions = await query(
    `SELECT id, ip, user_agent AS "userAgent", created_at AS "createdAt",
            last_used_at AS "lastUsedAt", expires_at AS "expiresAt", revoked_at AS "revokedAt"
     FROM sessions WHERE user_id = $1 ORDER BY created_at DESC LIMIT 10`,
    [userId]
  );
  const receivedReports = await query(
    `SELECT r.id, r.category, r.details, r.status, r.created_at AS "createdAt",
            u.email AS "reporterEmail", u.first_name AS "reporterName"
     FROM reports r JOIN users u ON u.id = r.reporter_id
     WHERE r.target_id = $1 ORDER BY r.created_at DESC LIMIT 20`,
    [userId]
  );
  const subscriptions = await query(
    `SELECT s.id, s.plan_id AS "planId", p.name AS "planName", s.status,
            s.current_period_end AS "currentPeriodEnd", s.cancel_at_period_end AS "cancelAtPeriodEnd",
            s.created_at AS "createdAt"
     FROM subscriptions s LEFT JOIN subscription_plans p ON p.id = s.plan_id
     WHERE s.user_id = $1 ORDER BY s.created_at DESC LIMIT 20`,
    [userId]
  );
  const payments = await query(
    `SELECT id, kind, item_id AS "itemId", amount_cents AS "amountCents", currency,
            status, created_at AS "createdAt"
     FROM payments WHERE user_id = $1 ORDER BY created_at DESC LIMIT 20`,
    [userId]
  );
  const notes = await query(
    `SELECT n.id, n.note, n.created_at AS "createdAt",
            a.email AS "authorEmail", a.first_name AS "authorName"
     FROM admin_user_notes n LEFT JOIN users a ON a.id = n.author_id
     WHERE n.user_id = $1 ORDER BY n.created_at DESC LIMIT 20`,
    [userId]
  );
  return { user, sessions, receivedReports, subscriptions, payments, notes };
}, { auth: 'admin', roles: ADMIN_ROLES });

registerAction('adminchangeuserstatus', async (args, ctx) => {
  const actor = actorOf(ctx);
  const userId = reqId(args, 'userId');
  const status = reqEnum(args, 'status', ['active', 'suspended', 'banned'] as const);
  const reason = optString(args, 'reason', 500);

  const target: any = await queryOne(`SELECT id, role, status FROM users WHERE id = $1`, [userId]);
  if (!target) biz(USER_NOT_FOUND);
  await guardSuperAdmin(userId, actor.role);
  if (target.id === actor.id && (status === 'suspended' || status === 'banned')) {
    biz(INVALID_STATUS, 'cannot suspend/ban yourself');
  }

  const oldStatus = target.status;
  await query(`UPDATE users SET status = $1, updated_at = now() WHERE id = $2`, [status, userId]);
  if (status === 'suspended' || status === 'banned') {
    await query(`UPDATE sessions SET revoked_at = now() WHERE user_id = $1 AND revoked_at IS NULL`, [userId]);
  }
  await audit(actor.id, 'adminchangeuserstatus', 'user', userId, { oldStatus, newStatus: status, reason });
  return { ok: true, userId, status };
}, { auth: 'admin', roles: ADMIN_ROLES });

registerAction('admindeleteuser', async (args, ctx) => {
  const actor = actorOf(ctx);
  const userId = reqId(args, 'userId');
  const confirm = reqString(args, 'confirm', 1, 32);
  if (confirm !== 'DELETE') biz(INVALID_CONFIRM);

  const target: any = await queryOne(`SELECT id, role, status FROM users WHERE id = $1`, [userId]);
  if (!target) biz(USER_NOT_FOUND);
  await guardSuperAdmin(userId, actor.role);
  if (target.id === actor.id) biz(INVALID_STATUS, 'cannot delete yourself');

  await query(`UPDATE users SET status = 'deleted', updated_at = now() WHERE id = $1`, [userId]);
  await query(`UPDATE sessions SET revoked_at = now() WHERE user_id = $1 AND revoked_at IS NULL`, [userId]);
  await audit(actor.id, 'admindeleteuser', 'user', userId, { soft: true });
  return { ok: true, userId, status: 'deleted' };
}, { auth: 'admin', roles: ADMIN_ROLES });

// ============================ moderation queue ============================

registerAction('listadminmoderation', async (args, ctx) => {
  actorOf(ctx);
  const type = optEnum(args, 'type', ['reports', 'photos'] as const, null as unknown as 'reports' | 'photos' | null);
  const reportStatus = optEnum(args, 'status', REPORT_STATUSES, 'open');
  const photoStatus = optEnum(args, 'status', PHOTO_STATUSES, 'pending');
  const limit = optInt(args, 'limit', 20, 1, 100);
  const offset = optInt(args, 'offset', 0, 0, 1_000_000);

  // Fetch each side (capped), merge, sort by created_at desc, then paginate.
  const CAP = 500;
  const items: any[] = [];

  if (!type || type === 'reports') {
    const rows = await query(
      `SELECT r.id, r.category, r.details, r.status, r.created_at,
              r.reporter_id, ru.email AS reporter_email, ru.first_name AS reporter_name,
              r.target_id, tu.email AS target_email, tu.first_name AS target_name
       FROM reports r
       JOIN users ru ON ru.id = r.reporter_id
       JOIN users tu ON tu.id = r.target_id
       WHERE r.status = $1 ORDER BY r.created_at DESC LIMIT $2`,
      [reportStatus, CAP]
    );
    for (const r of rows) {
      items.push({
        queueType: 'report',
        id: r.id,
        category: r.category,
        details: r.details,
        status: r.status,
        createdAt: (r.created_at as Date)?.toISOString?.() ?? r.created_at,
        reporter: { id: r.reporter_id, email: r.reporter_email, firstName: r.reporter_name },
        target: { id: r.target_id, email: r.target_email, firstName: r.target_name },
      });
    }
  }

  if (!type || type === 'photos') {
    const rows = await query(
      `SELECT p.id, p.user_id, p.position, p.status, p.created_at,
              u.email AS user_email, u.first_name AS user_name
       FROM profile_photos p JOIN users u ON u.id = p.user_id
       WHERE p.status = $1 ORDER BY p.created_at DESC LIMIT $2`,
      [photoStatus, CAP]
    );
    for (const p of rows) {
      items.push({
        queueType: 'photo',
        id: p.id,
        position: p.position,
        status: p.status,
        createdAt: (p.created_at as Date)?.toISOString?.() ?? p.created_at,
        user: { id: p.user_id, email: p.user_email, firstName: p.user_name },
      });
    }
  }

  items.sort((a, b) => (a.createdAt < b.createdAt ? 1 : a.createdAt > b.createdAt ? -1 : 0));
  const total = items.length;
  return { items: items.slice(offset, offset + limit), total };
}, { auth: 'admin', roles: MOD_ROLES });

registerAction('moderatereport', async (args, ctx) => {
  const actor = actorOf(ctx);
  const reportId = reqId(args, 'reportId');
  const decision = reqEnum(args, 'decision', ['resolved', 'dismissed'] as const);
  const resolution = optString(args, 'resolution', 1000);
  const suspendTarget = optBoolean(args, 'suspendTarget', false);

  const report: any = await queryOne(`SELECT * FROM reports WHERE id = $1`, [reportId]);
  if (!report) biz(REPORT_NOT_FOUND);
  if (report.status === 'resolved' || report.status === 'dismissed') {
    biz(INVALID_STATUS, 'report already reviewed');
  }

  await query(
    `UPDATE reports SET status = $1, reviewed_by = $2, reviewed_at = now(), resolution = $3 WHERE id = $4`,
    [decision, actor.id, resolution, reportId]
  );

  let suspended: string | null = null;
  if (decision === 'resolved' && suspendTarget) {
    await guardSuperAdmin(report.target_id, actor.role);
    await query(`UPDATE users SET status = 'suspended', updated_at = now() WHERE id = $1`, [report.target_id]);
    await query(`UPDATE sessions SET revoked_at = now() WHERE user_id = $1 AND revoked_at IS NULL`, [report.target_id]);
    suspended = report.target_id;
    await audit(actor.id, 'moderatereport.suspend_target', 'user', report.target_id, { reportId });
  }

  await audit(actor.id, 'moderatereport', 'report', reportId, { decision, resolution, suspended });
  return { ok: true, reportId, decision, suspended };
}, { auth: 'admin', roles: MOD_ROLES });

registerAction('adminreviewphoto', async (args, ctx) => {
  const actor = actorOf(ctx);
  const photoId = reqId(args, 'photoId');
  const decision = reqEnum(args, 'decision', ['approved', 'rejected'] as const);

  const photo: any = await queryOne(`SELECT * FROM profile_photos WHERE id = $1`, [photoId]);
  if (!photo) biz(PHOTO_NOT_FOUND);
  if (photo.status !== 'pending') biz(INVALID_STATUS, 'photo already reviewed');

  await query(`UPDATE profile_photos SET status = $1 WHERE id = $2`, [decision, photoId]);

  if (decision === 'approved') {
    const others: any = await queryOne(
      `SELECT COUNT(*) AS c FROM profile_photos WHERE user_id = $1 AND id <> $2 AND status = 'approved'`,
      [photo.user_id, photoId]
    );
    if (countToNum(others?.c) === 0) {
      // It's the user's only approved photo — make it primary.
      await query(`UPDATE profile_photos SET is_primary = FALSE WHERE user_id = $1`, [photo.user_id]);
      await query(`UPDATE profile_photos SET is_primary = TRUE WHERE id = $1`, [photoId]);
    }
  }

  await audit(actor.id, 'adminreviewphoto', 'photo', photoId, { decision, userId: photo.user_id });
  return { ok: true, photoId, decision };
}, { auth: 'admin', roles: MOD_ROLES });

registerAction('getadminreportdetail', async (args, ctx) => {
  actorOf(ctx);
  const reportId = reqId(args, 'reportId');
  const report: any = await queryOne(`SELECT * FROM reports WHERE id = $1`, [reportId]);
  if (!report) biz(REPORT_NOT_FOUND);

  const reporter = await getFullUser(report.reporter_id);
  const target = await getFullUser(report.target_id);

  const evidence = report.evidence_mime
    ? {
        mime: report.evidence_mime,
        altText: report.evidence_alt ?? '',
        url: report.evidence_base64
          ? `data:${report.evidence_mime};base64,${report.evidence_base64}`
          : null,
      }
    : null;

  return {
    report: {
      id: report.id,
      category: report.category,
      details: report.details,
      status: report.status,
      resolution: report.resolution,
      reviewedBy: report.reviewed_by,
      reviewedAt: report.reviewed_at ? (report.reviewed_at as Date).toISOString() : null,
      createdAt: (report.created_at as Date).toISOString(),
    },
    reporter,
    target,
    evidence,
  };
}, { auth: 'admin', roles: MOD_ROLES });

registerAction('adminreviewsuspicious', async (args, ctx) => {
  actorOf(ctx);
  const limit = optInt(args, 'limit', 50, 1, 200);
  const offset = optInt(args, 'offset', 0, 0, 1_000_000);

  // 1) Reaction bursts: >100 reactions in the last hour.
  const burst = await query(
    `SELECT u.id, u.email, u.first_name, COUNT(*)::int AS n
     FROM reactions r JOIN users u ON u.id = r.sender_id
     WHERE r.created_at > now() - interval '1 hour'
     GROUP BY u.id, u.email, u.first_name HAVING COUNT(*) > 100`
  );
  // 2) Heavily reported: >5 reports received.
  const reported = await query(
    `SELECT u.id, u.email, u.first_name, COUNT(*)::int AS n
     FROM reports r JOIN users u ON u.id = r.target_id
     GROUP BY u.id, u.email, u.first_name HAVING COUNT(*) > 5`
  );
  // 3) Phone reuse: >3 accounts sharing the same phone number.
  const phoneReuse = await query(
    `SELECT u.id, u.email, u.first_name, u.phone, c.n
     FROM users u
     JOIN (SELECT phone, COUNT(*)::int AS n FROM users
           WHERE phone IS NOT NULL GROUP BY phone HAVING COUNT(*) > 3) c ON c.phone = u.phone`
  );

  const byUser = new Map<string, any>();
  const ensure = (id: string, email: string, firstName: string) => {
    if (!byUser.has(id)) byUser.set(id, { userId: id, email, firstName, reasons: [] });
    return byUser.get(id);
  };
  for (const r of burst) {
    ensure(r.id, r.email, r.first_name).reasons.push({
      code: 'REACTION_BURST',
      detail: `${r.n} reactions in the last hour`,
    });
  }
  for (const r of reported) {
    ensure(r.id, r.email, r.first_name).reasons.push({
      code: 'MANY_REPORTS',
      detail: `${r.n} reports received`,
    });
  }
  for (const r of phoneReuse) {
    ensure(r.id, r.email, r.first_name).reasons.push({
      code: 'SHARED_PHONE',
      detail: `${r.n} accounts share phone ${r.phone}`,
    });
  }

  const items = [...byUser.values()];
  return { items: items.slice(offset, offset + limit), total: items.length };
}, { auth: 'admin', roles: MOD_ROLES });

// ============================ settings ============================

registerAction('listadminsettings', async (_args, ctx) => {
  actorOf(ctx);
  const rows = await query(
    `SELECT key, value, updated_at FROM platform_settings ORDER BY key ASC`
  );
  return {
    settings: rows.map((r: any) => ({
      key: r.key,
      value: r.value,
      updatedAt: (r.updated_at as Date).toISOString(),
    })),
  };
}, { auth: 'admin', roles: ADMIN_ROLES });

registerAction('adminsavesetting', async (args, ctx) => {
  const actor = actorOf(ctx);
  const key = reqString(args, 'key', 1, 100);
  const value = args?.value;
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    biz(INVALID_ARGS, 'arg value must be a JSON object');
  }

  await query(
    `INSERT INTO platform_settings (key, value, updated_at) VALUES ($1, $2, now())
     ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = now()`,
    [key, JSON.stringify(value)]
  );
  await audit(actor.id, 'adminsavesetting', 'setting', key, { value });
  return { ok: true, key };
}, { auth: 'admin', roles: ADMIN_ROLES });

// ============================ plans ============================

function slugify(s: string): string {
  return (
    s
      .toLowerCase()
      .trim()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '')
      .slice(0, 60) || 'plan'
  );
}

registerAction('adminsaveplan', async (args, ctx) => {
  const actor = actorOf(ctx);
  const plan = args?.plan;
  if (typeof plan !== 'object' || plan === null || Array.isArray(plan)) biz(INVALID_ARGS, 'arg plan');

  const rawId = optString(plan, 'id', 100);
  const name = reqString(plan, 'name', 1, 200);
  const interval = reqEnum(plan, 'interval', PLAN_INTERVALS);
  const priceCents = reqInt(plan, 'priceCents', 0, 100_000_000);
  const currency = (optString(plan, 'currency', 3) ?? 'USD').toUpperCase();
  const benefits = reqArray<string>(plan, 'benefits', 0, 50, (x) => {
    if (typeof x !== 'string' || x.length > 500) biz(INVALID_ARGS, 'arg plan.benefits[]');
    return x;
  });
  const active = optBoolean(plan, 'active', true);

  const id = rawId ?? `${slugify(name)}-${Date.now().toString(36)}`;
  const existing: any = await queryOne(`SELECT id FROM subscription_plans WHERE id = $1`, [id]);

  if (existing) {
    await query(
      `UPDATE subscription_plans
       SET name = $2, interval = $3, price_cents = $4, currency = $5, benefits = $6, active = $7
       WHERE id = $1`,
      [id, name, interval, priceCents, currency, JSON.stringify(benefits), active]
    );
    await audit(actor.id, 'adminsaveplan', 'plan', id, { op: 'update', name, interval, priceCents, active });
  } else {
    await query(
      `INSERT INTO subscription_plans (id, name, interval, price_cents, currency, benefits, active)
       VALUES ($1, $2, $3, $4, $5, $6, $7)`,
      [id, name, interval, priceCents, currency, JSON.stringify(benefits), active]
    );
    await audit(actor.id, 'adminsaveplan', 'plan', id, { op: 'create', name, interval, priceCents, active });
  }
  return { ok: true, id };
}, { auth: 'admin', roles: ADMIN_ROLES });

// ============================ announcements ============================

registerAction('admincreateannouncement', async (args, ctx) => {
  const actor = actorOf(ctx);
  const title = reqString(args, 'title', 1, 200);
  const body = reqString(args, 'body', 1, 10000);
  const segment = reqEnum(args, 'segment', SEGMENTS);
  const region = optString(args, 'region', 100);

  const rows = await query(
    `INSERT INTO announcements (id, title, body, segment, region, created_by)
     VALUES (gen_random_uuid(), $1, $2, $3, $4, $5) RETURNING id, created_at`,
    [title, body, segment, region, actor.id]
  );
  const id: string = rows[0].id;
  await audit(actor.id, 'admincreateannouncement', 'announcement', id, { title, segment, region });
  return { ok: true, id };
}, { auth: 'admin', roles: ADMIN_ROLES });
// ============================ analytics ============================

registerAction('getadminanalytics', async (args, ctx) => {
  actorOf(ctx);
  const groupBy = optEnum(args, 'groupBy', ['day', 'week', 'month'] as const, 'day') ?? 'day';
  const fromStr = optString(args, 'from', 10);
  const toStr = optString(args, 'to', 10);

  const today = new Date();
  const todayUtc = new Date(Date.UTC(today.getUTCFullYear(), today.getUTCMonth(), today.getUTCDate()));
  const defaultFrom = new Date(todayUtc.getTime() - 29 * 86400_000);

  const fromDate = fromStr ? parseBirthDate(fromStr) : defaultFrom;
  const toDate = toStr ? parseBirthDate(toStr) : todayUtc;
  if (!fromDate || !toDate || fromDate.getTime() > toDate.getTime()) biz(INVALID_ARGS, 'invalid from/to');

  const trunc = groupBy === 'day' ? 'day' : groupBy === 'week' ? 'week' : 'month';
  const step = groupBy === 'day' ? '1 day' : groupBy === 'week' ? '1 week' : '1 month';

  const rows = await query(
    `WITH buckets AS (
       SELECT generate_series(
         date_trunc($3, $1::timestamptz),
         date_trunc($3, $2::timestamptz),
         $4::interval
       ) AS bucket
     )
     SELECT b.bucket,
       (SELECT COUNT(*) FROM users u WHERE date_trunc($3, u.created_at) = b.bucket) AS registrations,
       (SELECT COUNT(*) FROM matches m WHERE date_trunc($3, m.created_at) = b.bucket) AS matches,
       (SELECT COUNT(*) FROM messages ms WHERE date_trunc($3, ms.created_at) = b.bucket) AS messages,
       (SELECT COUNT(*) FROM payments p
         WHERE date_trunc($3, p.created_at) = b.bucket AND p.status = 'completed') AS payments
     FROM buckets b ORDER BY b.bucket ASC`,
    [
      fromDate.toISOString(),
      toDate.toISOString(),
      trunc,
      step,
    ]
  );

  return {
    groupBy,
    from: fromDate.toISOString().slice(0, 10),
    to: toDate.toISOString().slice(0, 10),
    series: rows.map((r: any) => ({
      bucket: (r.bucket as Date).toISOString().slice(0, 10),
      registrations: countToNum(r.registrations),
      matches: countToNum(r.matches),
      messages: countToNum(r.messages),
      payments: countToNum(r.payments),
    })),
  };
}, { auth: 'admin', roles: ADMIN_ROLES });

registerAction('getadminmetrics', async (_args, ctx) => {
  actorOf(ctx);
  const r: any = await queryOne(`
    SELECT
      (SELECT COUNT(*) FROM users WHERE status <> 'deleted') AS "usersTotal",
      (SELECT COUNT(*) FROM matches) AS "matchesTotal",
      (SELECT COUNT(*) FROM messages) AS "messagesTotal",
      (SELECT COUNT(*) FROM payments WHERE status = 'completed') AS "paymentsTotal",
      (SELECT COALESCE(SUM(amount_cents), 0) FROM payments WHERE status = 'completed') AS "revenueCentsTotal",
      (SELECT COUNT(*) FROM subscriptions WHERE status = 'active' AND current_period_end > now()) AS "activeSubscriptions",
      (SELECT COUNT(*) FROM users WHERE created_at > now() - interval '30 days') AS "users30d",
      (SELECT COUNT(*) FROM matches WHERE created_at > now() - interval '30 days') AS "matches30d",
      (SELECT COUNT(*) FROM messages WHERE created_at > now() - interval '30 days') AS "messages30d",
      (SELECT COUNT(*) FROM payments WHERE status = 'completed' AND created_at > now() - interval '30 days') AS "payments30d",
      (SELECT COALESCE(SUM(amount_cents), 0) FROM payments
        WHERE status = 'completed' AND created_at > now() - interval '30 days') AS "revenueCents30d"
  `);
  return {
    usersTotal: countToNum(r.usersTotal),
    matchesTotal: countToNum(r.matchesTotal),
    messagesTotal: countToNum(r.messagesTotal),
    paymentsTotal: countToNum(r.paymentsTotal),
    revenueCentsTotal: countToNum(r.revenueCentsTotal),
    activeSubscriptions: countToNum(r.activeSubscriptions),
    last30d: {
      users: countToNum(r.users30d),
      matches: countToNum(r.matches30d),
      messages: countToNum(r.messages30d),
      payments: countToNum(r.payments30d),
      revenueCents: countToNum(r.revenueCents30d),
    },
  };
}, { auth: 'admin', roles: ADMIN_ROLES });

// ============================ commerce ============================

registerAction('getadmincommerce', async (args, ctx) => {
  actorOf(ctx);
  const status = optEnum(args, 'status', PAYMENT_STATUSES, null as unknown as (typeof PAYMENT_STATUSES)[number] | null);
  const limit = optInt(args, 'limit', 20, 1, 100);
  const offset = optInt(args, 'offset', 0, 0, 1_000_000);

  const conds: string[] = [];
  const params: any[] = [];
  let i = 1;
  if (status) { conds.push(`p.status = $${i}`); params.push(status); i++; }
  const where = conds.length ? `WHERE ${conds.join(' AND ')}` : '';

  const totalRow: any = await queryOne(`SELECT COUNT(*) AS c FROM payments p ${where}`, params);
  const rows = await query(
    `SELECT p.id, p.user_id AS "userId", u.email AS "userEmail",
            p.kind, p.item_id AS "itemId", p.amount_cents AS "amountCents",
            p.currency, p.status, p.stripe_session_id AS "stripeSessionId",
            p.stripe_payment_intent AS "stripePaymentIntent", p.created_at AS "createdAt"
     FROM payments p JOIN users u ON u.id = p.user_id
     ${where} ORDER BY p.created_at DESC LIMIT $${i} OFFSET $${i + 1}`,
    [...params, limit, offset]
  );
  return {
    payments: rows.map((p: any) => ({
      ...p,
      createdAt: (p.createdAt as Date).toISOString(),
    })),
    total: countToNum(totalRow?.c),
  };
}, { auth: 'admin', roles: ADMIN_ROLES });

registerAction('getadminpaymentdetail', async (args, ctx) => {
  actorOf(ctx);
  const paymentId = reqId(args, 'paymentId');
  const payment: any = await queryOne(
    `SELECT id, user_id AS "userId", kind, item_id AS "itemId", amount_cents AS "amountCents",
            currency, status, stripe_session_id AS "stripeSessionId",
            stripe_payment_intent AS "stripePaymentIntent", created_at AS "createdAt"
     FROM payments WHERE id = $1`,
    [paymentId]
  );
  if (!payment) biz(PAYMENT_NOT_FOUND);
  payment.createdAt = (payment.createdAt as Date).toISOString();

  const user = await getFullUser(payment.userId);
  const refunds = await query(
    `SELECT id, payment_id AS "paymentId", user_id AS "userId", reason, status,
            stripe_refund_id AS "stripeRefundId", reviewed_by AS "reviewedBy",
            created_at AS "createdAt", decided_at AS "decidedAt"
     FROM payment_refunds WHERE payment_id = $1 ORDER BY created_at DESC`,
    [paymentId]
  );
  return {
    payment,
    user,
    refunds: refunds.map((r: any) => ({
      ...r,
      createdAt: (r.createdAt as Date).toISOString(),
      decidedAt: r.decidedAt ? (r.decidedAt as Date).toISOString() : null,
    })),
  };
}, { auth: 'admin', roles: ADMIN_ROLES });

registerAction('adminreviewrefund', async (args, ctx) => {
  const actor = actorOf(ctx);
  const refundId = reqId(args, 'refundId');
  const decision = reqEnum(args, 'decision', ['approved', 'rejected'] as const);

  const refund: any = await queryOne(
    `SELECT r.id, r.payment_id, r.user_id, r.reason, r.status,
            p.stripe_payment_intent, p.amount_cents
     FROM payment_refunds r JOIN payments p ON p.id = r.payment_id
     WHERE r.id = $1`,
    [refundId]
  );
  if (!refund) biz(PAYMENT_NOT_FOUND, 'refund');
  if (refund.status !== 'requested') biz(INVALID_STATUS, 'refund already decided');

  if (decision === 'rejected') {
    await query(
      `UPDATE payment_refunds SET status = 'rejected', reviewed_by = $2, decided_at = now() WHERE id = $1`,
      [refundId, actor.id]
    );
    await audit(actor.id, 'adminreviewrefund', 'refund', refundId, { decision, paymentId: refund.payment_id });
    await notifyUser(refund.user_id, 'security', 'Refund request declined', 'Your refund request was reviewed and declined. Contact support if you disagree.', { refundId, paymentId: refund.payment_id });
    return { ok: true, refundId, decision, status: 'rejected' };
  }

  // Approved: try to execute via Stripe when possible; otherwise leave as
  // 'approved' so an admin executes it manually — honest, never simulated.
  const canExecute = stripeConfigured() && !!refund.stripe_payment_intent;
  if (canExecute) {
    const stripeRefund: any = await createRefund(refund.stripe_payment_intent);
    await query(
      `UPDATE payment_refunds SET status = 'executed', stripe_refund_id = $2, reviewed_by = $3, decided_at = now()
       WHERE id = $1`,
      [refundId, String(stripeRefund?.id ?? ''), actor.id]
    );
    await query(`UPDATE payments SET status = 'refunded' WHERE id = $1`, [refund.payment_id]);
    await audit(actor.id, 'adminreviewrefund', 'refund', refundId, {
      decision, status: 'executed', paymentId: refund.payment_id, stripeRefundId: stripeRefund?.id ?? null,
    });
    await notifyUser(refund.user_id, 'security', 'Refund executed', 'Your refund has been processed and will arrive according to your bank\'s timing.', { refundId, paymentId: refund.payment_id });
    return { ok: true, refundId, decision, status: 'executed', stripeRefundId: stripeRefund?.id ?? null };
  }

  await query(
    `UPDATE payment_refunds SET status = 'approved', reviewed_by = $2, decided_at = now() WHERE id = $1`,
    [refundId, actor.id]
  );
  await audit(actor.id, 'adminreviewrefund', 'refund', refundId, {
    decision, status: 'approved', paymentId: refund.payment_id,
    note: 'manual execution pending — no Stripe payment intent on file',
  });
  await notifyUser(refund.user_id, 'security', 'Refund approved', 'Your refund request was approved. It will be executed shortly.', { refundId, paymentId: refund.payment_id });
  return { ok: true, refundId, decision, status: 'approved', note: 'manual execution pending' };
}, { auth: 'admin', roles: ADMIN_ROLES });

// ==================== TEMPORARY bootstrap (removed after first use) ====================
// One-time promotion of the owner's account to SUPER_ADMIN. Guarded by
// BOOTSTRAP_SECRET env var. Delete this block once the owner is promoted.
registerAction('bootstrapadmin', async (args) => {
  const secret = process.env.BOOTSTRAP_SECRET ?? '';
  const provided = typeof args?.secret === 'string' ? args.secret : '';
  if (!secret || provided.length !== secret.length) biz(ADMIN_ONLY);
  let diff = 0;
  for (let i = 0; i < secret.length; i++) diff |= secret.charCodeAt(i) ^ provided.charCodeAt(i);
  if (diff !== 0) biz(ADMIN_ONLY);
  const email = reqString(args, 'email', 1, 254);
  const row: any = await queryOne(`SELECT id, role FROM users WHERE lower(email) = lower($1)`, [email]);
  if (!row) biz(USER_NOT_FOUND);
  await query(`UPDATE users SET role = 'SUPER_ADMIN', updated_at = now() WHERE id = $1`, [row.id]);
  await audit(row.id, 'bootstrapadmin', 'user', row.id, { from: row.role });
  return { ok: true, email };
}, { auth: 'none' });
