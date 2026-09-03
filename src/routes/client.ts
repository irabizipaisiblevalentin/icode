import {
  createPasscode,
  findPasscodeByCode,
  getPasscode,
  incrementPasscodeUse,
  upsertInstall,
  getInstallByMachine,
  activateInstallByCode,
  startTrial,
  addUsage,
} from "../db"
import { hitRateLimit } from "../rate-limit"

// ─── Client API ───────────────────────────────────────────────────────

export interface ValidateRequest {
  code: string
  machine_id: string
  platform: string
  arch: string
  version?: string
}

export interface ValidateResponse {
  ok: boolean
  reason?: string
  message: string
  passcode_id?: string
  expires_at?: string
  type?: "public" | "personal"
  remaining_seconds?: number
  quota_seconds?: number
  rate_limited?: boolean
  retry_after_seconds?: number
}

export function validate(req: ValidateRequest): ValidateResponse {
  const limiter = hitRateLimit(`validate:${req.machine_id}`, 10, 60_000)
  if (!limiter.allowed) {
    return {
      ok: false,
      reason: "rate_limited",
      rate_limited: true,
      retry_after_seconds: limiter.retryAfterSeconds,
      message: "Ugerageje kenshi. Gerageza nyuma y'akanya kato.",
    }
  }
  const passcode = findPasscodeByCode(req.code)
  if (!passcode) {
    return { ok: false, reason: "not_found", message: "Passcode ntabwo iboneka." }
  }
  if (passcode.blocked) {
    return { ok: false, reason: "blocked", message: "Iyi passcode yarahagaritswe." }
  }
  if (new Date(passcode.expires_at) < new Date()) {
    return { ok: false, reason: "expired", message: "Iyi passcode yarashize." }
  }
  if (passcode.max_uses !== null && passcode.current_uses >= passcode.max_uses) {
    return { ok: false, reason: "max_uses", message: "Iyi passcode yageze ku mubare wayo ntarengwa w'ukuyikoresha." }
  }

  incrementPasscodeUse(passcode.id)
  upsertInstall({
    machine_id: req.machine_id,
    platform: req.platform,
    arch: req.arch,
    version: req.version,
    passcode_id: passcode.id,
  })

  return {
    ok: true,
    message: "Passcode yakiriwe.",
    passcode_id: passcode.id,
    expires_at: passcode.expires_at,
    type: passcode.type,
  }
}

export interface HeartbeatRequest {
  machine_id: string
  seconds_active: number
}

export interface HeartbeatResponse {
  ok: boolean
  blocked?: boolean
  message?: string
  remaining_seconds?: number
  warn?: boolean
}

export function heartbeat(req: HeartbeatRequest): HeartbeatResponse {
  const install = getInstallByMachine(req.machine_id)
  if (!install) {
    return { ok: false, message: "Install not registered." }
  }
  if (install.blocked) {
    return { ok: false, blocked: true, message: "This installation has been blocked." }
  }

  const now = new Date()
  const periodKey = `${now.getUTCFullYear()}-${String(now.getUTCMonth() + 1).padStart(2, "0")}`
  addUsage(install.id, periodKey, req.seconds_active)

  return {
    ok: true,
    blocked: false,
  }
}

export interface StatusRequest {
  machine_id: string
}

export interface StatusResponse {
  ok: boolean
  blocked?: boolean
  passcode_valid?: boolean
  passcode_blocked?: boolean
  passcode_expired?: boolean
  expires_at?: string
  type?: string
  remaining_seconds?: number
  message?: string
}

