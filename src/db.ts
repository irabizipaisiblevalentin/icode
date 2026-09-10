import { createHash, randomInt, randomUUID } from "crypto"
import { getDriver, backendName, type SqlDriver } from "./db-driver"

export { backendName }

export const ACCESS_DURATION_DAYS = parseInt(process.env.ICODE_ACCESS_DURATION_DAYS ?? "30")
export const TRIAL_DURATION_DAYS = parseInt(process.env.ICODE_TRIAL_DURATION_DAYS ?? "21")
export const PAYMENT_AMOUNT_RWF = 1000

const WEBHOOK_SECRET = process.env.WEBHOOK_SECRET
export function isValidWebhook(request: Request): boolean {
  if (!WEBHOOK_SECRET) return false
  const header = request.headers.get("x-webhook-token")
  if (!header) return false
  if (header !== WEBHOOK_SECRET) return false
  return true
}

let _ready: Promise<SqlDriver> | null = null

async function db(): Promise<SqlDriver> {
  if (!_ready) {
    _ready = (async () => {
      const driver = getDriver()
      await ensureSchema(driver)
      return driver
    })()
  }
  return _ready
}

// Creates the tables (and applies legacy migrations) on any driver. Exported so
// tooling such as the Turso migration script can bring a fresh remote database
// up to the same schema before copying rows across.
export async function ensureSchema(db: SqlDriver): Promise<void> {
  await init(db)
}

// Backdoor for tests/scripts: force re-initialisation against a fresh driver.
export function resetDbForTest(): void {
  _ready = null
}

async function init(db: SqlDriver) {
  await db.run(`
    CREATE TABLE IF NOT EXISTS passcodes (
      id TEXT PRIMARY KEY,
      code TEXT UNIQUE NOT NULL,
      code_hash TEXT UNIQUE NOT NULL,
      type TEXT NOT NULL CHECK(type IN ('public','personal')),
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      expires_at TEXT NOT NULL,
      max_uses INTEGER,
      current_uses INTEGER NOT NULL DEFAULT 0,
      blocked INTEGER NOT NULL DEFAULT 0,
      note TEXT,
      payment_request_id TEXT
    )
  `)
  await db.run(`
    CREATE TABLE IF NOT EXISTS customers (
      id TEXT PRIMARY KEY,
      name TEXT,
      email TEXT,
      phone TEXT,
      reference TEXT,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      passcode_id TEXT,
      last_payment_at TEXT,
      notes TEXT
    )
  `)
  await db.run(`
    CREATE TABLE IF NOT EXISTS installs (
      id TEXT PRIMARY KEY,
      machine_id TEXT UNIQUE NOT NULL,
      hardware_id TEXT,
      platform TEXT NOT NULL,
      arch TEXT NOT NULL,
      version TEXT,
      passcode_id TEXT,
      registered_at TEXT NOT NULL DEFAULT (datetime('now')),
      last_seen_at TEXT NOT NULL DEFAULT (datetime('now')),
      blocked INTEGER NOT NULL DEFAULT 0,
      block_reason TEXT,
      trial_started_at TEXT
    )
  `)
  await db.run(`
    CREATE TABLE IF NOT EXISTS usage (
      install_id TEXT NOT NULL,
      period_key TEXT NOT NULL,
      seconds_used REAL NOT NULL DEFAULT 0,
      PRIMARY KEY (install_id, period_key)
    )
  `)
  await db.run(`
    CREATE TABLE IF NOT EXISTS trial_alerts (
      machine_id TEXT PRIMARY KEY,
      passcode_id TEXT,
      expires_at TEXT
    )
  `)
  await db.run(`
    CREATE TABLE IF NOT EXISTS payment_requests (
      id TEXT PRIMARY KEY,
      full_name TEXT NOT NULL,
      email TEXT,
      phone_number TEXT,
      payment_method TEXT NOT NULL,
      transaction_reference TEXT NOT NULL,
      payment_amount REAL NOT NULL,
      payment_date TEXT,
      payment_time TEXT,
      payment_proof TEXT,
      status TEXT NOT NULL DEFAULT 'PENDING' CHECK(status IN ('PENDING','APPROVED','REJECTED')),
      admin_note TEXT,
      is_duplicate INTEGER NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at TEXT NOT NULL DEFAULT (datetime('now')),
      verified_at TEXT,
      verified_by TEXT
    )
  `)
  await db.run(`
    CREATE TABLE IF NOT EXISTS audit_log (
      id TEXT PRIMARY KEY,
      action TEXT NOT NULL,
      actor_id TEXT,
      target_id TEXT,
      timestamp TEXT NOT NULL DEFAULT (datetime('now')),
      metadata TEXT
    )
  `)
  await db.run(`CREATE INDEX IF NOT EXISTS idx_payment_requests_transaction ON payment_requests(transaction_reference)`)
  await db.run(`CREATE INDEX IF NOT EXISTS idx_payment_requests_status ON payment_requests(status)`)
  await db.run(`CREATE INDEX IF NOT EXISTS idx_passcodes_payment ON passcodes(payment_request_id)`)

  // Migrations for passcodes created by earlier versions of the table
  const cols = (await db.all(`PRAGMA table_info(passcodes)`)) as { name: string }[]
  if (!cols.some((c) => c.name === "payment_request_id")) {
    await db.run(`ALTER TABLE passcodes ADD COLUMN payment_request_id TEXT`)
  }
  if (!cols.some((c) => c.name === "code_hash")) {
    await db.run(`ALTER TABLE passcodes ADD COLUMN code_hash TEXT`)
    // Backfill hashes for any pre-existing plaintext codes.
    const rows = (await db.all(`SELECT id, code FROM passcodes WHERE code_hash IS NULL`)) as { id: string; code: string }[]
    for (const row of rows) {
      await db.run(`UPDATE passcodes SET code_hash = ? WHERE id = ?`, [hashCode(row.code), row.id])
    }
  }
  const installCols = (await db.all(`PRAGMA table_info(installs)`)) as { name: string }[]
  if (!installCols.some((c) => c.name === "trial_started_at")) {
    await db.run(`ALTER TABLE installs ADD COLUMN trial_started_at TEXT`)
  }
  if (!installCols.some((c) => c.name === "hardware_id")) {
    await db.run(`ALTER TABLE installs ADD COLUMN hardware_id TEXT`)
  }
  await db.run(`CREATE INDEX IF NOT EXISTS idx_installs_hardware ON installs(hardware_id)`)
}

