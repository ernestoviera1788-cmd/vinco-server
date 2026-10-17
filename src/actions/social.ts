// VINCÓ social module: discovery, reactions, matches, messaging, notifications.
// Registered as RPC actions on import (see src/index.ts).
import { query, queryOne, tx } from '../db.js';
import {
  biz,
  INVALID_ARGS,
  SELF_ACTION,
  TARGET_NOT_FOUND,
  ALREADY_REACTED,
  MATCH_NOT_FOUND,
  ALREADY_BLOCKED,
  USER_BLOCKED,
  INVALID_REPORT_CATEGORY,
  EVIDENCE_TOO_LARGE,
  LIKES_GATED,
  CONVERSATION_NOT_FOUND,
  NOT_IN_CONVERSATION,
  MESSAGE_EMPTY,
  MESSAGE_TOO_LONG,
  NOTIFICATION_NOT_FOUND,
} from '../errors.js';
import { optString, reqBoolean, reqString } from '../validation.js';
import { registerAction } from '../rpc.js';
import type { ActionContext } from '../rpc.js';
import { getPublicUserCard, blocksEither, hasActiveSubscription } from '../users.js';
import { notifyUser } from '../notify.js';
import { pushToUser } from '../push.js';

// ---- local helpers ----

function optInt(args: any, name: string, def: number, min: number, max: number): number {
  const v = args?.[name];
  if (v === undefined || v === null) return def;
  if (typeof v !== 'number' || !Number.isInteger(v) || v < min || v > max) biz(INVALID_ARGS, `arg ${name}`);
  return v;
}

function t(locale: any, en: string, es: string): string {
  return locale === 'es' ? es : en;
}

// Throws TARGET_NOT_FOUND unless the target exists and is active.
async function activeTarget(targetId: string): Promise<any> {
  const row = await queryOne(
    `SELECT id, first_name, locale FROM users WHERE id = $1 AND status = 'active'`,
    [targetId]
  );
  if (!row) biz(TARGET_NOT_FOUND);
  return row;
}

type ConvMatch = { id: string; user_a: string; user_b: string; unmatched_at: any };

// Loads a conversation through its match; viewer participation is NOT checked here.
async function getConversation(conversationId: string): Promise<ConvMatch | null> {
  return queryOne<ConvMatch>(
    `SELECT c.id, m.user_a, m.user_b, m.unmatched_at
     FROM conversations c JOIN matches m ON m.id = c.match_id
     WHERE c.id = $1`,
    [conversationId]
  );
}

function otherUserId(conv: ConvMatch, viewer: string): string {
  return conv.user_a === viewer ? conv.user_b : conv.user_a;
}

// ---- 1. discovery feed ----

