// Shared user/profile view helpers for discovery, matches, admin, etc.
import { query, queryOne } from './db.js';
import { ageOf } from './validation.js';

export interface PublicUserCard {
  id: string;
  firstName: string;
  age: number;
  gender: string;
  city: string;
  state: string | null;
  country: string;
  bio: string;
  intention: string;
  occupation: string;
  education: string;
  hobbies: string;
  lifestyle: string;
  distance: string | null; // 'hidden' handling is UI-side; we return null when showDistance=false
  photos: Array<{ id: string; url: string; altText: string; isPrimary: boolean }>;
}

function toDataUrl(mime: string, b64: string): string {
  return `data:${mime};base64,${b64}`;
}

// Safe public card for discovery/matches. Returns null for missing/inactive users.
export async function getPublicUserCard(userId: string): Promise<PublicUserCard | null> {
  const u: any = await queryOne(
    `SELECT u.id, u.first_name, u.gender, u.city, u.state, u.country, u.birth_date,
            p.bio, p.intention, p.occupation, p.education, p.hobbies, p.lifestyle,
            p.profile_visible, p.show_distance
     FROM users u LEFT JOIN profiles p ON p.user_id = u.id
     WHERE u.id = $1 AND u.status = 'active'`,
    [userId]
  );
  if (!u || u.profile_visible === false) return null;
  const photos = await query(
    `SELECT id, mime_type, data_base64, alt_text, is_primary FROM profile_photos
     WHERE user_id = $1 AND status = 'approved' ORDER BY position ASC`,
    [userId]
  );
  return {
    id: u.id,
    firstName: u.first_name,
    age: ageOf(new Date(u.birth_date)),
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
    distance: u.show_distance ? null : null, // distance requires geo; null = not shown
    photos: photos.map((p: any) => ({
      id: p.id,
      url: toDataUrl(p.mime_type, p.data_base64),
      altText: p.alt_text ?? '',
      isPrimary: !!p.is_primary,
    })),
  };
}

// Full private view for getme / admin detail.
export async function getFullUser(userId: string): Promise<any | null> {
  const u: any = await queryOne(`SELECT * FROM users WHERE id = $1`, [userId]);
  if (!u) return null;
  const p: any = await queryOne(`SELECT * FROM profiles WHERE user_id = $1`, [userId]);
  const photos = await query(
    `SELECT id, position, is_primary AS "isPrimary", mime_type AS "mimeType",
            data_base64 AS "dataBase64", alt_text AS "altText", status, created_at AS "createdAt"
     FROM profile_photos WHERE user_id = $1 ORDER BY position ASC`,
    [userId]
  );
  const photosOut = photos.map((ph: any) => ({
    ...ph,
    url: toDataUrl(ph.mimeType, ph.dataBase64),
  }));
  return {
    id: u.id,
    email: u.email,
    phone: u.phone,
    firstName: u.first_name,
    birthDate: u.birth_date instanceof Date ? u.birth_date.toISOString().slice(0, 10) : u.birth_date,
    gender: u.gender,
    city: u.city,
    state: u.state,
    country: u.country,
    locale: u.locale,
    role: u.role,
    status: u.status,
    emailVerified: !!u.email_verified,
    phoneVerified: !!u.phone_verified,
    createdAt: u.created_at,
    profile: p
      ? {
          bio: p.bio ?? '', intention: p.intention ?? '', occupation: p.occupation ?? '',
          education: p.education ?? '', hobbies: p.hobbies ?? '', lifestyle: p.lifestyle ?? '',
          preferredGender: p.preferred_gender ?? '', ageMin: p.age_min, ageMax: p.age_max,
          distanceMax: p.distance_max, profileVisible: !!p.profile_visible,
          showDistance: !!p.show_distance, showOnline: !!p.show_online,
        }
      : null,
    photos: photosOut,
  };
}

// True when either user blocked the other.
export async function blocksEither(a: string, b: string): Promise<boolean> {
  const r = await queryOne(
    `SELECT 1 FROM blocks WHERE (blocker_id = $1 AND blocked_id = $2) OR (blocker_id = $2 AND blocked_id = $1)`,
    [a, b]
  );
  return !!r;
}

// True when the user has an active (non-expired, non-canceled) subscription.
export async function hasActiveSubscription(userId: string): Promise<boolean> {
  const r = await queryOne(
    `SELECT 1 FROM subscriptions WHERE user_id = $1 AND status = 'active' AND current_period_end > now() LIMIT 1`,
    [userId]
  );
  return !!r;
}

// True when the user has an active (non-expired) boost.
export async function hasActiveBoost(userId: string): Promise<boolean> {
  const r = await queryOne(
    `SELECT 1 FROM user_boosts WHERE user_id = $1 AND status = 'active' AND expires_at > now() LIMIT 1`,
    [userId]
  );
  return !!r;
}