// ─── Passcodes ────────────────────────────────────────────────────────

export interface PasscodeRow {
  id: string
  code: string
  code_hash: string
  type: "public" | "personal"
  created_at: string
  expires_at: string
  max_uses: number | null
  current_uses: number
  blocked: number
  note: string | null
  payment_request_id: string | null
}

export async function createPasscode(opts: {
  type: "public" | "personal"
  expires_at: string
  max_uses?: number | null
  code?: string
  note?: string
  payment_request_id?: string
}): Promise<PasscodeRow> {
  const d = await db()
  const id = randomUUID()
  const code = opts.code ?? randomCode()
  await d.run(
    `INSERT INTO passcodes (id, code, code_hash, type, expires_at, max_uses, note, payment_request_id) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    [id, code, hashCode(code), opts.type, opts.expires_at, opts.max_uses ?? null, opts.note ?? null, opts.payment_request_id ?? null],
  )
  return (await getPasscode(id))!
}

export async function getPasscode(id: string): Promise<PasscodeRow | null> {
  return (await db()).get<PasscodeRow>(`SELECT * FROM passcodes WHERE id = ?`, [id])
}

export async function findPasscodeByCode(code: string): Promise<PasscodeRow | null> {
  const hash = hashCode(code)
  return (await db()).get<PasscodeRow>(`SELECT * FROM passcodes WHERE code_hash = ?`, [hash])
}

export async function listPasscodes(): Promise<PasscodeRow[]> {
  return (await db()).all<PasscodeRow>(`SELECT * FROM passcodes ORDER BY created_at DESC`)
}

export async function incrementPasscodeUse(id: string): Promise<void> {
  await (await db()).run(`UPDATE passcodes SET current_uses = current_uses + 1 WHERE id = ?`, [id])
}

export async function blockPasscode(id: string): Promise<void> {
  await (await db()).run(`UPDATE passcodes SET blocked = 1 WHERE id = ?`, [id])
}

export async function unblockPasscode(id: string): Promise<void> {
  await (await db()).run(`UPDATE passcodes SET blocked = 0 WHERE id = ?`, [id])
}

export async function deletePasscode(id: string): Promise<void> {
  await (await db()).run(`DELETE FROM passcodes WHERE id = ?`, [id])
}

// ─── Customers ────────────────────────────────────────────────────────

export interface CustomerRow {
  id: string
  name: string | null
  email: string | null
  phone: string | null
  reference: string | null
  created_at: string
  passcode_id: string | null
  last_payment_at: string | null
  notes: string | null
}

export async function createCustomer(opts: {
  name?: string
  email?: string
  phone?: string
  reference?: string
  passcode_id?: string
  notes?: string
}): Promise<CustomerRow> {
  const d = await db()
  const id = randomUUID()
  await d.run(
    `INSERT INTO customers (id, name, email, phone, reference, passcode_id, last_payment_at, notes)
     VALUES (?, ?, ?, ?, ?, ?, datetime('now'), ?)`,
    [
      id,
      opts.name ?? null,
      opts.email ?? null,
      opts.phone ?? null,
      opts.reference ?? null,
      opts.passcode_id ?? null,
      opts.notes ?? null,
    ],
  )
  return (await getCustomer(id))!
}

export async function getCustomer(id: string): Promise<CustomerRow | null> {
  return (await db()).get<CustomerRow>(`SELECT * FROM customers WHERE id = ?`, [id])
}

export async function findCustomerByEmailOrRef(email?: string, ref?: string): Promise<CustomerRow | null> {
  const d = await db()
  if (email) {
    const byEmail = await d.get<CustomerRow>(`SELECT * FROM customers WHERE email = ?`, [email])
    if (byEmail) return byEmail
  }
  if (ref) {
    const byRef = await d.get<CustomerRow>(`SELECT * FROM customers WHERE reference = ?`, [ref])
    if (byRef) return byRef
  }
  return null
}

export async function listCustomers(): Promise<CustomerRow[]> {
  return (await db()).all<CustomerRow>(`SELECT * FROM customers ORDER BY created_at DESC`)
}

export async function linkCustomerPasscode(id: string, passcodeId: string): Promise<void> {
  await (await db()).run(`UPDATE customers SET passcode_id = ?, last_payment_at = datetime('now') WHERE id = ?`, [passcodeId, id])
}

export async function updateCustomerNotes(id: string, notes: string | null): Promise<void> {
  await (await db()).run(`UPDATE customers SET notes = ? WHERE id = ?`, [notes ?? null, id])
}

export async function deleteCustomer(id: string): Promise<void> {
  await (await db()).run(`DELETE FROM customers WHERE id = ?`, [id])
}

// ─── Installs ─────────────────────────────────────────────────────────

export interface InstallRow {
  id: string
  machine_id: string
  hardware_id: string | null
  platform: string
  arch: string
  version: string | null
  passcode_id: string | null
  registered_at: string
  last_seen_at: string
  blocked: number
  block_reason: string | null
  trial_started_at: string | null
}

export async function upsertInstall(opts: {
  machine_id: string
  hardware_id?: string
  platform: string
  arch: string
  version?: string
  passcode_id?: string
}): Promise<InstallRow> {
  const d = await db()
  const existing = await d.get<InstallRow>(`SELECT * FROM installs WHERE machine_id = ?`, [opts.machine_id])

  // The machine_id is new (often after a reinstall wiped the state folder), but
  // the same PC may already be known by its hardware fingerprint. In that case
  // adopt the existing install (keeping its trial/passcode/history) instead of
  // creating a duplicate that could restart the free trial.
  const knownByHardware =
    !existing && opts.hardware_id ? await d.get<InstallRow>(`SELECT * FROM installs WHERE hardware_id = ?`, [opts.hardware_id]) : null

  if (existing || knownByHardware) {
    const row = existing ?? knownByHardware!
    const hardwareId = opts.hardware_id || row.hardware_id
    await d.run(
      `UPDATE installs SET machine_id = ?, hardware_id = ?, platform = ?, arch = ?, version = ?, passcode_id = ?, last_seen_at = datetime('now') WHERE id = ?`,
      [
        opts.machine_id,
        hardwareId,
        opts.platform,
        opts.arch,
        opts.version ?? row.version,
        opts.passcode_id ?? row.passcode_id,
        row.id,
      ],
    )
    return (await d.get<InstallRow>(`SELECT * FROM installs WHERE id = ?`, [row.id]))!
  }

  const id = randomUUID()
  await d.run(
    `INSERT INTO installs (id, machine_id, hardware_id, platform, arch, version, passcode_id) VALUES (?, ?, ?, ?, ?, ?, ?)`,
    [id, opts.machine_id, opts.hardware_id ?? null, opts.platform, opts.arch, opts.version ?? null, opts.passcode_id ?? null],
  )
  return (await d.get<InstallRow>(`SELECT * FROM installs WHERE id = ?`, [id]))!
}

export async function getInstallByHardware(hardwareId: string): Promise<InstallRow | null> {
  return (await db()).get<InstallRow>(`SELECT * FROM installs WHERE hardware_id = ?`, [hardwareId])
}

export async function getInstallByMachine(machineId: string): Promise<InstallRow | null> {
  return (await db()).get<InstallRow>(`SELECT * FROM installs WHERE machine_id = ?`, [machineId])
}

export async function getInstallByMachineOrHardware(machineId: string, hardwareId?: string | null): Promise<InstallRow | null> {
  const d = await db()
  const byMachine = await d.get<InstallRow>(`SELECT * FROM installs WHERE machine_id = ?`, [machineId])
  if (byMachine) return byMachine
  if (hardwareId) {
    const byHardware = await d.get<InstallRow>(`SELECT * FROM installs WHERE hardware_id = ?`, [hardwareId])
    if (byHardware) return byHardware
  }
  return null
}

export async function listInstalls(): Promise<InstallRow[]> {
  return (await db()).all<InstallRow>(`SELECT * FROM installs ORDER BY last_seen_at DESC`)
}

export async function blockInstall(id: string, reason?: string): Promise<void> {
  await (await db()).run(`UPDATE installs SET blocked = 1, block_reason = ? WHERE id = ?`, [reason ?? null, id])
}

export async function unblockInstall(id: string): Promise<void> {
  await (await db()).run(`UPDATE installs SET blocked = 0, block_reason = NULL WHERE id = ?`, [id])
}

export async function deleteInstall(id: string): Promise<void> {
  await (await db()).run(`DELETE FROM installs WHERE id = ?`, [id])
}

// ─── Usage ────────────────────────────────────────────────────────────

export interface UsageRow {
  id: number
  install_id: string
  period_key: string
  seconds_used: number
}

export async function addUsage(installId: string, periodKey: string, seconds: number): Promise<void> {
  const d = await db()
  await d.run(
    `INSERT INTO usage (install_id, period_key, seconds_used) VALUES (?, ?, ?)
     ON CONFLICT(install_id, period_key) DO UPDATE SET seconds_used = seconds_used + ?`,
    [installId, periodKey, seconds, seconds],
  )
}

// Refresh the "last seen" marker so the admin Users view can show who is
// actively using ICODE right now. Called on every heartbeat.
export async function touchInstall(installId: string): Promise<void> {
  await (await db()).run(`UPDATE installs SET last_seen_at = datetime('now') WHERE id = ?`, [installId])
}

export async function getUsage(installId: string, periodKey: string): Promise<number> {
  const row = await (await db()).get<{ seconds_used: number }>(
    `SELECT seconds_used FROM usage WHERE install_id = ? AND period_key = ?`,
    [installId, periodKey],
  )
  return row?.seconds_used ?? 0
}

// ─── Trials ───────────────────────────────────────────────────────────

export interface TrialResult {
  install: InstallRow
  passcode: PasscodeRow | null
  already_started: boolean
  trial_expires_at: string | null
}

// Grants a one-time free trial per machine. A trial is issued only once per
// hardware; repeat calls (or reinstalls under a new machine_id) return the
// existing trial (so it cannot be restarted or extended by reinstalling).
export async function startTrial(opts: {
  machine_id: string
  hardware_id?: string
  platform: string
  arch: string
  version?: string
}): Promise<TrialResult> {
  const d = await db()
  const install = await upsertInstall(opts)

  if (install.trial_started_at) {
    return {
      install,
      passcode: install.passcode_id ? await getPasscode(install.passcode_id) : null,
      already_started: true,
      trial_expires_at: install.passcode_id ? ((await getPasscode(install.passcode_id))?.expires_at ?? null) : null,
    }
  }

  await d.run(`UPDATE installs SET trial_started_at = datetime('now') WHERE id = ?`, [install.id])

  const expires = new Date(Date.now() + TRIAL_DURATION_DAYS * 24 * 60 * 60 * 1000).toISOString()
  const passcode = await createPasscode({ type: "public", expires_at: expires, note: "Free 21-day trial" })
  await d.run(`UPDATE installs SET passcode_id = ? WHERE id = ?`, [passcode.id, install.id])

  await writeAudit("TRIAL_STARTED", opts.machine_id, install.id, { machine_id: opts.machine_id })
  return {
    install: (await d.get<InstallRow>(`SELECT * FROM installs WHERE id = ?`, [install.id]))!,
    passcode,
    already_started: false,
    trial_expires_at: expires,
  }
}

// Binds a machine to a validated passcode. Used by the web access page so a
// CLI waiting on /v1/install/status can see the activation take effect.
export async function activateInstallByCode(opts: {
  machine_id: string
  hardware_id?: string
  platform: string
  arch: string
  version?: string
  passcode_id: string
}): Promise<InstallRow> {
  return upsertInstall({
    machine_id: opts.machine_id,
    hardware_id: opts.hardware_id,
    platform: opts.platform,
    arch: opts.arch,
    version: opts.version,
    passcode_id: opts.passcode_id,
  })
}

// ─── Trial listing & alerts ───────────────────────────────────────────

export interface TrialListItem {
  install_id: string
  machine_id: string
  platform: string
  arch: string
  version: string | null
  passcode_id: string | null
  trial_started_at: string
  expires_at: string | null
  blocked: number
}

// Installs that received a free trial, with the linked passcode expiry.
export async function listTrials(): Promise<TrialListItem[]> {
  return (await db()).all<TrialListItem>(`
    SELECT i.id AS install_id, i.machine_id, i.platform, i.arch, i.version,
           i.passcode_id, i.trial_started_at, p.expires_at, i.blocked
    FROM installs i
    LEFT JOIN passcodes p ON p.id = i.passcode_id
    WHERE i.trial_started_at IS NOT NULL
    ORDER BY i.trial_started_at DESC
  `)
}

// Trials that are within `hoursWindow` hours of expiry (or already expired) and
// have not yet been alerted, so the operator can nudge each user once.
export async function listPendingTrialAlerts(hoursWindow: number): Promise<TrialListItem[]> {
  const limit = new Date(Date.now() + hoursWindow * 60 * 60 * 1000).toISOString()
  return (await db()).all<TrialListItem>(
    `
    SELECT i.id AS install_id, i.machine_id, i.platform, i.arch, i.version,
           i.passcode_id, i.trial_started_at, p.expires_at, i.blocked
    FROM installs i
    JOIN passcodes p ON p.id = i.passcode_id
    WHERE i.trial_started_at IS NOT NULL
      AND p.expires_at IS NOT NULL
      AND p.expires_at <= ?
      AND i.machine_id NOT IN (SELECT machine_id FROM trial_alerts)
    ORDER BY p.expires_at ASC
  `,
    [limit],
  )
}

// Installations enriched with the linked passcode, customer (if any) and the
// seconds used this calendar month, so the admin can see exactly who is using
// ICODE and how active they are.
export interface UserListItem {
  id: string
  machine_id: string
  hardware_id: string | null
  platform: string
  arch: string
  version: string | null
  passcode_id: string | null
  passcode_code: string | null
  passcode_type: string | null
  passcode_expires_at: string | null
  customer_name: string | null
  customer_email: string | null
  customer_phone: string | null
  trial_started_at: string | null
  registered_at: string
  last_seen_at: string
  blocked: number
  block_reason: string | null
  usage_month: number
}

export async function listUsers(): Promise<UserListItem[]> {
  const now = new Date()
  const periodKey = `${now.getUTCFullYear()}-${String(now.getUTCMonth() + 1).padStart(2, "0")}`
  return (await db()).all<UserListItem>(
    `
    SELECT i.id, i.machine_id, i.hardware_id, i.platform, i.arch, i.version,
           i.passcode_id,
           p.code AS passcode_code,
           p.type AS passcode_type,
           p.expires_at AS passcode_expires_at,
           c.name AS customer_name,
           c.email AS customer_email,
           c.phone AS customer_phone,
           i.trial_started_at, i.registered_at, i.last_seen_at,
           i.blocked, i.block_reason,
           COALESCE(u.seconds_used, 0) AS usage_month
    FROM installs i
    LEFT JOIN passcodes p ON p.id = i.passcode_id
    LEFT JOIN customers c ON c.passcode_id = i.passcode_id
    LEFT JOIN usage u ON u.install_id = i.id AND u.period_key = ?
    ORDER BY i.last_seen_at DESC
  `,
    [periodKey],
  )
}

export async function markTrialAlerted(machineId: string, passcodeId: string | null, expiresAt: string): Promise<void> {
  await (await db()).run(
    `INSERT OR REPLACE INTO trial_alerts (machine_id, passcode_id, expires_at) VALUES (?, ?, ?)`,
    [machineId, passcodeId, expiresAt],
  )
}

// ─── Payment Requests ────────────────────────────────────────────────

export type PaymentStatus = "PENDING" | "APPROVED" | "REJECTED"

export interface PaymentRequestRow {
  id: string
  full_name: string
  email: string | null
  phone_number: string | null
  payment_method: string | null
  transaction_reference: string | null
  payment_amount: number | null
  payment_date: string | null
  payment_time: string | null
  payment_proof: string | null
  status: PaymentStatus
  admin_note: string | null
  is_duplicate: number
  created_at: string
  updated_at: string
  verified_at: string | null
  verified_by: string | null
}

export interface PaymentRequestInput {
  fullName: string
  email?: string
  phoneNumber?: string
  paymentMethod?: string
  transactionReference?: string
  paymentAmount?: number
  paymentDate?: string
  paymentTime?: string
  paymentProof?: string
}

export async function findDuplicatePayment(
  reference?: string,
  method?: string,
  amount?: number,
  email?: string,
): Promise<PaymentRequestRow | null> {
  if (!reference) return null
  return (await db()).get<PaymentRequestRow>(
    `SELECT * FROM payment_requests WHERE transaction_reference = ? ORDER BY created_at DESC LIMIT 1`,
    [reference],
  )
}

export async function createPaymentRequest(input: PaymentRequestInput): Promise<{ request: PaymentRequestRow; isDuplicate: boolean }> {
  const d = await db()
  const duplicate = await findDuplicatePayment(input.transactionReference, input.paymentMethod, input.paymentAmount, input.email)
  const id = randomUUID()
  const ref = input.transactionReference ?? null
  const method = (input.paymentMethod ?? "other").trim() || "other"
  await d.run(
    `INSERT INTO payment_requests (id, full_name, email, phone_number, payment_method, transaction_reference, payment_amount, payment_date, payment_time, payment_proof, is_duplicate)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      id,
      input.fullName,
      input.email ?? null,
      input.phoneNumber ?? null,
      method,
      ref,
      input.paymentAmount ?? null,
      input.paymentDate ?? null,
      input.paymentTime ?? null,
      input.paymentProof ?? null,
      duplicate ? 1 : 0,
    ],
  )
  if (duplicate) {
    await writeAudit("DUPLICATE_PAYMENT", "system", id, { reference: input.transactionReference })
  }
  return { request: (await getPaymentRequest(id))!, isDuplicate: !!duplicate }
}

