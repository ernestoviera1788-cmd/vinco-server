# VINCÓ Backend

Independent public RPC backend for the VINCÓ dating platform. Single endpoint
`POST /actions` with body `{"action","args":{"token","..."},"actionCallId"}` —
the same contract the `vinco-native` mobile app speaks
(see `../vinco-native/docs/BACKEND_CONTRACT.md`).

- **Runtime:** Node 20 + TypeScript + Express
- **Database:** Postgres (via `DATABASE_URL`), versioned SQL migrations
- **Envelopes:** success `200 {"data": ...}` · business error
  `200 {"data":{"ok":false,"error":"CODE"}}` · transport error non-2xx
- **Auth:** PBKDF2-SHA512 passwords, 18+ age gate, OTP verification,
  sessions (token inside `args.token`), logout/revoke

## Quick start (local)

```bash
cp .env.example .env        # set DATABASE_URL to your Postgres
npm install
npm run migrate             # create schema + seed plans/boosts/settings
npm run dev                 # http://localhost:8080, GET /health
```

Smoke test:

```bash
curl -s -X POST localhost:8080/actions \
  -H 'Content-Type: application/json' \
  -d '{"action":"listplans","args":{},"actionCallId":"1"}'
```

## Deploy on Railway

1. Create a Railway project → **New** → **GitHub Repo** (or deploy this folder).
2. Add a **Postgres** database plugin; Railway exposes `DATABASE_URL`.
3. Set variables: `PUBLIC_BASE_URL=https://<tu-dominio>`,
   `STRIPE_SECRET_KEY=<sk_...>` (optional), `NODE_ENV=production`.
4. Deploy. The container runs migrations then starts the server automatically.
5. Point the mobile app's `EXPO_PUBLIC_API_URL` at `https://<tu-dominio>`.

## Deploy on Render

1. **New** → **Blueprint** → point at this repo (`render.yaml`).
2. Fill `DATABASE_URL`, `PUBLIC_BASE_URL`, `STRIPE_SECRET_KEY` when prompted.
3. Deploy; health check is `GET /health`.

## Deploy on a VPS with Docker

```bash
# .env with DATABASE_URL, PUBLIC_BASE_URL, STRIPE_SECRET_KEY, NODE_ENV=production
docker build -t vinco-backend .
docker run -d --name vinco-backend --env-file .env -p 8080:8080 vinco-backend
# put Caddy/Nginx + TLS in front, then set the app's EXPO_PUBLIC_API_URL
```

## Environment variables

| Var | Required | Purpose |
|---|---|---|
| `DATABASE_URL` | yes | Postgres connection string |
| `PORT` | no | HTTP port (default 8080) |
| `PUBLIC_BASE_URL` | no | Public URL; Stripe success/cancel URLs (default localhost) |
| `STRIPE_SECRET_KEY` | no | Enables real Stripe checkout. **Absent → `createcheckout` returns honest `STRIPE_NOT_CONFIGURED`** |
| `NODE_ENV` | no | `production` hides dev-only OTP codes from responses |

## Notes

- OTP / password-reset codes are delivered by your email/SMS provider; in
  non-production the API returns `devCode` so you can test the flow.
- New profile photos start as `pending` and need `adminreviewphoto` approval.
- Expo push-device registration and delivery are introduced in the paired WIP PR: `registerpushdevice`, `unregisterpushdevice`, `push_devices`, and the best-effort Expo sender. Do not consider OS push production-ready until this branch is deployed, the migration runs, EAS/APNs/FCM credentials are configured, and physical-device tests pass.
- Response payload shapes are documented in `RESPONSE_CONTRACT.md`.
