// VINCÓ profile + photo actions.
// Registers: updateprofile, listmyphotos, uploadprofilephoto, deleteprofilephoto,
//            reorderprofilephotos, setprimaryphoto, updateprivacy.
import { query, queryOne, tx } from '../db.js';
import {
  biz,
  INVALID_ARGS,
  PHOTO_LIMIT_REACHED,
  PHOTO_TOO_LARGE,
  INVALID_MIME_TYPE,
  PHOTO_NOT_FOUND,
  INVALID_PHOTO_ORDER,
} from '../errors.js';
import {
  reqString,
  optString,
  reqBoolean,
  reqInt,
  reqArray,
} from '../validation.js';
import { registerAction, type ActionContext } from '../rpc.js';

const PHOTO_MIMES = ['image/jpeg', 'image/png'] as const;
const MAX_PHOTO_BYTES_DEFAULT = 10 * 1024 * 1024;
const MAX_PHOTOS_DEFAULT = 6;

function toDataUrl(mime: string, b64: string): string {
  return `data:${mime};base64,${b64}`;
}

async function getSettingInt(key: string, fallback: number): Promise<number> {
  const row: any = await queryOne(`SELECT value FROM platform_settings WHERE key = $1`, [key]);
  const v = row?.value?.value;
  return Number.isInteger(v) && v > 0 ? v : fallback;
}

type PhotoRow = {
  id: string;
  position: number;
  isPrimary: boolean;
  mimeType: string;
  url: string;
  altText: string;
  status: string;
  createdAt: any;
};

function iso(v: any): string | null {
  return v instanceof Date ? v.toISOString() : (v ?? null);
}

function photoOut(r: any): PhotoRow {
  return {
    id: r.id,
    position: r.position,
    isPrimary: !!r.is_primary,
    mimeType: r.mime_type,
    url: toDataUrl(r.mime_type, r.data_base64),
    altText: r.alt_text ?? '',
    status: r.status,
    createdAt: iso(r.created_at),
  };
}

// Full profile view for the owner (identity from users + prefs from profiles).
async function profileOut(userId: string): Promise<any> {
  const u: any = await queryOne(
    `SELECT u.id, u.first_name, u.gender, u.city, u.state, u.country,
            p.bio, p.intention, p.occupation, p.education, p.hobbies, p.lifestyle,
            p.preferred_gender, p.age_min, p.age_max, p.distance_max,
            p.profile_visible, p.show_distance, p.show_online, p.updated_at
     FROM users u LEFT JOIN profiles p ON p.user_id = u.id
     WHERE u.id = $1`,
    [userId]
  );
  if (!u) return null;
  return {
    userId: u.id,
    firstName: u.first_name,
    gender: u.gender,
    city: u.city,
    state: u.state,
    country: u.country,
    bio: u.bio ?? '',
    intention: u.intention ?? '',
    occupation: u.occupation ?? '',
    education: u.education ?? '',
    hobbies: u.hobbies ?? '',
    lifestyle: u.lifestyle ?? '',
    preferredGender: u.preferred_gender ?? '',
    ageMin: u.age_min ?? 18,
    ageMax: u.age_max ?? 99,
    distanceMax: u.distance_max ?? 100,
    profileVisible: u.profile_visible ?? true,
    showDistance: u.show_distance ?? true,
    showOnline: u.show_online ?? true,
    updatedAt: iso(u.updated_at),
  };
}