export async function getPaymentRequest(id: string): Promise<PaymentRequestRow | null> {
  return (await db()).get<PaymentRequestRow>(`SELECT * FROM payment_requests WHERE id = ?`, [id])
}

export async function listPaymentRequests(): Promise<PaymentRequestRow[]> {
  return (await db()).all<PaymentRequestRow>(`SELECT * FROM payment_requests ORDER BY created_at DESC`)
}

export async function getPaymentRequestByPasscode(passcodeId: string): Promise<PaymentRequestRow | null> {
  return (await db()).get<PaymentRequestRow>(
    `SELECT * FROM payment_requests WHERE id = (SELECT payment_request_id FROM passcodes WHERE id = ?)`,
    [passcodeId],
  )
}

export async function updatePaymentRequestStatus(
  id: string,
  status: PaymentStatus,
  options?: { adminNote?: string; verifiedBy?: string },
): Promise<PaymentRequestRow | null> {
  await (await db()).run(
    `UPDATE payment_requests SET status = ?, admin_note = ?, verified_at = ?, verified_by = ?, updated_at = datetime('now') WHERE id = ?`,
    [
      status,
      options?.adminNote ?? null,
      status === "APPROVED" || status === "REJECTED" ? new Date().toISOString() : null,
      options?.verifiedBy ?? null,
      id,
    ],
  )
  return getPaymentRequest(id)
}

