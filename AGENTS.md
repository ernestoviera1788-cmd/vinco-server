# AGENTS.md — vinco-backend

Independent public RPC backend for the VINCÓ dating platform.
Single endpoint `POST /actions`, `{"action","args","actionCallId"}`.

## Commands

```bash
npm install                 # install deps
npm run dev                 # dev server with watch (tsx)
npm run typecheck            # tsc --noEmit — must be 0 errors
npm run build               # tsc -> dist/
npm start                   # run built server (needs DATABASE_URL)
npm run migrate             # run versioned SQL migrations
```

## Hard rules

- **The RPC contract is law.** Action names and arg shapes come from
  `../vinco-native/docs/BACKEND_CONTRACT.md`. Never invent action names.
  Token goes INSIDE `args.token`, never as a header.
- **Envelopes:** success = 200 `{"data": payload}`; business error = 200
  `{"data":{"ok":false,"error":"CODE"}}`; transport error = non-2xx
  `{"error": "..."}`. Unknown action = 404. Malformed body = 400.
- **No mocked success.** If a provider (Stripe) isn't configured, return the
  honest business error (`STRIPE_NOT_CONFIGURED`). Stubs are forbidden —
  either the action works for real or it fails honestly.
- **Error codes** live in `src/errors.ts` and are stable English strings;
  the native app maps them to en/es UI text.
- **Migrations:** never edit an applied migration. Add a new numbered file
  in `migrations/` and keep it idempotent-safe (CREATE IF NOT EXISTS where
  it matters).
- **Passwords:** PBKDF2-SHA512, 210k iterations (`src/auth.ts`). OTP/reset
  codes: 6 digits, sha256-hashed at rest, 10–15 min expiry, attempt limits.
- **Admin actions** use `auth: 'admin'` with explicit `roles`. Never let a
  non-SUPER_ADMIN modify a SUPER_ADMIN.
- Response payload shapes (not defined by the contract) are documented in
  `RESPONSE_CONTRACT.md` — update it when you change a response.

## Gotchas learned

- TS `module: commonjs`: use `.js` suffixes in relative imports
  (`from '../db.js'`) — tsc emits `dist/*.js` and the requires resolve.
- `express.json({ limit: '12mb' })` — base64 photos/evidence need headroom.
- `pg` returns `Date` for timestamptz; serialize with `.toISOString()` at the
  boundary. `birth_date` (DATE) also arrives as Date — slice to YYYY-MM-DD.
- tsx runs TS directly; `__dirname` works in migrate.ts (no import.meta
  under commonjs).
