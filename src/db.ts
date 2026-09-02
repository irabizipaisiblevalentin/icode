import { Database } from "bun:sqlite"
import { randomUUID } from "crypto"
import { mkdirSync } from "fs"
import { join } from "path"

const DB_PATH = process.env.DB_PATH ?? (process.env.DATA_DIR ? join(process.env.DATA_DIR, "icode-control.db") : "./icode-control.db")

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
      type TEXT NOT NULL CHECK(type IN ('public','personal')),
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      expires_at TEXT NOT NULL,
      max_uses INTEGER,
      current_uses INTEGER NOT NULL DEFAULT 0,
      blocked INTEGER NOT NULL DEFAULT 0,
      note TEXT
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
  db.run(`CREATE INDEX IF NOT EXISTS idx_passcodes_code ON passcodes(code)`)
  db.run(`CREATE INDEX IF NOT EXISTS idx_installs_machine ON installs(machine_id)`)
}

// ─── Passcodes ────────────────────────────────────────────────────────

export interface PasscodeRow {
  id: string
  code: string
  type: "public" | "personal"
  created_at: string
  expires_at: string
  max_uses: number | null
  current_uses: number
  blocked: number
  note: string | null
}

export function createPasscode(opts: {
  type: "public" | "personal"
  expires_at: string
  max_uses?: number | null
  code?: string
  note?: string
}): PasscodeRow {
  const d = db()
  const id = randomUUID()
  const code = opts.code ?? randomCode()
  d.run(
    `INSERT INTO passcodes (id, code, type, expires_at, max_uses, note) VALUES (?, ?, ?, ?, ?, ?)`,
    [id, code, opts.type, opts.expires_at, opts.max_uses ?? null, opts.note ?? null],
  )
  return getPasscode(id)!
}

export function getPasscode(id: string): PasscodeRow | null {
  return db().query<PasscodeRow, [string]>(`SELECT * FROM passcodes WHERE id = ?`).get(id) ?? null
}

export function findPasscodeByCode(code: string): PasscodeRow | null {
  return db().query<PasscodeRow, [string]>(`SELECT * FROM passcodes WHERE code = ?`).get(code) ?? null
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

// ─── Helpers ──────────────────────────────────────────────────────────

function randomCode(): string {
  const chars = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789"
  let code = ""
  for (let i = 0; i < 12; i++) {
    code += chars[Math.floor(Math.random() * chars.length)]
    if (i === 3 || i === 7) code += "-"
  }
  return code
}
