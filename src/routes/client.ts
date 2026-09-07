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
      message: "Too many attempts. Please try again in a moment.",
    }
  }
  const passcode = findPasscodeByCode(req.code)
  if (!passcode) {
    return { ok: false, reason: "not_found", message: "That Passcode does not exist. Check the Passcode you were given and try again." }
  }
  if (passcode.blocked) {
    return { ok: false, reason: "blocked", message: "Your access to iCode with this Passcode has been revoked. Please contact the iCode admin." }
  }
  if (new Date(passcode.expires_at) < new Date()) {
    return { ok: false, reason: "expired", message: "Your Passcode has expired. Pay 1,000 RWF and fill in the Google Form to get a new Passcode." }
  }
  if (passcode.max_uses !== null && passcode.current_uses >= passcode.max_uses) {
    return { ok: false, reason: "max_uses", message: "This Passcode has reached its maximum allowed uses." }
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
    message: "Passcode accepted.",
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
    return { ok: false, message: "This device is not registered." }
  }
  if (install.blocked) {
    return { ok: false, blocked: true, message: "Your access to iCode has been revoked." }
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
  access_revoked?: boolean
  expires_at?: string
  type?: string
  remaining_seconds?: number
  message?: string
}

export function status(req: StatusRequest): StatusResponse {
  const install = getInstallByMachine(req.machine_id)
  if (!install) {
    return { ok: false, message: "This device is not registered." }
  }
  if (install.blocked) {
    return { ok: false, blocked: true, access_revoked: true, message: "Your access to iCode has been revoked. Please contact the iCode admin." }
  }

  const passcode = install.passcode_id ? getPasscode(install.passcode_id) : null
  if (!passcode) {
    return { ok: false, passcode_valid: false, message: "No passcode is linked to this device." }
  }

  const now = new Date()
  const blockReason =
    passcode.blocked ? "Your access to iCode has been revoked. Please contact the iCode admin."
    : new Date(passcode.expires_at) < now ? "Your trial has ended. To keep using iCode you must pay 1,000 RWF and get a Passcode."
    : null
  if (blockReason) {
    return {
      ok: false,
      passcode_valid: true,
      passcode_blocked: !!passcode.blocked,
      passcode_expired: new Date(passcode.expires_at) < now,
      access_revoked: !!passcode.blocked,
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
  remaining_days?: number
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
  const remainingMs = active && expiresAt ? new Date(expiresAt).getTime() - Date.now() : 0
  const remainingDays = Math.max(0, Math.ceil(remainingMs / (1000 * 60 * 60 * 24)))

  return {
    ok: true,
    trial_active: active,
    trial_expired: !!expiresAt && !active,
    already_started: result.already_started,
    expires_at: expiresAt,
    remaining_days: active ? remainingDays : 0,
    message: active
      ? "Trial is active."
      : "Your trial has ended. Please pay to continue using iCode.",
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
  if (!code) return { ok: false, reason: "invalid", message: "Passcode must not be empty." }
  if (!req.machine_id) return { ok: false, reason: "invalid", message: "machine_id is missing." }

  const passcode = findPasscodeByCode(code)
  if (!passcode) return { ok: false, reason: "not_found", message: "That Passcode does not exist." }
  if (passcode.blocked) return { ok: false, reason: "blocked", message: "This Passcode has been revoked." }
  if (new Date(passcode.expires_at) < new Date()) return { ok: false, reason: "expired", message: "This Passcode has expired." }
  if (passcode.max_uses !== null && passcode.current_uses >= passcode.max_uses) {
    return { ok: false, reason: "max_uses", message: "This Passcode has reached its maximum allowed uses." }
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
    message: "Passcode accepted. You can now return to the terminal.",
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
