# iCode Control Server

Access-control server for **iCode** — a Kinyarwanda-first coding agent by **Irabizi Paisible Valentin**.

Gates access behind a paid license: users pay **1,000 RWF**, submit the access
form, an admin verifies the payment, and the system issues a unique passcode
(`ICODE-XXXX-XXXX`) that activates their access.

## Stack

- **Bun** + **`bun:sqlite`** — zero runtime npm dependencies
- Single-file SQLite DB (`icode-control.db`)
- Single-page web UI serving both:
  - `/` — user access page (passcode entry, Kinyarwanda messages, payment details)
  - `/admin` — admin dashboard (stats, payment requests, passcodes, audit log)

## Quick start

```bash
bun install
ADMIN_TOKEN=change-me WEBHOOK_SECRET=change-me bun run src/index.ts
# http://localhost:4097  (access page)
# http://localhost:4097/admin  (admin dashboard)
```

Set `ICODE_ACCESS_DURATION_DAYS` to override how long new passcodes last (default 30).

## Environment variables

| Variable | Required | Default | Purpose |
|---|---|---|---|
| `ADMIN_TOKEN` | Yes | `icode-admin-secret` | Admin API/dashboard auth |
| `WEBHOOK_SECRET` | Yes | — | Auth for the form webhook |
| `ICODE_ACCESS_DURATION_DAYS` | No | `30` | Passcode validity in days |
| `NOTIFICATION_WEBHOOK_URL` | No | — | Outbound channel to deliver passcodes (Telegram/email relay/etc.) |
| `NOTIFICATION_WEBHOOK_TOKEN` | No | — | Optional bearer token for that outbound channel |
| `PORT` | No | `4097` | HTTP port |
| `DATA_DIR` | No | current dir | Where `icode-control.db` lives |
| `DB_PATH` | No | derived | Override the full DB path |

## How the money → access flow works

1. User pays **1,000 RWF** via MTN MoMo (`1787240`) or BK Bank (`100269073874`).
2. User submits the Google Form with their payment reference.
3. A bridge (see `scripts/form-bridge.gs`) posts the submission to
   `POST /v1/webhook/form` using `x-webhook-token: $WEBHOOK_SECRET`.
4. The request lands as **PENDING** in `payment_requests`. Duplicate transaction
   references are flagged.
5. Admin reviews in `/admin` and clicks **Approve** → a unique
   `ICODE-XXXX-XXXX` passcode is generated, linked to the request, and shown once.
6. The user enters the passcode in iCode (CLI) or on the access page.
7. `/v1/passcode/validate` checks it; access is granted and recorded.

Approval is always manual — a form submission alone never grants access.

## Security notes

- Passcodes use cryptographically random characters (`ABCDEFGHJKLMNPQRSTUVWXYZ23456789`) via `crypto.randomInt` (CSPRNG).
- Passcodes are stored hashed (SHA-256) and looked up by hash. The raw code is
  returned exactly once, at creation, and never in list endpoints; the hash is
  never exposed.
- `/v1/passcode/validate` is rate-limited per machine (10/min).
- Webhook requests are rejected without a valid token; amounts must equal 1,000.
- Admin routes are server-side protected by `ADMIN_TOKEN` — not just hidden in the UI.
- The admin token is never logged or stored as an actor; the dashboard sends a
  non-secret admin display name for the audit trail.
- An audit log records PAYMENT_APPROVED, PASSCODE_CREATED, PASSCODE_REVOKED, etc.
- Never send/request MTN/Bank PINs, passwords, or OTPs.

## Deploying

See `DEPLOY.md` for Railway / Fly.io / Render setup and the form-bridge guide.

## API surface

All routes are documented in `DEPLOY.md`. The client endpoints
(`/v1/passcode/validate`, `/v1/install/*`) are the ones the iCode binary talks to.
