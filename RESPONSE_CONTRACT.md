# RESPONSE_CONTRACT.md — vinco-backend

Action names and arg shapes come from `../vinco-native/docs/BACKEND_CONTRACT.md`
(the RPC contract is law). This file documents the **response payload shapes**,
which the contract does not define. Update it whenever a response changes.

Envelope (all actions): success → 200 `{"data": payload}`;
business error → 200 `{"data": {"ok": false, "error": "CODE"}}`.

## auth & account (`src/actions/auth.ts`)

- `register` → `{ user: AuthUserCompact, token: string, expiresAt: string }`
- `login` → `{ user: AuthUserCompact, token: string, expiresAt: string }`
- `requestverification` → `{ ok: true, channel: "email"|"phone" }`
  (+ `devCode: string` when `NODE_ENV !== "production"` — no SMS/email provider
  is configured yet, so codes are never actually delivered)
- `verifyotp` → `{ ok: true, channel: "email"|"phone" }`
- `getme` → full user object from `getFullUser()` plus `settings`:
  `{ likes, matches, messages, security, marketing }` (from `notification_settings`)
- `logout` → `{ ok: true }`
- `listsessions` → `{ sessions: SessionInfo[] }`
- `revokesession` → `{ ok: true }`
- `requestpasswordreset` → `{ ok: true }`
  (+ `devCode: string` when `NODE_ENV !== "production"`; `{ok:true}` even when the
  account does not exist — no account enumeration)
- `completepasswordreset` → `{ ok: true }`
- `recoverpassword` → same as `requestpasswordreset` (email-only alias)
- `deleteaccount` → `{ ok: true }`
- `updatelocale` → `{ ok: true, locale: "en"|"es" }`

Shapes:

```ts
type AuthUserCompact = {
  id: string; email: string; phone: string | null;
  firstName: string; birthDate: string; // YYYY-MM-DD
  gender: string; city: string; state: string | null; country: string;
  locale: "en" | "es"; role: string; status: string;
  emailVerified: boolean; phoneVerified: boolean;
  createdAt: string; // ISO
};

type SessionInfo = {
  id: string; createdAt: string; expiresAt: string; lastUsedAt: string | null;
  ip: string | null; userAgent: string | null; current: boolean;
};
```

## profile & photos (`src/actions/profile.ts`)

- `updateprofile` → `{ userId, firstName, gender, city, state, country, bio, intention, occupation, education, hobbies, lifestyle, preferredGender, ageMin, ageMax, distanceMax, profileVisible, showDistance, showOnline, updatedAt }`
- `listmyphotos` → `{ photos: Photo[] }`
- `uploadprofilephoto` → `Photo` (status `'approved'` — auto-approved on upload)
- `deleteprofilephoto` → `{ ok: true }`
- `reorderprofilephotos` → `{ ok: true }`
- `setprimaryphoto` → `{ ok: true }`
- `updateprivacy` → `{ profileVisible, showDistance, showOnline }`

```ts
type Photo = {
  id: string; position: number; isPrimary: boolean;
  mimeType: "image/jpeg" | "image/png";
  url: string; // data URL: data:<mime>;base64,<b64>
  altText: string; status: "pending" | "approved" | "rejected";
  createdAt: string;
};
```

## discovery & social (`src/actions/social.ts`)

- `listdiscovery` → `{ users: PublicUserCard[], total: number }`
- `reacttoprofile` → `{ ok: true, matched: boolean, matchId?: string, conversationId?: string }`
- `listlikes` → `{ users: PublicUserCard[] }` (premium-gated: `LIKES_GATED` without active subscription)
- `listmatches` → `{ matches: [{ matchId, conversationId, createdAt, user: PublicUserCard, lastMessage: {body, createdAt, mine} | null }] }`
- `unmatch` → `{ ok: true }`
- `blockuser` → `{ ok: true }`
- `reportuser` → `{ ok: true, reportId: string }`
- `listmessages` → `{ messages: [{ id, senderId, body, readAt, createdAt, mine }] }` (ASC)
- `sendmessage` → `{ id, senderId, body, readAt: null, createdAt, mine: true }`
- `settyping` → `{ ok: true }`
- `listnotifications` → `{ notifications: [{ id, type, title, body, data, readAt, createdAt }], unreadCount: number }`
- `marknotificationread` → `{ ok: true }`
- `updatenotificationsettings` → `{ likes, matches, messages, security, marketing }`

