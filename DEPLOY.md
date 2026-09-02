# iCode Control — Deployment Files

This folder contains ready-to-use deploy configs for the iCode control server.
The server is a zero-dependency Bun + SQLite app in a single small container.

## Environment variables (set all of them)

| Variable | Required | Purpose |
|---|---|---|
| `ADMIN_TOKEN` | **Yes** | The password for your admin dashboard (`/admin`). Make it long and random. There is a weak default (`icode-admin-secret`) — you MUST set a real one. |
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

---

## After deploying

1. Open `/admin`, enter your `ADMIN_TOKEN`.
2. Click **"Generate public passcode"** → this is your 3-week free code, share it.
3. To approve a paying user: fill the **"Issue passcode for a paying customer"**
   box, copy the code, send it to them.
4. Tell me the public URL (e.g. `https://icode-control.up.railway.app`)
   and I'll rebuild all iCode platform binaries with it baked in, then republish.
