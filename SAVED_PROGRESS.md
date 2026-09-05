# iCode — SAVED PROGRESS

> Resume point. Summary of where the project stands, what's done, what's in-flight
> (uncommitted), and the next steps.

---

## 1. The two codebases involved

- **Control Server** — `/home/valentin/icode/icode-control-deploy`
  (Bun + SQLite + single-page paid-access server). Git repo, pushed to Render.
  Production: `https://icode-s05p.onrender.com` (admin at `/admin`).
- **iCode client** — `/home/valentin/icode/icode` (coding agent, an opencode fork).
  **NOT a git repo** — changes are on-disk edits only. Distributed via npm binaries;
  a rebuild + republish is required for client changes to reach users.

---

## 2. Product flow
Free **21-day trial** → browser passcode gate → resume iCode CLI in terminal → pay
**1,000 RWF** → admin approves → unique passcode → access.

---

## 3. Control server — DONE & deployed
- Live on Render at the URL above (old `icode-2` URL is dead).
- Real creds in `data/.env.runtime` (chmod 600, gitignored): `ADMIN_TOKEN`,
  `WEBHOOK_SECRET`, etc. (see `RENDER_SETUP.txt`, gitignored).
- Latest commits pushed: `4146987` (notifications / code masking), `028b7a2`
  (trial + activate), `67567db` (access-page UX redesign, Kinyarwanda messages,
  `remaining_days` in trial response, `/v1/admin/passcodes/:id/{revoke,reactivate}`
  route fix). All deployed live on Render (`/v1/health` OK).
- Full feature set: trial/activate endpoints, webhook, audit log, admin masking,
  rate limiting, spec-compliant payment handling (exact 1000 RWF, dup detection),
  access-page redesign with payment methods + Google Form CTA.

---

## 4. Control server — IN-FLIGHT, ON DISK BUT **NOT COMMITTED**
Admin **"Trials" tab** + **trial-expiry webhook notification**. Code is written;
typechecks; **not committed/pushed/deployed yet**.

Changed files (all in `/home/valentin/icode/icode-control-deploy`):
- `src/db.ts` — added `trial_alerts` table (schema); `listTrials()`,
  `listPendingTrialAlerts()`, `markTrialAlerted()`.
- `src/routes/admin.ts` — `adminListTrials()` + `AdminTrialListResponse`.
- `src/notify.ts` — `sendTrialExpiryNotification()`.
- `src/index.ts` — `adminListTrials` import, `GET /v1/admin/trials` route,
  trial-expiry **scheduler** (checks hourly for trials expiring within 48h, fires
  notification once per machine via `markTrialAlerted`; no-op unless
  `NOTIFICATION_WEBHOOK_URL` set; runs once ~5s after boot).
- `public/index.html` — `trials` nav link, `tab-trials` section (table + active/
  expired stat cards), `loadTrials()`, registered `trials` in `setTab`.

**Verified:** `bun run typecheck` passes. Local test confirmed
`GET /v1/admin/trials` returns test machines correctly.

**OUTSTANDING — fix test script, finish verification:**
- Test script `/tmp/test-trials.sh` has a bug in its notification receiver
  `notify-recv.ts`: it reads `process.env.NPORT` but the invocation passes
  `NOTIFY_PORT`, and the `fetch` is missing `async`. Fix (read `NPORT`, add
  `async fetch`) then re-run to confirm the expiry webhook actually fires when a
  trial's passcode is within/at expiry.

### On-disk increments to verify before committing:
1. Fix receiver + run `/tmp/test-trials.sh` → confirm notification fires.
2. `bun run typecheck` (control server).
3. Commit + push to `origin/main` → deploys to Render (needs valid PAT or run
   push from the user's machine).

---

## 5. npm distribution — DONE & fully verified (gate LIVE)
End-user install:
```sh
npm install -g @vln.codes__/icode
```
Then run `icode` (TUI), `icode run "..."`, `icode --help`.

Everything published at **1.1.0** on `latest` tag (Sep 2026):
- **Launcher** `@vln.codes__/icode@1.1.0` → `bin/icode.js` resolves + spawns a
  platform binary (esbuild-style `optionalDependencies` all `1.1.0`).
- **All 6 platform binaries** `@vln.codes__/icode-{linux,darwin,windows}-{x64,arm64}@1.1.0`.
- Built from the gate-enabled source with `OPENCODE_VERSION=1.1.0`, which bakes
  `ICODE_CONTROL_URL=https://icode-s05p.onrender.com` into the binary.
- Native smoke tests passed (`icode --version` → `1.1.0`).

✓ **End-to-end gate verified against the PRODUCTION server** with the published
binary: fresh machine → server starts the 21-day trial (expires +21d), local
`passcode.json` stores `{passcode:"TRIAL"...}`, welcome banner prints remaining
days, browser opens the access page, iCode/TUI launches.

RELEASE RECIPE (for future bumps):
1. `cd packages/opencode && OPENCODE_VERSION=<v> bun run script/build.ts`
   (builds all 12 targets incl. musl/baseline; smoke test runs on the native one).
   Gate is baked via `ICODE_CONTROL_URL` define in `script/build.ts:200`.
2. `cd packages/icode && bun run script/package.ts --version=<v>` → assembles the
   6 platform dirs under `packages/icode/npm/`.
3. Bump `packages/icode/package.json` `version` + `optionalDependencies` to the
   same `<v>`.
4. Publish each of the 6 platform packages (`bun pm pack` + `npm publish
   *.tgz --access public --tag latest`), then pack+publish the launcher
   (use `npm pack`/`npm publish` for the launcher since `bun pm pack` chokes on
   the workspace devDependency).
   - Flaky uploads: set `npm config set fetch-retries 6`, or use `bun publish`
     (worked for the stubborn tarball).

---

## 6. NEXT STEP — repackage / release script (DONE, see section 5)

---

## 7. Other things to remember
- A fresh GitHub PAT was supplied and stored in `~/.git-credentials` (chmod 600)
  for this repo; the previously-exposed PAT is retired. Treat credentials as
  sensitive; revoke if leaked.
- Google Form in use: `https://forms.gle/48iUwJ2nCBU6uwQc8`. Do NOT create
  another form — the link is baked into the published access page + CLI banners.
- The `/home/valentin/icode/icode` repo also contains a **dev copy** of the
  control server at `packages/icode-control/` (NOT the deployed one; deployed
  copy is `/home/valentin/icode/icode-control-deploy`). Don't get them mixed up.
- Shell-tool background processes hang: use self-contained `bash /tmp/*.sh`
  scripts that `kill` their children before exiting (worked for flaky npm
  publishes — run detached with `setsid nohup ... &`).
- Read-only infrastructure constraints from AGENTS.md (dev branch default, etc.)
  apply to `/home/valentin/icode/icode`.
