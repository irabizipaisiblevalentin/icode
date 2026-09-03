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
- Committed & pushed: `4146987` (notifications / code masking), `028b7a2`
  (trial + activate).
- Full feature set: trial/activate endpoints, webhook, audit log, admin masking,
  rate limiting, spec-compliant payment handling (exact 1000 RWF, dup detection).

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

## 5. npm distribution — DONE & fully verified
End-user install:
```sh
npm install -g @vln.codes__/icode
```
Then run `icode` (TUI), `icode run "..."`, `icode --help`.

Verified end-to-end:
- **Launcher** `@vln.codes__/icode@1.0.2` → `bin/icode.js` resolves + spawns a
  platform binary (esbuild-style `optionalDependencies`).
- **All 6 platform binaries published** @ `1.0.0`:
  `@vln.codes__/icode-{linux,darwin,windows}-{x64,arm64}`.
- **Tested:** clean global install in isolated prefix → `icode --version` →
  `0.0.0-dev-202609020818`, exit 0.
- Native binary is real: 141 MB ELF linux-x64, runs correctly.

⚠️ **IMPORTANT:** that installed binary is a **dev build from BEFORE the
trial/passcode gate**. It does NOT contain the gate or the updated
`ICODE_CONTROL_URL` (`https://icode-s05p.onrender.com`). Users installing right
now get old behavior.

---

## 6. NEXT STEP — repackage / release script (NOT done yet)
Build a script that:
1. Rebuilds the iCode binary **from the gate-enabled source** at
   `/home/valentin/icode/icode` (gate edits in
   `packages/opencode/src/passcode/client.ts` + `build.ts:200`).
2. Republishes **all 6 platform packages** with a new version.
3. Bumps the launcher's `optionalDependencies` (`packages/icode/package.json`) to
   match, and bumps/publishes `@vln.codes__/icode` itself.

Explored so far:
- Launcher source: `packages/icode/` (package.json, `script/package.ts` = the
  `package` npm script, `bin/icode.js` / `bin/icode.ts`).
- `packages/opencode/script/publish.ts` and `build.ts` also exist.
- Client repo is not a git repo; binary redistribution required for gate to reach
  users.

---

## 7. Other things to remember
- The exposed GitHub PAT should be **revoked/rotated**; further pushes from this
  session need a fresh token or must be run from the user's machine.
- Optional: web access page pay-link is currently a placeholder
  (`https://forms.gle/48iUwJ2nCBU6uwQc8`) — may want the live Google Form URL.
- Shell-tool background processes hang: use self-contained `bash /tmp/*.sh`
  scripts that `kill` their children before exiting.
- Read-only infrastructure constraints from AGENTS.md (dev branch default, etc.)
  apply to `/home/valentin/icode/icode`.