// ---------------------------------------------------------------------------
// 1. updateprofile — token + all fields required.
//    Updates users (firstName, gender, city, state, country) and upserts profiles.
registerAction(
  'updateprofile',
  async (args: any, ctx: ActionContext) => {
    const userId = ctx.user!.id;

    const firstName = reqString(args, 'firstName', 1, 40);
    const bio = reqString(args, 'bio', 0, 500);
    const city = reqString(args, 'city', 1, 120);
    const state = reqString(args, 'state', 1, 120);
    const country = reqString(args, 'country', 1, 120);
    const gender = reqString(args, 'gender', 1, 30);
    const intention = reqString(args, 'intention', 1, 60);
    const occupation = reqString(args, 'occupation', 1, 120);
    const education = reqString(args, 'education', 1, 120);
    const hobbies = reqString(args, 'hobbies', 1, 500);
    const lifestyle = reqString(args, 'lifestyle', 1, 500);
    const preferredGender = reqString(args, 'preferredGender', 1, 30);
    const ageMin = reqInt(args, 'ageMin', 18, 99);
    const ageMax = reqInt(args, 'ageMax', 18, 99);
    if (ageMin > ageMax) biz(INVALID_ARGS, 'ageMin must be <= ageMax');
    const distanceMax = reqInt(args, 'distanceMax', 1, 500);

    await tx(async (c) => {
      await c.query(
        `UPDATE users
         SET first_name = $2, gender = $3, city = $4, state = $5, country = $6, updated_at = now()
         WHERE id = $1`,
        [userId, firstName, gender, city, state, country]
      );
      await c.query(
        `INSERT INTO profiles
           (user_id, bio, intention, occupation, education, hobbies, lifestyle,
            preferred_gender, age_min, age_max, distance_max, updated_at)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, now())
         ON CONFLICT (user_id) DO UPDATE SET
           bio = EXCLUDED.bio,
           intention = EXCLUDED.intention,
           occupation = EXCLUDED.occupation,
           education = EXCLUDED.education,
           hobbies = EXCLUDED.hobbies,
           lifestyle = EXCLUDED.lifestyle,
           preferred_gender = EXCLUDED.preferred_gender,
           age_min = EXCLUDED.age_min,
           age_max = EXCLUDED.age_max,
           distance_max = EXCLUDED.distance_max,
           updated_at = now()`,
        [
          userId, bio, intention, occupation, education, hobbies, lifestyle,
          preferredGender, ageMin, ageMax, distanceMax,
        ]
      );
    });

    return profileOut(userId);
  },
  { auth: 'user' }
);

// ---------------------------------------------------------------------------
// 2. listmyphotos — all photos of the caller, ordered by position.
registerAction(
  'listmyphotos',
  async (_args: any, ctx: ActionContext) => {
    const rows = await query(
      `SELECT id, position, is_primary, mime_type, data_base64, alt_text, status, created_at
       FROM profile_photos WHERE user_id = $1 ORDER BY position ASC`,
      [ctx.user!.id]
    );
    return rows.map(photoOut);
  },
  { auth: 'user' }
);

// ---------------------------------------------------------------------------
// 3. uploadprofilephoto — new photos enter with status='approved' (auto-approve;
//    moderation via adminreviewphoto/reportuser stays available for later).
registerAction(
  'uploadprofilephoto',
  async (args: any, ctx: ActionContext) => {
    const userId = ctx.user!.id;

    reqString(args, 'name', 1, 200); // client filename; validated, not persisted (no column)
    const mimeType = reqString(args, 'mimeType', 1, 100);
    if (!(PHOTO_MIMES as readonly string[]).includes(mimeType)) biz(INVALID_MIME_TYPE);
    const dataBase64 = args?.dataBase64;
    if (typeof dataBase64 !== 'string' || dataBase64.length === 0) biz(INVALID_ARGS, 'arg dataBase64');
    const altText = optString(args, 'altText', 200);

    // Real byte size of the decoded image.
    let bytes: number;
    try {
      const buf = Buffer.from(dataBase64, 'base64');
      if (buf.length === 0) biz(INVALID_ARGS, 'arg dataBase64 empty after decode');
      // Strict base64 check: round-trip must match (ignoring whitespace).
      const canon = dataBase64.replace(/\s+/g, '');
      if (buf.toString('base64') !== canon) biz(INVALID_ARGS, 'arg dataBase64 not valid base64');
      bytes = buf.length;
    } catch {
      biz(INVALID_ARGS, 'arg dataBase64 not valid base64');
    }

    const maxPhotos = await getSettingInt('max_photos', MAX_PHOTOS_DEFAULT);
    const maxBytes = await getSettingInt('max_photo_bytes', MAX_PHOTO_BYTES_DEFAULT);
    if (bytes! > maxBytes) biz(PHOTO_TOO_LARGE, `photo is ${bytes} bytes, limit is ${maxBytes}`);

    const created = await tx(async (c) => {
      const countRow: any = await c
        .query(`SELECT COUNT(*)::int AS n, COALESCE(MAX(position), -1) AS maxpos FROM profile_photos WHERE user_id = $1`, [userId])
        .then((r) => r.rows[0]);
      if (countRow.n >= maxPhotos) biz(PHOTO_LIMIT_REACHED, `photo limit is ${maxPhotos}`);
      const isPrimary = countRow.n === 0; // first photo becomes primary
      const position = countRow.maxpos + 1;
      const row = await c
        .query(
          `INSERT INTO profile_photos
             (id, user_id, position, is_primary, mime_type, data_base64, alt_text, status)
           VALUES (gen_random_uuid(), $1, $2, $3, $4, $5, $6, 'approved')
           RETURNING id, position, is_primary, mime_type, data_base64, alt_text, status, created_at`,
          [userId, position, isPrimary, mimeType, dataBase64, altText ?? '']
        )
        .then((r) => r.rows[0]);
      return row;
    });

    return photoOut(created);
  },
  { auth: 'user' }
);