export async function getPaymentStats() {
  const d = await db()
  const count = async (where: string) => {
    const row = await d.get<{ c: number }>(`SELECT COUNT(*) AS c FROM payment_requests WHERE ${where}`)
    return row?.c ?? 0
  }
  const now = new Date().toISOString()
  return {
    total: await count("1 = 1"),
    pending: await count("status = 'PENDING'"),
    approved: await count("status = 'APPROVED'"),
    rejected: await count("status = 'REJECTED'"),
    active_passcodes: (await d.get<{ c: number }>(`SELECT COUNT(*) AS c FROM passcodes WHERE blocked = 0 AND expires_at > ?`, [now]))?.c ?? 0,
    expired_passcodes: (await d.get<{ c: number }>(`SELECT COUNT(*) AS c FROM passcodes WHERE blocked = 0 AND expires_at <= ?`, [now]))?.c ?? 0,
    total_users: (await d.get<{ c: number }>(`SELECT COUNT(*) AS c FROM installs`))?.c ?? 0,
    online_users:
      (await d.get<{ c: number }>(
        `SELECT COUNT(*) AS c FROM installs WHERE blocked = 0 AND last_seen_at >= datetime('now', '-5 minutes')`,
      ))?.c ?? 0,
  }
}

// ─── Audit Log ────────────────────────────────────────────────────────