async function listDiscovery(args: any, ctx: ActionContext) {
  const viewer = ctx.user!.id;
  const limit = optInt(args, 'limit', 20, 1, 50);
  const offset = optInt(args, 'offset', 0, 0, 1000000);

  // ---- Secondary filters (from the Filters sheet; stored locally on device) ----
  const withPhoto = args?.withPhoto === true;
  const verifiedOnly = args?.verifiedOnly === true;
  const onlineNow = args?.onlineNow === true;
  const recentlyActive = args?.recentlyActive === true;
  const commonInterests = args?.commonInterests === true;
  const newProfiles = args?.newProfiles === true;
  const sortByRaw = typeof args?.sortBy === 'string' ? args.sortBy : 'recommended';
  const sortBy = ['recommended', 'closest', 'recent', 'active'].includes(sortByRaw) ? sortByRaw : 'recommended';

  const prefs = await queryOne(
    `SELECT preferred_gender, age_min, age_max, hobbies FROM profiles WHERE user_id = $1`,
    [viewer]
  );
  const preferredGender: string = typeof args?.preferredGender === 'string'
    ? args.preferredGender
    : ((prefs?.preferred_gender as string) ?? '');
  const viewerHobbies: string = (prefs?.hobbies as string) ?? '';

  // "Closest" is only a same-city sorting proxy; no distance cutoff is applied.
  const viewerRow = await queryOne(`SELECT city FROM users WHERE id = $1`, [viewer]);
  const viewerCity: string = (viewerRow?.city as string) ?? '';

  let where = `u.id <> $1
    AND u.status = 'active'
    AND p.profile_visible = TRUE
    AND NOT EXISTS (SELECT 1 FROM reactions r WHERE r.sender_id = $1 AND r.target_id = u.id)
    AND NOT EXISTS (SELECT 1 FROM matches m WHERE m.unmatched_at IS NULL
      AND ((m.user_a = $1 AND m.user_b = u.id) OR (m.user_b = $1 AND m.user_a = u.id)))
    AND NOT EXISTS (SELECT 1 FROM blocks b
      WHERE (b.blocker_id = $1 AND b.blocked_id = u.id) OR (b.blocker_id = u.id AND b.blocked_id = $1))`;
  const params: any[] = [viewer];
  // Gender filter: free-text on both sides, so compare case-insensitively and
  // tolerate singular/plural ("Mujer" vs "Mujeres"). "Todos"/"Everyone"/etc.
  // (or empty) means no gender filter at all.
  const prefNorm = preferredGender.trim().toLowerCase();
  const noGenderFilter = new Set(['', 'todos', 'todas', 'todo', 'everything', 'everyone', 'everybody', 'all']);
  if (!noGenderFilter.has(prefNorm)) {
    params.push(prefNorm);
    const gp = `$${params.length}`;
    where += ` AND (LOWER(u.gender) = ${gp}
      OR LOWER(u.gender) = regexp_replace(${gp}, 'es$', '')
      OR LOWER(u.gender) = regexp_replace(${gp}, 's$', '')
      OR ${gp} = regexp_replace(LOWER(u.gender), 'es$', '')
      OR ${gp} = regexp_replace(LOWER(u.gender), 's$', ''))`;
  }

  // ---- Secondary filters (only narrow the preference-eligible set) ----
  if (withPhoto) {
    where += ` AND EXISTS (SELECT 1 FROM profile_photos pp
      WHERE pp.user_id = u.id AND pp.status = 'approved')`;
  }
  if (verifiedOnly) {
    where += ` AND (u.email_verified = TRUE OR u.phone_verified = TRUE)`;
  }
  if (onlineNow) {
    where += ` AND u.last_login_at IS NOT NULL AND u.last_login_at > now() - interval '15 minutes'`;
  }
  if (recentlyActive) {
    where += ` AND u.last_login_at IS NOT NULL AND u.last_login_at > now() - interval '7 days'`;
  }
  if (newProfiles) {
    where += ` AND u.created_at > now() - interval '30 days'`;
  }
  if (commonInterests) {
    const terms = viewerHobbies
      .split(',')
      .map((s: string) => s.trim().toLowerCase())
      .filter((s: string) => s.length >= 2);
    if (terms.length > 0) {
      // At least one shared interest term (case-insensitive substring match).
      const ors = terms.map((t: string) => {
        params.push(`%${t}%`);
        return `LOWER(p.hobbies) LIKE $${params.length}`;
      });
      where += ` AND (${ors.join(' OR ')})`;
    }
    // If the viewer has no interests listed, the filter can't narrow: skip it
    // rather than returning an empty feed.
  }

  const from = `FROM users u JOIN profiles p ON p.user_id = u.id WHERE ${where}`;

  // ---- Ordering ----
  let orderBy: string;
  switch (sortBy) {
    case 'closest':
      // No geo coordinates stored; same-city first is the closest proxy.
      params.push(viewerCity);
      orderBy = `ORDER BY CASE WHEN LOWER(u.city) = LOWER($${params.length}) THEN 0 ELSE 1 END, u.created_at DESC`;
      break;
    case 'recent':
      orderBy = `ORDER BY u.created_at DESC`;
      break;
    case 'active':
      orderBy = `ORDER BY u.last_login_at DESC NULLS LAST, u.created_at DESC`;
      break;
    case 'recommended':
    default:
      orderBy = `ORDER BY CASE WHEN EXISTS
        (SELECT 1 FROM user_boosts ub WHERE ub.user_id = u.id AND ub.status = 'active' AND ub.expires_at > now())
        THEN 0 ELSE 1 END, u.created_at DESC`;
      break;
  }

  const totalRow = await queryOne<{ total: number }>(`SELECT COUNT(*)::int AS total ${from}`, params);
  const rows = await query<{ id: string }>(
    `SELECT u.id ${from} ${orderBy} LIMIT $${params.length + 1} OFFSET $${params.length + 2}`,
    [...params, limit, offset]
  );

  const users = [];
  for (const r of rows) {
    const card = await getPublicUserCard(r.id);
    if (card) users.push(card);
  }
  return { users, total: totalRow?.total ?? 0 };
}