// ---------------------------------------------------------------------------
// 4. deleteprofilephoto — own photos only; if it was primary, promote the
//    lowest-position remaining photo.
registerAction(
  'deleteprofilephoto',
  async (args: any, ctx: ActionContext) => {
    const userId = ctx.user!.id;
    const photoId = reqString(args, 'photoId', 1, 100);

    await tx(async (c) => {
      const row = await c
        .query(`SELECT id, is_primary FROM profile_photos WHERE id = $1 AND user_id = $2`, [photoId, userId])
        .then((r) => r.rows[0]);
      if (!row) biz(PHOTO_NOT_FOUND);
      await c.query(`DELETE FROM profile_photos WHERE id = $1`, [photoId]);
      if (row.is_primary) {
        // Promote the remaining photo with the lowest position.
        const next = await c
          .query(`SELECT id FROM profile_photos WHERE user_id = $1 ORDER BY position ASC LIMIT 1`, [userId])
          .then((r) => r.rows[0]);
        if (next) {
          await c.query(`UPDATE profile_photos SET is_primary = TRUE WHERE id = $1`, [next.id]);
        }
      }
    });

    return { ok: true };
  },
  { auth: 'user' }
);

// ---------------------------------------------------------------------------
// 5. reorderprofilephotos — photoIds must contain EXACTLY the caller's photo
//    ids, in the desired order, with no duplicates.
registerAction(
  'reorderprofilephotos',
  async (args: any, ctx: ActionContext) => {
    const userId = ctx.user!.id;
    const maxPhotos = await getSettingInt('max_photos', MAX_PHOTOS_DEFAULT);
    const photoIds = reqArray(args, 'photoIds', 1, maxPhotos, (x: any) => {
      if (typeof x !== 'string' || x.length === 0) biz(INVALID_ARGS, 'photoIds items must be uuid strings');
      return x as string;
    });

    const owned = await query(`SELECT id FROM profile_photos WHERE user_id = $1`, [userId]);
    const ownedIds = owned.map((r: any) => r.id);
    if (photoIds.length !== ownedIds.length) biz(INVALID_PHOTO_ORDER);
    if (new Set(photoIds).size !== photoIds.length) biz(INVALID_PHOTO_ORDER); // duplicates
    const ownedSet = new Set(ownedIds);
    if (!photoIds.every((id) => ownedSet.has(id))) biz(INVALID_PHOTO_ORDER);

    await tx(async (c) => {
      for (let i = 0; i < photoIds.length; i++) {
        await c.query(`UPDATE profile_photos SET position = $2 WHERE id = $1 AND user_id = $3`, [
          photoIds[i],
          i,
          userId,
        ]);
      }
    });

    return { ok: true };
  },
  { auth: 'user' }
);

// ---------------------------------------------------------------------------
// 6. setprimaryphoto — own photo only, and it must be approved.
registerAction(
  'setprimaryphoto',
  async (args: any, ctx: ActionContext) => {
    const userId = ctx.user!.id;
    const photoId = reqString(args, 'photoId', 1, 100);

    await tx(async (c) => {
      const row = await c
        .query(`SELECT id, status FROM profile_photos WHERE id = $1 AND user_id = $2`, [photoId, userId])
        .then((r) => r.rows[0]);
      if (!row || row.status !== 'approved') biz(PHOTO_NOT_FOUND);
      await c.query(`UPDATE profile_photos SET is_primary = FALSE WHERE user_id = $1`, [userId]);
      await c.query(`UPDATE profile_photos SET is_primary = TRUE WHERE id = $1`, [photoId]);
    });

    return { ok: true };
  },
  { auth: 'user' }
);

// ---------------------------------------------------------------------------
// 7. updateprivacy — three booleans, upsert into profiles.
registerAction(
  'updateprivacy',
  async (args: any, ctx: ActionContext) => {
    const profileVisible = reqBoolean(args, 'profileVisible');
    const showDistance = reqBoolean(args, 'showDistance');
    const showOnline = reqBoolean(args, 'showOnline');

    await query(
      `INSERT INTO profiles (user_id, profile_visible, show_distance, show_online, updated_at)
       VALUES ($1, $2, $3, $4, now())
       ON CONFLICT (user_id) DO UPDATE SET
         profile_visible = EXCLUDED.profile_visible,
         show_distance = EXCLUDED.show_distance,
         show_online = EXCLUDED.show_online,
         updated_at = now()`,
      [ctx.user!.id, profileVisible, showDistance, showOnline]
    );

    return { profileVisible, showDistance, showOnline };
  },
  { auth: 'user' }
);
