#!/usr/bin/env bun
// iCode control admin CLI
// Usage:
//   bun run src/script/admin.ts generate-public [weeks]
//   bun run src/script/admin.ts generate-personal [days]
//   bun run src/script/admin.ts list
//   bun run src/script/admin.ts block-passcode <id>
//   bun run src/script/admin.ts unblock-passcode <id>
//   bun run src/script/admin.ts block-install <machine-id>
//   bun run src/script/admin.ts unblock-install <machine-id>
//   bun run src/script/admin.ts installs
//   bun run src/script/admin.ts issue --name="X" --email="x@y.com" --days=30 [--ref=ORDER123] [--phone=0788] [--notes=...]
//   bun run src/script/admin.ts customers

const BASE = process.env.CONTROL_URL ?? "http://localhost:4097"
const TOKEN = process.env.ADMIN_TOKEN ?? "icode-admin-secret"

async function api(path: string, init?: RequestInit): Promise<unknown> {
  const response = await fetch(`${BASE}${path}`, {
    ...init,
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${TOKEN}`, ...init?.headers },
  })
  if (!response.ok) {
    console.error(`HTTP ${response.status}: ${await response.text()}`)
    process.exit(1)
  }
  return response.json()
}

const [cmd, ...rest] = process.argv.slice(2)

switch (cmd) {
  case "generate-public": {
    const weeks = Number(rest[0] ?? 3)
    const p = await api("/v1/admin/passcodes/generate", { method: "POST", body: JSON.stringify({ type: "public", weeks }) })
    console.log(`Public passcode (${weeks} weeks): ${(p as any).code}`)
    break
  }
  case "generate-personal": {
    const days = Number(rest[0] ?? 30)
    const p = await api("/v1/admin/passcodes/generate", { method: "POST", body: JSON.stringify({ type: "personal", days }) })
    console.log(`Personal passcode (${days} days): ${(p as any).code}`)
    break
  }
  case "list": {
    const data = await api("/v1/admin/passcodes") as { passcodes: any[] }
    console.table(data.passcodes.map((p) => ({ code: p.code_masked, type: p.type, blocked: !!p.blocked, uses: `${p.current_uses}${p.max_uses ? "/" + p.max_uses : ""}`, expires: p.expires_at })))
    break
  }
  case "installs": {
    const data = await api("/v1/admin/installs") as { installs: any[] }
    console.table(data.installs.map((i) => ({ machine: i.machine_id.slice(0, 8), platform: i.platform, blocked: !!i.blocked, last_seen: i.last_seen_at })))
    break
  }
  case "block-passcode":
  case "unblock-passcode": {
    const id = rest[0]
    if (!id) { console.error("Missing passcode id"); process.exit(1) }
    const blocked = cmd === "block-passcode"
    const r = await api(`/v1/admin/passcodes/${id}`, { method: "PATCH", body: JSON.stringify({ blocked }) })
    console.log((r as any).message)
    break
  }
  case "block-install":
  case "unblock-install": {
    const id = rest[0]
    if (!id) { console.error("Missing machine id"); process.exit(1) }
    const blocked = cmd === "block-install"
    const r = await api(`/v1/admin/installs/${id}`, { method: "PATCH", body: JSON.stringify({ blocked }) })
    console.log((r as any).message)
    break
  }
  case "issue": {
    const arg = (key: string) => {
      const prefix = `--${key}=`
      const hit = process.argv.find((a) => a.startsWith(prefix))
      return hit ? hit.slice(prefix.length) : undefined
    }
    const days = Number(arg("days") ?? 30)
    const body = {
      name: arg("name"),
      email: arg("email"),
      phone: arg("phone"),
      reference: arg("ref"),
      notes: arg("notes"),
      days,
    }
    if (!body.email && !body.reference) {
      console.error("Provide at least --email or --ref so the customer can be matched for renewal.")
      process.exit(1)
    }
    const r = await api("/v1/admin/passcodes/issue", { method: "POST", body: JSON.stringify(body) }) as any
    console.log(`${r.message} ${r.renewed ? "(renewed)" : "(new)"}`)
    console.log(`Passcode: ${r.passcode.code}`)
    console.log(`Expires:  ${r.passcode.expires_at}`)
    console.log(`Customer: ${r.customer.name ?? "(no name)"} <${r.customer.email ?? ""}>`)
    break
  }
  case "customers": {
    const data = await api("/v1/admin/customers") as { customers: any[] }
    console.table(data.customers.map((c) => ({ name: c.name, email: c.email, ref: c.reference, expires: c.passcode_id ? "linked" : "none", last_payment: c.last_payment_at })))
    break
  }
  default:
    console.log(`Unknown command: ${cmd}`)
    process.exit(1)
}

export {}
