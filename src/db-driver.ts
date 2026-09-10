// Storage driver abstraction.
//
// Two interchangeable backends behind one async API:
//  - local  : bun:sqlite file database (used in development/offline; data lives
//             in the container and is NOT durable across redeploys).
//  - turso  : @libsql/client remote database (TURSO_URL + TURSO_AUTH_TOKEN set).
//             Turso is a hosted libSQL database, so data survives every Render
//             redeploy. This is the production backend.
//
// The driver is selected once at first use from the environment and cached.

import { Database, type SQLQueryBindings } from "bun:sqlite"
import { mkdirSync } from "fs"
import { join } from "path"
import { createClient, type Client, type Value } from "@libsql/client"

export type SqlValue = string | number | bigint | boolean | null | Uint8Array | ArrayBuffer

export interface SqlDriver {
  run(sql: string, args?: SqlValue[]): Promise<void>
  get<T>(sql: string, args?: SqlValue[]): Promise<T | null>
  all<T>(sql: string, args?: SqlValue[]): Promise<T[]>
}

const TURSO_URL = process.env.TURSO_URL
const TURSO_AUTH_TOKEN = process.env.TURSO_AUTH_TOKEN

const DB_PATH =
  process.env.DB_PATH ?? (process.env.DATA_DIR ? join(process.env.DATA_DIR, "icode-control.db") : "./icode-control.db")

let _driver: SqlDriver | null = null

export function backendName(): "turso" | "local" {
  return TURSO_URL ? "turso" : "local"
}

export function getDriver(): SqlDriver {
  if (!_driver) _driver = TURSO_URL ? createTursoDriver() : createLocalDriver()
  return _driver
}

// bun:sqlite is synchronous by nature; wrapping it in async keeps the call
// sites uniform (they all return Promises), so switching backends needs no
// other code changes.
function createLocalDriver(): SqlDriver {
  if (DB_PATH !== ":memory:") {
    const parent = DB_PATH.includes("/") ? DB_PATH.slice(0, DB_PATH.lastIndexOf("/")) : "."
    if (parent && parent !== ".") mkdirSync(parent, { recursive: true })
  }
  const d = new Database(DB_PATH)
  d.run("PRAGMA journal_mode = WAL")
  d.run("PRAGMA busy_timeout = 5000")

  return {
    async run(sql: string, args: SqlValue[] = []): Promise<void> {
      d.run(sql, ...(args as unknown as SQLQueryBindings[] as any[]))
    },
    async get<T>(sql: string, args: SqlValue[] = []): Promise<T | null> {
      const row = d.query(sql).get(...(args as unknown as SQLQueryBindings[] as any[]))
      return (row as T | undefined) ?? null
    },
    async all<T>(sql: string, args: SqlValue[] = []): Promise<T[]> {
      return d.query(sql).all(...(args as unknown as SQLQueryBindings[] as any[])) as T[]
    },
  }
}

function createTursoDriver(): SqlDriver {
  const client: Client = createClient({ url: TURSO_URL!, authToken: TURSO_AUTH_TOKEN ?? undefined })
  return {
    async run(sql: string, args: SqlValue[] = []): Promise<void> {
      await client.execute({ sql, args: args as Value[] })
    },
    async get<T>(sql: string, args: SqlValue[] = []): Promise<T | null> {
      const result = await client.execute({ sql, args: args as Value[] })
      return (result.rows[0] as T | undefined) ?? null
    },
    async all<T>(sql: string, args: SqlValue[] = []): Promise<T[]> {
      const result = await client.execute({ sql, args: args as Value[] })
      return result.rows as T[]
    },
  }
}