```ts
type PublicUserCard = {
  id: string; firstName: string; age: number; gender: string;
  city: string; state: string | null; country: string;
  bio: string; intention: string; occupation: string; education: string;
  hobbies: string; lifestyle: string; distance: null; // geo not implemented
  photos: Array<{ id: string; url: string; altText: string; isPrimary: boolean }>;
};
```

## premium & commerce (`src/actions/commerce.ts`)

- `listplans` → `{ plans: [{ id, name, interval, priceCents, currency, benefits: string[] }] }`
- `listboosts` → `{ boosts: [{ id, name, priceCents, currency, durationMinutes }] }`
- `createcheckout` → `{ paymentId, sessionId, url }` (`url` = Stripe-hosted checkout page);
  without `STRIPE_SECRET_KEY` → business error `STRIPE_NOT_CONFIGURED`
- `confirmcheckout` → `{ ok: true, paid: boolean, ... }` (`paid:false` when the
  Stripe session is not paid yet; idempotent re-confirmation)
- `listmybilling` → `{ subscription: Subscription | null, payments: Payment[], boosts: UserBoost[] }`
- `renewsubscription` → `Subscription` (extends `currentPeriodEnd` by plan interval)
- `cancelsubscription` → `Subscription` (`cancelAtPeriodEnd: true` — end of cycle, not immediate)
- `requestrefund` → `{ ok: true, refundId: string }` (status `'requested'`; admin reviews)

```ts
type Subscription = {
  id: string; planId: string; status: "active" | "canceled" | "expired" | "past_due";
  currentPeriodEnd: string; cancelAtPeriodEnd: boolean; createdAt: string;
};
type Payment = {
  id: string; kind: "SUBSCRIPTION" | "BOOST"; itemId: string;
  amountCents: number; currency: string;
  status: "pending" | "completed" | "failed" | "refunded" | "partially_refunded";
  createdAt: string;
};
```

## admin (`src/actions/admin.ts`)

All responses are plain JSON under the standard envelope; dates are ISO strings.
Role gating: moderation actions → MODERATOR/ADMIN/SUPER_ADMIN; everything else →
ADMIN/SUPER_ADMIN. A non-SUPER_ADMIN can never change a SUPER_ADMIN
(`CANNOT_MODIFY_SUPER_ADMIN`).

- `getadminoverview` (alias `admingetoverview`) → `{ usersTotal, usersNew24h, activeSubscriptions, paymentsToday, openReports, pendingPhotos, matchesTotal, messagesTotal }`
- `listadminusers` → `{ users: [{ id, email, firstName, role, status, createdAt }], total }`
- `getadminuserdetail` → full user (see `getFullUser`) + `{ sessions, reportsReceived, subscriptions, payments, notes }`
- `adminchangeuserstatus` → `{ ok: true }` (audit logged; sessions revoked on suspend/ban)
- `admindeleteuser` → `{ ok: true }` (soft delete → `status='deleted'`)
- `listadminmoderation` → `{ items: [{ kind: "report"|"photo", ... }], total }`
- `moderatereport` → `{ ok: true }`
- `adminreviewphoto` → `{ ok: true }`
- `listadminsettings` → `{ settings: [{ key, value }] }`
- `adminsavesetting` → `{ ok: true }`
- `adminsaveplan` → plan object
- `admincreateannouncement` → `{ ok: true, announcementId }`
- `getadminanalytics` → `{ series: [{ period, signups, matches, messages, payments }] }`
- `getadminmetrics` → `{ totals: {...}, last30d: {...} }`
- `getadmincommerce` → `{ payments: [{...payment, userEmail}], total }`
- `getadminpaymentdetail` → `{ payment, user, refunds }`
- `getadminreportdetail` → `{ report, reporter, reported, evidenceUrl }`
- `adminreviewrefund` → `{ ok: true, status }` (`executed` only when Stripe ran the
  refund; otherwise `approved` = pending manual execution — never simulated)
- `adminreviewsuspicious` → `{ users: [{ userId, email, reasons: string[] }] }`