// ---- 2. react to profile ----

type ReactResult = { matched: boolean; matchId: string | null; conversationId: string | null };

async function reactToProfile(args: any, ctx: ActionContext) {
  const viewer = ctx.user!.id;
  const targetId = reqString(args, 'targetId', 1, 64);
  const kind = reqString(args, 'kind', 1, 16);
  if (!['LIKE', 'PASS', 'SUPER_LIKE'].includes(kind)) biz(INVALID_ARGS, 'arg kind');
  if (targetId === viewer) biz(SELF_ACTION);
  const target = await activeTarget(targetId);
  if (await blocksEither(viewer, targetId)) biz(USER_BLOCKED);
  const prior = await queryOne(
    `SELECT 1 FROM reactions WHERE sender_id = $1 AND target_id = $2`,
    [viewer, targetId]
  );
  if (prior) biz(ALREADY_REACTED);

  const isLike = kind === 'LIKE' || kind === 'SUPER_LIKE';

  const out = await tx<ReactResult>(async (c) => {
    await c.query(
      `INSERT INTO reactions (id, sender_id, target_id, kind)
       VALUES (gen_random_uuid(), $1, $2, $3)`,
      [viewer, targetId, kind]
    );
    if (!isLike) return { matched: false, matchId: null, conversationId: null };

    const reciprocal = await c.query(
      `SELECT 1 FROM reactions
       WHERE sender_id = $1 AND target_id = $2 AND kind IN ('LIKE','SUPER_LIKE')`,
      [targetId, viewer]
    );
    if ((reciprocal.rowCount ?? 0) === 0) return { matched: false, matchId: null, conversationId: null };

    const existing = await c.query(
      `SELECT id, conversation_id FROM matches
       WHERE unmatched_at IS NULL
         AND ((user_a = $1 AND user_b = $2) OR (user_a = $2 AND user_b = $1))`,
      [viewer, targetId]
    );
    if ((existing.rowCount ?? 0) > 0) {
      return {
        matched: true,
        matchId: existing.rows[0].id as string,
        conversationId: existing.rows[0].conversation_id as string,
      };
    }

    const userA = viewer < targetId ? viewer : targetId;
    const userB = viewer < targetId ? targetId : viewer;
    const mr = await c.query(
      `INSERT INTO matches (id, user_a, user_b, conversation_id)
       VALUES (gen_random_uuid(), $1, $2, gen_random_uuid())
       RETURNING id, conversation_id`,
      [userA, userB]
    );
    const matchId = mr.rows[0].id as string;
    const conversationId = mr.rows[0].conversation_id as string;
    await c.query(`INSERT INTO conversations (id, match_id) VALUES ($1, $2)`, [conversationId, matchId]);
    return { matched: true, matchId, conversationId };
  });

  if (out.matched) {
    const viewerName = ctx.user!.firstName;
    const viewerLocale = ctx.user!.locale;
    await notifyUser(
      targetId, 'match',
      t(target.locale, "It's a match!", '¡Es un match!'),
      t(target.locale,
        `You and ${viewerName} liked each other. Say hello!`,
        `A ti y a ${viewerName} les gustaron sus perfiles. ¡Salúdense!`),
      { matchId: out.matchId, conversationId: out.conversationId, userId: viewer }
    );
    await notifyUser(
      viewer, 'match',
      t(viewerLocale, "It's a match!", '¡Es un match!'),
      t(viewerLocale,
        `You and ${target.first_name} liked each other. Say hello!`,
        `A ti y a ${target.first_name} les gustaron sus perfiles. ¡Salúdense!`),
      { matchId: out.matchId, conversationId: out.conversationId, userId: targetId }
    );
  }

  return {
    ok: true,
    matched: out.matched,
    ...(out.matched ? { matchId: out.matchId, conversationId: out.conversationId } : {}),
  };
}

