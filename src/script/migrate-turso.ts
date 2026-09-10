#!/usr/bin/env bun
// One-off migration: copy every row from a local iCode Control SQLite database
// into the Turso-hosted database, preserving IDs and timestamps. Idempotent
// (each row is INSERT OR IGNORE by primary key), so re-running after a partial
// copy is safe.
//
//   SRC_DB=/path/to/icode-control.db \
//   TURSO_URL=libsql://<db>.turso.io \
//   TURSO_AUTH_TOKEN=<token> \
//   bun run src/script/migrate-turso.ts
import { Database } from "bun:sqlite"
import { getDriver } from "../db-driver"
import { ensureSchema } from "../db"

if (!process.env.TURSO_URL) {
  console.error("TURSO_URL is required (e.g. libsql://<db>.turso.io)")
  process.exit(1)
}

const SRC_DB = process.env.SRC_DB ?? "./data/icode-control.db"

const TABLES = ["passcodes", "customers", "installs", "usage", "trial_alerts", "payment_requests", "audit_log"]

// Read-only handle on the source data; the remote connection comes from the
// standard driver (selected automatically because TURSO_URL is set).
const local = new Database(SRC_DB, { readonly: true })
const remote = getDriver()

await ensureSchema(remote)
console.log(`Schema ready on ${process.env.TURSO_URL}`)

let totalCopied = 0
for (const table of TABLES) {
  const exists = local.query<{ n: number }, [string]>(`SELECT COUNT(*) AS n FROM sqlite_master WHERE type = 'table' AND name = ?`).get(table)?.n ?? 0
  if (!exists) {
    console.log(`  ${table}: table not present in source, skipped`)
    continue
  }
  const rows = local.query<Record<string, unknown>, []>(`SELECT * FROM ${table}`).all()
  if (rows.length === 0) continue
  const cols = Object.keys(rows[0])
  const placeholders = cols.map(() => "?").join(", ")
  const sql = `INSERT OR IGNORE INTO ${table} (${cols.join(", ")}) VALUES (${placeholders})`
  for (const row of rows) {
    const args = cols.map((c) => (row[c] ?? null) as never)
    await remote.run(sql, args)
  }
  totalCopied += rows.length
  console.log(`  ${table}: ${rows.length} row(s) copied`)
}

console.log(`Done. ${totalCopied} row(s) total copied into Turso.`)
process.exit(0)