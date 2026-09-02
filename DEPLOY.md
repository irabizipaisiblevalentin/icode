# iCode Control — Deployment Files

This folder contains ready-to-use deploy configs for the iCode control server.
The server is a zero-dependency Bun + SQLite app in a single small container.

## Environment variables (set all of them)

| Variable | Required | Purpose |
|---|---|---|
| `ADMIN_TOKEN` | **Yes** | The password for your admin dashboard (`/admin`). Make it long and random. There is a weak default (`icode-admin-secret`) — you MUST set a real one. |
| `WEBHOOK_SECRET` | **Yes** | Shared secret used by the payment form bridge to authenticate webhook submissions. No form data is accepted without it. |
| `ICODE_ACCESS_DURATION_DAYS` | No | How many days a new approved passcode lasts (default `30`). |
| `NOTIFICATION_WEBHOOK_URL` | No | Optional outbound channel for delivering generated passcodes to users (e.g. a Telegram bot / email relay). Nothing is sent if unset. |
| `NOTIFICATION_WEBHOOK_TOKEN` | No | Optional bearer token for the outbound notification channel. |
| `PORT` | No | HTTP port the container listens on (default 8080). Providers inject their own; on Fly use `fly.toml`. |
| `DATA_DIR` | No | Directory for the SQLite DB. Defaults to the app dir; **point it at a persistent volume** so your passcodes survive restarts/deploys. |

## Persistent storage (IMPORTANT)

The app stores everything in a single SQLite file (`icode-control.db`).
To avoid losing passcodes/customers/installs on each redeploy, mount a
**persistent volume** at `/app/data` and set `DATA_DIR=/app/data`.

If you don't set DATA_DIR, the DB lives in the container and is wiped on
every restart — you will lose all passcodes. Always use a volume.

---

## Option A — Railway (easiest)

1. Create a new project → "Deploy from GitHub repo" pointing at
   `packages/icode-control` (set Root Directory to `packages/icode-control`).
2. Railway auto-detects the `Dockerfile` (or use Nixpacks with `bun run src/index.ts`).
3. Add a **Volume** mounted at `/app/data` (Railway: Settings → Data → Volume).
4. Set env vars: `ADMIN_TOKEN`, `DATA_DIR=/app/data`, `PORT=8080`.
5. Railway gives you a public URL like `https://icode-control.up.railway.app`.
6. Your admin dashboard: `https://icode-control.up.railway.app/admin`
   Your baked URL for binaries: `https://icode-control.up.railway.app`

## Option B — Fly.io

Run from this folder (which contains `fly.toml`):

```
flyctl launch
flyctl volumes create icode_data --size 1   # persistent volume
flyctl secrets set ADMIN_TOKEN=<your-token> DATA_DIR=/app/data
flyctl deploy
flyctl open
```

Admin dashboard: `https://<app>.fly.dev/admin`

## Option C — Render

1. New → Web Service → connect repo, root dir `packages/icode-control`.
2. Environment: Docker (uses the Dockerfile). Or Nixpacks.
3. Add a **Disk** mounted at `/app/data`.
4. Env: `ADMIN_TOKEN`, `DATA_DIR=/app/data`, `PORT=8080`.
5. URL like `https://icode-control.onrender.com` → dashboard at `/admin`.
   Production URL for this project: **https://icode-2.onrender.com** (admin at
   `https://icode-2.onrender.com/admin`).

---

## After deploying

1. Open `/admin`, enter your `ADMIN_TOKEN`.
2. The **Dashboard** tab shows live stats (pending/approved/rejected, active/expired passcodes).
3. **Payment Requests** arrive here from the linked Google Form (see "Form bridge" below).
   Click **View** to check a submission, then **Approve** (generates a unique
   `ICODE-XXXX-XXXX` passcode to copy and send to the user) or **Reject**.
4. The **Passcodes** tab lists all codes with revoke/reactivate controls.
5. The **Audit Log** tab records every important action.
6. The **Tools** tab keeps the original quick actions: generate a free public code
   and manually issue a passcode for a paying customer.
7. Tell me the public URL (e.g. `https://icode-control.up.railway.app`)
   and I'll rebuild all iCode platform binaries with it baked in, then republish.

## Payment & access flow

```
Pay 1,000 RWF (MTN MoMo 1787240 / BK Bank 100269073874, Paisible Valentin)
      ↓
Fill the Google Form
      ↓
Apps Script bridge → POST /v1/webhook/form (x-webhook-token required)
      ↓
Payment Request created (PENDING)  · duplicate detected on same transaction ref
      ↓
Admin reviews payment in dashboard
      ↓
Admin clicks Approve
      ↓
Unique secure passcode generated (ICODE-XXXX-XXXX), linked to the request
      ↓
User enters passcode in iCode (CLI) or on the access page
      ↓
Server validates → access activated
```

The admin ALWAYS reviews payments before approval. Submission alone never grants access.

## Form bridge (Google Forms → backend)

Google Forms don't send webhooks. Link the form to a Google Sheet, then:

1. Open the sheet → Extensions → Apps Script.
2. Paste the contents of `scripts/form-bridge.gs`.
3. This repo's `scripts/form-bridge.gs` is pre-set for
   `WEBHOOK_URL = https://icode-2.onrender.com/v1/webhook/form` and
   `WEBHOOK_TOKEN = <the WEBHOOK_SECRET you set on Render>`. Keep them in sync.
4. Adjust the `mapColumns()` function so the column indices match your form.
5. Save, run `onFormSubmit` once to authorize, then add a Trigger:
   **On form submit** → `onFormSubmit`.

Each submission hits `POST /v1/webhook/form` with a valid `x-webhook-token`.
Requests without the token, invalid fields, or non-1000 RWF amounts are rejected.
Duplicate transaction references are flagged but never auto-approved.

## API routes

Client (no auth):
- `POST /v1/passcode/validate` — validate a passcode (rate-limited per machine)
- `POST /v1/install/heartbeat`, `POST /v1/install/status` — client liveness/usage
- `GET /v1/health` — health check

Webhook (requires `x-webhook-token`):
- `POST /v1/webhook/form` — ingest a payment-form submission

Admin (requires `Authorization: Bearer $ADMIN_TOKEN`):
- `GET /v1/admin/dashboard/stats`
- `GET /v1/admin/payment-requests`, `GET /v1/admin/payment-requests/:id`
- `POST /v1/admin/payment-requests/:id/approve`, `POST /v1/admin/payment-requests/:id/reject`
- `GET /v1/admin/passcodes`, `POST /v1/admin/passcodes/generate`, `POST /v1/admin/passcodes/issue`
- `POST /v1/admin/passcodes/:id/revoke`, `POST /v1/admin/passcodes/:id/reactivate`
- `GET /v1/admin/audit-log`
- Plus the existing install/customer management routes.