// ---- 3. who liked me (premium gated) ----

async function listLikes(args: any, ctx: ActionContext) {
  const viewer = ctx.user!.id;
  void args;
  if (!(await hasActiveSubscription(viewer))) biz(LIKES_GATED);

  const rows = await query<{ id: string }>(
    `SELECT r.sender_id AS id, MAX(r.created_at) AS liked_at
     FROM reactions r
     JOIN users u ON u.id = r.sender_id
     JOIN profiles p ON p.user_id = u.id
     WHERE r.target_id = $1 AND r.kind IN ('LIKE','SUPER_LIKE')
       AND u.status = 'active' AND p.profile_visible = TRUE
       AND NOT EXISTS (SELECT 1 FROM reactions r2 WHERE r2.sender_id = $1 AND r2.target_id = r.sender_id)
       AND NOT EXISTS (SELECT 1 FROM matches m WHERE m.unmatched_at IS NULL
         AND ((m.user_a = $1 AND m.user_b = r.sender_id) OR (m.user_b = $1 AND m.user_a = r.sender_id)))
       AND NOT EXISTS (SELECT 1 FROM blocks b
         WHERE (b.blocker_id = $1 AND b.blocked_id = r.sender_id)
            OR (b.blocker_id = r.sender_id AND b.blocked_id = $1))
     GROUP BY r.sender_id
     ORDER BY liked_at DESC`,
    [viewer]
  );

  const users = [];
  for (const r of rows) {
    const card = await getPublicUserCard(r.id);
    if (card) users.push(card);
  }
  return { users };
}

// ---- 4. matches ----

async function listMatches(args: any, ctx: ActionContext) {
  const viewer = ctx.user!.id;
  void args;
  const rows = await query(
    `SELECT m.id AS match_id, m.conversation_id, m.created_at,
            CASE WHEN m.user_a = $1 THEN m.user_b ELSE m.user_a END AS other_id
     FROM matches m
     WHERE (m.user_a = $1 OR m.user_b = $1) AND m.unmatched_at IS NULL
     ORDER BY m.created_at DESC`,
    [viewer]
  );

  const matches = [];
  for (const m of rows) {
    const card = await getPublicUserCard(m.other_id);
    if (!card) continue;
    const last = await queryOne(
      `SELECT id, sender_id, body, created_at FROM messages
       WHERE conversation_id = $1 ORDER BY created_at DESC LIMIT 1`,
      [m.conversation_id]
    );
    matches.push({
      matchId: m.match_id,
      conversationId: m.conversation_id,
      createdAt: m.created_at,
      user: card,
      lastMessage: last
        ? {
            id: last.id,
            senderId: last.sender_id,
            body: last.body,
            createdAt: last.created_at,
            mine: last.sender_id === viewer,
          }
        : null,
    });
  }
  return { matches };
}

// ---- 5. unmatch ----

async function unmatch(args: any, ctx: ActionContext) {
  const viewer = ctx.user!.id;
  const matchId = reqString(args, 'matchId', 1, 64);
  const r = await queryOne(
    `UPDATE matches SET unmatched_at = now(), unmatched_by = $1
     WHERE id = $2 AND (user_a = $1 OR user_b = $1) AND unmatched_at IS NULL
     RETURNING id`,
    [viewer, matchId]
  );
  if (!r) biz(MATCH_NOT_FOUND);
  return { ok: true };
}