export function status(req: StatusRequest): StatusResponse {
  const install = getInstallByMachine(req.machine_id)
  if (!install) {
    return { ok: false, message: "Uyu muyoboro ntwarandikishwa." }
  }
  if (install.blocked) {
    return { ok: false, blocked: true, message: "Uyu muyoboro (installation) warahagaritswe." }
  }

  const passcode = install.passcode_id ? getPasscode(install.passcode_id) : null
  if (!passcode) {
    return { ok: false, passcode_valid: false, message: "Nta passcode ihujwe n'uyu muyoboro." }
  }

  const now = new Date()
  const blockReason =
    passcode.blocked ? "Passcode yawe yarahagaritswe."
    : new Date(passcode.expires_at) < now ? "Passcode yawe yarashize."
    : null
  if (blockReason) {
    return {
      ok: false,
      passcode_valid: true,
      passcode_blocked: !!passcode.blocked,
      passcode_expired: new Date(passcode.expires_at) < now,
      message: blockReason,
    }
  }

  return {
    ok: true,
    passcode_valid: true,
    expires_at: passcode.expires_at,
    type: passcode.type,
    message: "OK",
  }
}

// ─── Trial ────────────────────────────────────────────────────────────

export interface TrialRequest {
  machine_id: string
  platform: string
  arch: string
  version?: string
}

export interface TrialResponse {
  ok: boolean
  trial_active: boolean
  trial_expired: boolean
  already_started: boolean
  expires_at: string | null
  message: string
}

// Grants or reports a one-time free trial for a machine.
export function trial(req: TrialRequest): TrialResponse {
  const result = startTrial({
    machine_id: req.machine_id,
    platform: req.platform,
    arch: req.arch,
    version: req.version,
  })
  const expiresAt = result.trial_expires_at
  const active = !!expiresAt && new Date(expiresAt) > new Date()

  return {
    ok: true,
    trial_active: active,
    trial_expired: !!expiresAt && !active,
    already_started: result.already_started,
    expires_at: expiresAt,
    message: active
      ? "Trial yakomeje."
      : "Trial yarashize. Nyamuneka wizihishe kugira ngo ukomeze gukoresha iCode.",
  }
}

// ─── Activate (web page binds a machine to a validated passcode) ─────

export interface ActivateRequest {
  machine_id: string
  platform: string
  arch: string
  version?: string
  code: string
}

export interface ActivateResponse {
  ok: boolean
  reason?: string
  message: string
  passcode_id?: string
  expires_at?: string
  type?: "public" | "personal"
}

export function activateByCode(req: ActivateRequest): ActivateResponse {
  const code = (req.code ?? "").trim().toUpperCase()
  if (!code) return { ok: false, reason: "invalid", message: "Passcode ntigomba kuba ubusa." }
  if (!req.machine_id) return { ok: false, reason: "invalid", message: "machine_id ntibonetse." }

  const passcode = findPasscodeByCode(code)
  if (!passcode) return { ok: false, reason: "not_found", message: "Passcode ntabwo iboneka." }
  if (passcode.blocked) return { ok: false, reason: "blocked", message: "Iyi passcode yarahagaritswe." }
  if (new Date(passcode.expires_at) < new Date()) return { ok: false, reason: "expired", message: "Iyi passcode yarashize." }
  if (passcode.max_uses !== null && passcode.current_uses >= passcode.max_uses) {
    return { ok: false, reason: "max_uses", message: "Iyi passcode yageze ku mubare ntarengwa w'ukuyikoresha." }
  }

  incrementPasscodeUse(passcode.id)
  activateInstallByCode({
    machine_id: req.machine_id,
    platform: req.platform,
    arch: req.arch,
    version: req.version,
    passcode_id: passcode.id,
  })

  return {
    ok: true,
    message: "Passcode yakiriwe. Ubu ushobora gusubira muri terminal.",
    passcode_id: passcode.id,
    expires_at: passcode.expires_at,
    type: passcode.type,
  }
}

// ─── Passcode Creation ────────────────────────────────────────────────

export function createPublicCode(expiresAt: string, note?: string) {
  return createPasscode({
    type: "public",
    expires_at: expiresAt,
    note: note ?? "Free public passcode",
  })
}

export function createPersonalCode(expiresAt: string, maxUses?: number, note?: string) {
  return createPasscode({
    type: "personal",
    expires_at: expiresAt,
    max_uses: maxUses,
    note: note,
  })
}