export interface AuditLogRow {
  id: string
  action: string
  actor_id: string | null
  target_id: string | null
  timestamp: string
  metadata: string | null
}

export async function writeAudit(action: string, actorId: string, targetId?: string, metadata?: unknown): Promise<void> {
  await (await db()).run(
    `INSERT INTO audit_log (id, action, actor_id, target_id, metadata) VALUES (?, ?, ?, ?, ?)`,
    [randomUUID(), action, actorId, targetId ?? null, metadata ? JSON.stringify(metadata) : null],
  )
}

export async function listAuditLog(): Promise<AuditLogRow[]> {
  return (await db()).all<AuditLogRow>(`SELECT * FROM audit_log ORDER BY timestamp DESC LIMIT 500`)
}

// ─── Helpers ──────────────────────────────────────────────────────────

export function hashCode(code: string): string {
  return createHash("sha256").update(code).digest("hex")
}

export function maskCode(code: string): string {
  const segments = code.split("-")
  if (segments.length < 2) return "••••"
  const head = segments[0]
  const tail = segments.slice(1).map(() => "••••").join("-")
  return `${head}-${tail}`
}

// The raw passcode is returned exactly once, when it is first created; the
// stored hash is never included in any API response.
export interface PasscodeCreatedView {
  id: string
  code: string
  type: "public" | "personal"
  created_at: string
  expires_at: string
  max_uses: number | null
  current_uses: number
  blocked: number
  note: string | null
  payment_request_id: string | null
}

export function toCreatedPasscode(p: PasscodeRow): PasscodeCreatedView {
  return {
    id: p.id,
    code: p.code,
    type: p.type,
    created_at: p.created_at,
    expires_at: p.expires_at,
    max_uses: p.max_uses,
    current_uses: p.current_uses,
    blocked: p.blocked,
    note: p.note,
    payment_request_id: p.payment_request_id,
  }
}

const CODE_CHARS = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789"

function randomCodeChar(): string {
  return CODE_CHARS[randomInt(CODE_CHARS.length)]
}

export function randomCode(): string {
  let code = ""
  for (let i = 0; i < 12; i++) {
    code += randomCodeChar()
    if (i === 3 || i === 7) code += "-"
  }
  return code
}

export function randomAccessCode(): string {
  const block = () => {
    let s = ""
    for (let i = 0; i < 4; i++) s += randomCodeChar()
    return s
  }
  return `ICODE-${block()}-${block()}`
}