// ---- 6. block user ----

async function blockUser(args: any, ctx: ActionContext) {
  const viewer = ctx.user!.id;
  const targetId = reqString(args, 'targetId', 1, 64);
  if (targetId === viewer) biz(SELF_ACTION);
  await activeTarget(targetId);
  const existing = await queryOne(
    `SELECT 1 FROM blocks WHERE blocker_id = $1 AND blocked_id = $2`,
    [viewer, targetId]
  );
  if (existing) biz(ALREADY_BLOCKED);

  await tx(async (c) => {
    await c.query(
      `INSERT INTO blocks (id, blocker_id, blocked_id) VALUES (gen_random_uuid(), $1, $2)`,
      [viewer, targetId]
    );
    // Silent unmatch: drop reactions both ways and close active matches.
    await c.query(
      `DELETE FROM reactions WHERE (sender_id = $1 AND target_id = $2) OR (sender_id = $2 AND target_id = $1)`,
      [viewer, targetId]
    );
    await c.query(
      `UPDATE matches SET unmatched_at = now(), unmatched_by = $1
       WHERE unmatched_at IS NULL
         AND ((user_a = $1 AND user_b = $2) OR (user_a = $2 AND user_b = $1))`,
      [viewer, targetId]
    );
  });
  return { ok: true };
}

// ---- 7. report user ----

const REPORT_CATEGORIES = [
  'Fake profile',
  'Scam',
  'Harassment',
  'Spam',
  'Inappropriate content',
  'Threatening behavior',
  'Impersonation',
  'Other',
] as const;

const MAX_EVIDENCE_BYTES = 10 * 1024 * 1024;

async function reportUser(args: any, ctx: ActionContext) {
  const viewer = ctx.user!.id;
  const targetId = reqString(args, 'targetId', 1, 64);
  if (targetId === viewer) biz(SELF_ACTION);
  await activeTarget(targetId);

  const category = args?.category;
  if (typeof category !== 'string' || !(REPORT_CATEGORIES as readonly string[]).includes(category)) {
    biz(INVALID_REPORT_CATEGORY);
  }
  const details = optString(args, 'details', 1000);

  let evidenceMime: string | null = null;
  let evidenceBase64: string | null = null;
  let evidenceAlt: string | null = null;
  const ev = args?.evidence;
  if (ev !== undefined && ev !== null) {
    if (typeof ev !== 'object' || Array.isArray(ev)) biz(INVALID_ARGS, 'arg evidence');
    if (ev.mimeType !== 'image/jpeg' && ev.mimeType !== 'image/png') biz(INVALID_ARGS, 'arg evidence.mimeType');
    const b64 = ev.dataBase64;
    if (typeof b64 !== 'string' || b64.length === 0) biz(INVALID_ARGS, 'arg evidence.dataBase64');
    if (Buffer.from(b64, 'base64').length > MAX_EVIDENCE_BYTES) biz(EVIDENCE_TOO_LARGE);
    evidenceMime = ev.mimeType;
    evidenceBase64 = b64;
    const alt = ev.altText;
    if (alt !== undefined && alt !== null && alt !== '') {
      if (typeof alt !== 'string' || alt.length > 200) biz(INVALID_ARGS, 'arg evidence.altText');
      evidenceAlt = alt.trim() || null;
    }
  }

  const row = await queryOne<{ id: string }>(
    `INSERT INTO reports (id, reporter_id, target_id, category, details, evidence_mime, evidence_base64, evidence_alt, status)
     VALUES (gen_random_uuid(), $1, $2, $3, $4, $5, $6, $7, 'open')
     RETURNING id`,
    [viewer, targetId, category, details, evidenceMime, evidenceBase64, evidenceAlt]
  );
  return { ok: true, reportId: row!.id };
}

// ---- 8. list messages ----

