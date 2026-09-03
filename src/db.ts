import { Database } from "bun:sqlite"
import { createHash, randomInt, randomUUID } from "crypto"
import { mkdirSync } from "fs"
import { join } from "path"

const DB_PATH = process.env.DB_PATH ?? (process.env.DATA_DIR ? join(process.env.DATA_DIR, "icode-control.db") : "./icode-control.db")

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

let _db: Database | null = null

function db(): Database {
  if (!_db) {
    if (DB_PATH !== ":memory:") {
      const parent = DB_PATH.includes("/") ? DB_PATH.slice(0, DB_PATH.lastIndexOf("/")) : "."
      if (parent && parent !== ".") mkdirSync(parent, { recursive: true })
    }
    _db = new Database(DB_PATH)
    _db.run("PRAGMA journal_mode = WAL")
    _db.run("PRAGMA busy_timeout = 5000")
    init(_db)
  }
  return _db
}

function init(db: Database) {
  db.run(`
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
  db.run(`
    CREATE TABLE IF NOT EXISTS customers (
      id TEXT PRIMARY KEY,
      name TEXT,
      email TEXT,
      phone TEXT,
      reference TEXT,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      passcode_id TEXT,
      last_payment_at TEXT,
      notes TEXT,
      FOREIGN KEY (passcode_id) REFERENCES passcodes(id)
    )
  `)
  db.run(`
    CREATE TABLE IF NOT EXISTS installs (
      id TEXT PRIMARY KEY,
      machine_id TEXT UNIQUE NOT NULL,
      platform TEXT NOT NULL,
      arch TEXT NOT NULL,
      version TEXT,
      passcode_id TEXT,
      registered_at TEXT NOT NULL DEFAULT (datetime('now')),
      last_seen_at TEXT NOT NULL DEFAULT (datetime('now')),
      blocked INTEGER NOT NULL DEFAULT 0,
      block_reason TEXT,
      trial_started_at TEXT,
      FOREIGN KEY (passcode_id) REFERENCES passcodes(id)
    )
  `)
  db.run(`
    CREATE TABLE IF NOT EXISTS usage (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      install_id TEXT NOT NULL,
      period_key TEXT NOT NULL,
      seconds_used REAL NOT NULL DEFAULT 0,
      FOREIGN KEY (install_id) REFERENCES installs(id),
      UNIQUE(install_id, period_key)
    )
  `)
  db.run(`
    CREATE TABLE IF NOT EXISTS trial_alerts (
      machine_id TEXT PRIMARY KEY,
      passcode_id TEXT,
      expires_at TEXT,
      notified_at TEXT NOT NULL DEFAULT (datetime('now')),
      FOREIGN KEY (passcode_id) REFERENCES passcodes(id)
    )
  `)
  db.run(`CREATE INDEX IF NOT EXISTS idx_passcodes_code ON passcodes(code)`)
  db.run(`CREATE INDEX IF NOT EXISTS idx_installs_machine ON installs(machine_id)`)

  db.run(`
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
  db.run(`
    CREATE TABLE IF NOT EXISTS audit_log (
      id TEXT PRIMARY KEY,
      action TEXT NOT NULL,
      actor_id TEXT,
      target_id TEXT,
      timestamp TEXT NOT NULL DEFAULT (datetime('now')),
      metadata TEXT
    )
  `)
  db.run(`CREATE INDEX IF NOT EXISTS idx_payment_requests_transaction ON payment_requests(transaction_reference)`)
  db.run(`CREATE INDEX IF NOT EXISTS idx_payment_requests_status ON payment_requests(status)`)
  db.run(`CREATE INDEX IF NOT EXISTS idx_passcodes_payment ON passcodes(payment_request_id)`)

  // Migrations for passcodes created by earlier versions of the table
  const cols = db.query(`PRAGMA table_info(passcodes)`).all() as { name: string }[]
  if (!cols.some((c) => c.name === "payment_request_id")) {
    db.run(`ALTER TABLE passcodes ADD COLUMN payment_request_id TEXT`)
  }
  if (!cols.some((c) => c.name === "code_hash")) {
    db.run(`ALTER TABLE passcodes ADD COLUMN code_hash TEXT`)
    // Backfill hashes for any pre-existing plaintext codes.
    const rows = db.query<{ id: string; code: string }, []>(`SELECT id, code FROM passcodes WHERE code_hash IS NULL`).all()
    for (const row of rows) {
      db.run(`UPDATE passcodes SET code_hash = ? WHERE id = ?`, [hashCode(row.code), row.id])
    }
  }
  const installCols = db.query(`PRAGMA table_info(installs)`).all() as { name: string }[]
  if (!installCols.some((c) => c.name === "trial_started_at")) {
    db.run(`ALTER TABLE installs ADD COLUMN trial_started_at TEXT`)
  }
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

export function createPasscode(opts: {
  type: "public" | "personal"
  expires_at: string
  max_uses?: number | null
  code?: string
  note?: string
  payment_request_id?: string
}): PasscodeRow {
  const d = db()
  const id = randomUUID()
  const code = opts.code ?? randomCode()
  d.run(
    `INSERT INTO passcodes (id, code, code_hash, type, expires_at, max_uses, note, payment_request_id) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    [id, code, hashCode(code), opts.type, opts.expires_at, opts.max_uses ?? null, opts.note ?? null, opts.payment_request_id ?? null],
  )
  return getPasscode(id)!
}

export function getPasscode(id: string): PasscodeRow | null {
  return db().query<PasscodeRow, [string]>(`SELECT * FROM passcodes WHERE id = ?`).get(id) ?? null
}

export function findPasscodeByCode(code: string): PasscodeRow | null {
  const hash = hashCode(code)
  return db().query<PasscodeRow, [string]>(`SELECT * FROM passcodes WHERE code_hash = ?`).get(hash) ?? null
}

export function listPasscodes(): PasscodeRow[] {
  return db().query<PasscodeRow, []>(`SELECT * FROM passcodes ORDER BY created_at DESC`).all()
}

export function incrementPasscodeUse(id: string) {
  db().run(`UPDATE passcodes SET current_uses = current_uses + 1 WHERE id = ?`, [id])
}

export function blockPasscode(id: string) {
  db().run(`UPDATE passcodes SET blocked = 1 WHERE id = ?`, [id])
}

export function unblockPasscode(id: string) {
  db().run(`UPDATE passcodes SET blocked = 0 WHERE id = ?`, [id])
}

export function deletePasscode(id: string) {
  db().run(`DELETE FROM passcodes WHERE id = ?`, [id])
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

export function createCustomer(opts: {
  name?: string
  email?: string
  phone?: string
  reference?: string
  passcode_id?: string
  notes?: string
}): CustomerRow {
  const d = db()
  const id = randomUUID()
  d.run(
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
  return getCustomer(id)!
}

export function getCustomer(id: string): CustomerRow | null {
  return db().query<CustomerRow, [string]>(`SELECT * FROM customers WHERE id = ?`).get(id) ?? null
}

export function findCustomerByEmailOrRef(email?: string, ref?: string): CustomerRow | null {
  const d = db()
  if (email) {
    const byEmail = d.query<CustomerRow, [string]>(`SELECT * FROM customers WHERE email = ?`).get(email)
    if (byEmail) return byEmail
  }
  if (ref) {
    const byRef = d.query<CustomerRow, [string]>(`SELECT * FROM customers WHERE reference = ?`).get(ref)
    if (byRef) return byRef
  }
  return null
}

export function listCustomers(): CustomerRow[] {
  return db().query<CustomerRow, []>(`SELECT * FROM customers ORDER BY created_at DESC`).all()
}

export function linkCustomerPasscode(id: string, passcodeId: string) {
  db().run(`UPDATE customers SET passcode_id = ?, last_payment_at = datetime('now') WHERE id = ?`, [passcodeId, id])
}

export function updateCustomerNotes(id: string, notes: string | null) {
  db().run(`UPDATE customers SET notes = ? WHERE id = ?`, [notes ?? null, id])
}

export function deleteCustomer(id: string) {
  db().run(`DELETE FROM customers WHERE id = ?`, [id])
}

// ─── Installs ─────────────────────────────────────────────────────────

export interface InstallRow {
  id: string
  machine_id: string
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

export function upsertInstall(opts: {
  machine_id: string
  platform: string
  arch: string
  version?: string
  passcode_id?: string
}): InstallRow {
  const d = db()
  const existing = d.query<InstallRow, [string]>(`SELECT * FROM installs WHERE machine_id = ?`).get(opts.machine_id)
  if (existing) {
    d.run(
      `UPDATE installs SET platform = ?, arch = ?, version = ?, passcode_id = ?, last_seen_at = datetime('now') WHERE machine_id = ?`,
      [opts.platform, opts.arch, opts.version ?? existing.version, opts.passcode_id ?? existing.passcode_id, opts.machine_id],
    )
    return d.query<InstallRow, [string]>(`SELECT * FROM installs WHERE machine_id = ?`).get(opts.machine_id)!
  }
  const id = randomUUID()
  d.run(
    `INSERT INTO installs (id, machine_id, platform, arch, version, passcode_id) VALUES (?, ?, ?, ?, ?, ?)`,
    [id, opts.machine_id, opts.platform, opts.arch, opts.version ?? null, opts.passcode_id ?? null],
  )
  return d.query<InstallRow, [string]>(`SELECT * FROM installs WHERE id = ?`).get(id)!
}

export function getInstallByMachine(machineId: string): InstallRow | null {
  return db().query<InstallRow, [string]>(`SELECT * FROM installs WHERE machine_id = ?`).get(machineId) ?? null
}

export function listInstalls(): InstallRow[] {
  return db().query<InstallRow, []>(`SELECT * FROM installs ORDER BY last_seen_at DESC`).all()
}

export function blockInstall(id: string, reason?: string) {
  db().run(`UPDATE installs SET blocked = 1, block_reason = ? WHERE id = ?`, [reason ?? null, id])
}

export function unblockInstall(id: string) {
  db().run(`UPDATE installs SET blocked = 0, block_reason = NULL WHERE id = ?`, [id])
}

export function deleteInstall(id: string) {
  db().run(`DELETE FROM installs WHERE id = ?`, [id])
}

// ─── Usage ────────────────────────────────────────────────────────────

export interface UsageRow {
  id: number
  install_id: string
  period_key: string
  seconds_used: number
}

export function addUsage(installId: string, periodKey: string, seconds: number) {
  const d = db()
  d.run(
    `INSERT INTO usage (install_id, period_key, seconds_used) VALUES (?, ?, ?)
     ON CONFLICT(install_id, period_key) DO UPDATE SET seconds_used = seconds_used + ?`,
    [installId, periodKey, seconds, seconds],
  )
}

export function getUsage(installId: string, periodKey: string): number {
  const row = db().query<{ seconds_used: number }, [string, string]>(
    `SELECT seconds_used FROM usage WHERE install_id = ? AND period_key = ?`,
  ).get(installId, periodKey)
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
// machine_id; repeat calls return the existing trial (so it cannot be restarted).
export function startTrial(opts: {
  machine_id: string
  platform: string
  arch: string
  version?: string
}): TrialResult {
  const d = db()
  let install = d.query<InstallRow, [string]>(`SELECT * FROM installs WHERE machine_id = ?`).get(opts.machine_id)

  if (install?.trial_started_at) {
    return {
      install,
      passcode: install.passcode_id ? getPasscode(install.passcode_id) : null,
      already_started: true,
      trial_expires_at: install.passcode_id ? (getPasscode(install.passcode_id)?.expires_at ?? null) : null,
    }
  }

  if (!install) {
    install = upsertInstall({
      machine_id: opts.machine_id,
      platform: opts.platform,
      arch: opts.arch,
      version: opts.version,
    })
  }
  d.run(`UPDATE installs SET trial_started_at = datetime('now') WHERE id = ?`, [install.id])

  const expires = new Date(Date.now() + TRIAL_DURATION_DAYS * 24 * 60 * 60 * 1000).toISOString()
  const passcode = createPasscode({ type: "public", expires_at: expires, note: "Free 21-day trial" })
  d.run(`UPDATE installs SET passcode_id = ? WHERE id = ?`, [passcode.id, install.id])

  writeAudit("TRIAL_STARTED", opts.machine_id, install.id, { machine_id: opts.machine_id })
  return {
    install: d.query<InstallRow, [string]>(`SELECT * FROM installs WHERE id = ?`).get(install.id)!,
    passcode,
    already_started: false,
    trial_expires_at: expires,
  }
}

// Binds a machine to a validated passcode. Used by the web access page so a
// CLI waiting on /v1/install/status can see the activation take effect.
export function activateInstallByCode(opts: {
  machine_id: string
  platform: string
  arch: string
  version?: string
  passcode_id: string
}): InstallRow {
  const existing = getInstallByMachine(opts.machine_id)
  if (existing) {
    db().run(`UPDATE installs SET passcode_id = ?, platform = ?, arch = ?, version = ?, last_seen_at = datetime('now') WHERE machine_id = ?`, [
      opts.passcode_id,
      opts.platform,
      opts.arch,
      opts.version ?? existing.version,
      opts.machine_id,
    ])
    return getInstallByMachine(opts.machine_id)!
  }
  return upsertInstall({
    machine_id: opts.machine_id,
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
export function listTrials(): TrialListItem[] {
  return db().query<TrialListItem, []>(`
    SELECT i.id AS install_id, i.machine_id, i.platform, i.arch, i.version,
           i.passcode_id, i.trial_started_at, p.expires_at, i.blocked
    FROM installs i
    LEFT JOIN passcodes p ON p.id = i.passcode_id
    WHERE i.trial_started_at IS NOT NULL
    ORDER BY i.trial_started_at DESC
  `).all()
}

// Trials that are within `hoursWindow` hours of expiry (or already expired) and
// have not yet been alerted, so the operator can nudge each user once.
export function listPendingTrialAlerts(hoursWindow: number): TrialListItem[] {
  const limit = new Date(Date.now() + hoursWindow * 60 * 60 * 1000).toISOString()
  return db().query<TrialListItem, [string]>(`
    SELECT i.id AS install_id, i.machine_id, i.platform, i.arch, i.version,
           i.passcode_id, i.trial_started_at, p.expires_at, i.blocked
    FROM installs i
    JOIN passcodes p ON p.id = i.passcode_id
    WHERE i.trial_started_at IS NOT NULL
      AND p.expires_at IS NOT NULL
      AND p.expires_at <= ?
      AND i.machine_id NOT IN (SELECT machine_id FROM trial_alerts)
    ORDER BY p.expires_at ASC
  `).all(limit)
}

export function markTrialAlerted(machineId: string, passcodeId: string | null, expiresAt: string): void {
  db().run(
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

export function findDuplicatePayment(
  reference?: string,
  method?: string,
  amount?: number,
  email?: string,
): PaymentRequestRow | null {
  if (!reference) return null
  const d = db()
  return (
    d
      .query<PaymentRequestRow, [string]>(`SELECT * FROM payment_requests WHERE transaction_reference = ? ORDER BY created_at DESC LIMIT 1`)
      .get(reference) ?? null
  )
}

export function createPaymentRequest(input: PaymentRequestInput): { request: PaymentRequestRow; isDuplicate: boolean } {
  const d = db()
  const duplicate = findDuplicatePayment(input.transactionReference, input.paymentMethod, input.paymentAmount, input.email)
  const id = randomUUID()
  const ref = input.transactionReference ?? null
  const method = (input.paymentMethod ?? "other").trim() || "other"
  d.run(
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
    writeAudit("DUPLICATE_PAYMENT", "system", id, { reference: input.transactionReference })
  }
  return { request: getPaymentRequest(id)!, isDuplicate: !!duplicate }
}

export function getPaymentRequest(id: string): PaymentRequestRow | null {
  return db().query<PaymentRequestRow, [string]>(`SELECT * FROM payment_requests WHERE id = ?`).get(id) ?? null
}

export function listPaymentRequests(): PaymentRequestRow[] {
  return db().query<PaymentRequestRow, []>(`SELECT * FROM payment_requests ORDER BY created_at DESC`).all()
}

export function getPaymentRequestByPasscode(passcodeId: string): PaymentRequestRow | null {
  return db().query<PaymentRequestRow, [string]>(`SELECT * FROM payment_requests WHERE id = (SELECT payment_request_id FROM passcodes WHERE id = ?)`).get(passcodeId) ?? null
}

export function updatePaymentRequestStatus(
  id: string,
  status: PaymentStatus,
  options?: { adminNote?: string; verifiedBy?: string },
) {
  db().run(
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

export function getPaymentStats() {
  const d = db()
  const count = (where: string) => {
    const row = d.query<{ c: number }, []>(`SELECT COUNT(*) AS c FROM payment_requests WHERE ${where}`).get()
    return row?.c ?? 0
  }
  const now = new Date().toISOString()
  return {
    total: count("1 = 1"),
    pending: count("status = 'PENDING'"),
    approved: count("status = 'APPROVED'"),
    rejected: count("status = 'REJECTED'"),
    active_passcodes: d.query<{ c: number }, [string]>(`SELECT COUNT(*) AS c FROM passcodes WHERE blocked = 0 AND expires_at > ?`).get(now)?.c ?? 0,
    expired_passcodes: d.query<{ c: number }, [string]>(`SELECT COUNT(*) AS c FROM passcodes WHERE blocked = 0 AND expires_at <= ?`).get(now)?.c ?? 0,
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

export function writeAudit(action: string, actorId: string, targetId?: string, metadata?: unknown) {
  db().run(
    `INSERT INTO audit_log (id, action, actor_id, target_id, metadata) VALUES (?, ?, ?, ?, ?)`,
    [randomUUID(), action, actorId, targetId ?? null, metadata ? JSON.stringify(metadata) : null],
  )
}

export function listAuditLog(): AuditLogRow[] {
  return db().query<AuditLogRow, []>(`SELECT * FROM audit_log ORDER BY timestamp DESC LIMIT 500`).all()
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