async function listMessages(args: any, ctx: ActionContext) {
  const viewer = ctx.user!.id;
  const conversationId = reqString(args, 'conversationId', 1, 64);
  const conv = await getConversation(conversationId);
  if (!conv) biz(CONVERSATION_NOT_FOUND);
  if (conv.user_a !== viewer && conv.user_b !== viewer) biz(NOT_IN_CONVERSATION);

  await query(
    `UPDATE messages SET read_at = now()
     WHERE conversation_id = $1 AND sender_id <> $2 AND read_at IS NULL`,
    [conversationId, viewer]
  );
  // Also mark message notifications for this conversation as read: opening
  // the chat is the definitive "read" signal, so the unread indicator must
  // clear even if the client's separate mark-read call fails or is delayed.
  await query(
    `UPDATE notifications SET read_at = now()
     WHERE user_id = $1 AND type = 'message' AND read_at IS NULL
       AND (data->>'conversationId') = $2`,
    [viewer, conversationId]
  );
  const rows = await query(
    `SELECT id, sender_id, body, read_at, created_at FROM messages
     WHERE conversation_id = $1 ORDER BY created_at ASC`,
    [conversationId]
  );
  return {
    messages: rows.map((m: any) => ({
      id: m.id,
      senderId: m.sender_id,
      body: m.body,
      readAt: m.read_at,
      createdAt: m.created_at,
      mine: m.sender_id === viewer,
    })),
  };
}

// ---- 9. send message ----

async function sendMessage(args: any, ctx: ActionContext) {
  const viewer = ctx.user!.id;
  const conversationId = reqString(args, 'conversationId', 1, 64);
  const rawBody = args?.body;
  if (typeof rawBody !== 'string' || rawBody.trim().length === 0) biz(MESSAGE_EMPTY);
  const body = rawBody.trim();
  if (body.length > 2000) biz(MESSAGE_TOO_LONG);

  const conv = await getConversation(conversationId);
  if (!conv) biz(CONVERSATION_NOT_FOUND);
  if (conv.user_a !== viewer && conv.user_b !== viewer) biz(NOT_IN_CONVERSATION);
  if (conv.unmatched_at) biz(NOT_IN_CONVERSATION);

  const msg = await queryOne(
    `INSERT INTO messages (id, conversation_id, sender_id, body)
     VALUES (gen_random_uuid(), $1, $2, $3)
     RETURNING id, sender_id, body, read_at, created_at`,
    [conversationId, viewer, body]
  );

  const otherId = otherUserId(conv, viewer);
  const other = await queryOne(`SELECT first_name, locale FROM users WHERE id = $1`, [otherId]);
  const notificationTitle = t(
    other?.locale,
    `${ctx.user!.firstName} sent you a message`,
    `${ctx.user!.firstName} te envió un mensaje`
  );
  const notificationBody = body.length > 150 ? body.slice(0, 147) + '...' : body;
  const notificationData = { conversationId, messageId: msg!.id, senderId: viewer };
  const shouldNotify = await notifyUser(
    otherId, 'message', notificationTitle, notificationBody, notificationData
  );
  // Keep lock-screen content private; the app can fetch the message after opening.
  if (shouldNotify) {
    void pushToUser(
      otherId,
      notificationTitle,
      t(other?.locale, 'You have a new message on VINCÓ.', 'Tienes un nuevo mensaje en VINCÓ.'),
      { type: 'message', conversationId, messageId: msg!.id, senderId: viewer }
    );
  }

  return {
    id: msg!.id,
    senderId: msg!.sender_id,
    body: msg!.body,
    readAt: msg!.read_at,
    createdAt: msg!.created_at,
    mine: true,
  };
}

// ---- 10. typing indicator ----

async function setTyping(args: any, ctx: ActionContext) {
  const viewer = ctx.user!.id;
  const conversationId = reqString(args, 'conversationId', 1, 64);
  const typing = reqBoolean(args, 'typing');
  const conv = await getConversation(conversationId);
  if (!conv) biz(CONVERSATION_NOT_FOUND);
  if (conv.user_a !== viewer && conv.user_b !== viewer) biz(NOT_IN_CONVERSATION);

  await query(
    `INSERT INTO typing_state (conversation_id, user_id, typing, updated_at)
     VALUES ($1, $2, $3, now())
     ON CONFLICT (conversation_id, user_id)
     DO UPDATE SET typing = EXCLUDED.typing, updated_at = now()`,
    [conversationId, viewer, typing]
  );
  return { ok: true };
}

// ---- 11. notifications ----

async function listNotifications(args: any, ctx: ActionContext) {
  const viewer = ctx.user!.id;
  const limit = optInt(args, 'limit', 30, 1, 100);
  const offset = optInt(args, 'offset', 0, 0, 1000000);

  const rows = await query(
    `SELECT id, type, title, body, data, read_at, created_at FROM notifications
     WHERE user_id = $1 ORDER BY created_at DESC LIMIT $2 OFFSET $3`,
    [viewer, limit, offset]
  );
  const unread = await queryOne<{ c: number }>(
    `SELECT COUNT(*)::int AS c FROM notifications WHERE user_id = $1 AND read_at IS NULL`,
    [viewer]
  );
  return {
    notifications: rows.map((n: any) => ({
      id: n.id,
      type: n.type,
      title: n.title,
      body: n.body,
      data: typeof n.data === 'string' ? JSON.parse(n.data) : (n.data ?? {}),
      readAt: n.read_at,
      createdAt: n.created_at,
    })),
    unreadCount: unread?.c ?? 0,
  };
}

// ---- 12. mark notification read ----

async function markNotificationRead(args: any, ctx: ActionContext) {
  const viewer = ctx.user!.id;
  const notificationId = reqString(args, 'notificationId', 1, 64);
  const r = await queryOne(
    `UPDATE notifications SET read_at = now() WHERE id = $1 AND user_id = $2 RETURNING id`,
    [notificationId, viewer]
  );
  if (!r) biz(NOTIFICATION_NOT_FOUND);
  return { ok: true };
}

// ---- 13. notification settings ----

async function updateNotificationSettings(args: any, ctx: ActionContext) {
  const viewer = ctx.user!.id;
  const likes = reqBoolean(args, 'likes');
  const matches = reqBoolean(args, 'matches');
  const messages = reqBoolean(args, 'messages');
  const security = reqBoolean(args, 'security');
  const marketing = reqBoolean(args, 'marketing');

  await query(
    `INSERT INTO notification_settings (user_id, likes, matches, messages, security, marketing, updated_at)
     VALUES ($1, $2, $3, $4, $5, $6, now())
     ON CONFLICT (user_id) DO UPDATE SET
       likes = EXCLUDED.likes,
       matches = EXCLUDED.matches,
       messages = EXCLUDED.messages,
       security = EXCLUDED.security,
       marketing = EXCLUDED.marketing,
       updated_at = now()`,
    [viewer, likes, matches, messages, security, marketing]
  );
  return { likes, matches, messages, security, marketing };
}

// ---- registration ----

registerAction('listdiscovery', listDiscovery, { auth: 'user' });
registerAction('reacttoprofile', reactToProfile, { auth: 'user' });
registerAction('listlikes', listLikes, { auth: 'user' });
registerAction('listmatches', listMatches, { auth: 'user' });
registerAction('unmatch', unmatch, { auth: 'user' });
registerAction('blockuser', blockUser, { auth: 'user' });
registerAction('reportuser', reportUser, { auth: 'user' });
registerAction('listmessages', listMessages, { auth: 'user' });
registerAction('sendmessage', sendMessage, { auth: 'user' });
registerAction('settyping', setTyping, { auth: 'user' });
registerAction('listnotifications', listNotifications, { auth: 'user' });
registerAction('marknotificationread', markNotificationRead, { auth: 'user' });
registerAction('updatenotificationsettings', updateNotificationSettings, { auth: 'user' });
