import {
  listPasscodes,
  listInstalls,
  blockPasscode,
  unblockPasscode,
  deletePasscode,
  blockInstall,
  unblockInstall,
  deleteInstall,
  createPasscode,
  getPasscode,
  createCustomer,
  findCustomerByEmailOrRef,
  linkCustomerPasscode,
  listCustomers,
  updateCustomerNotes,
  deleteCustomer,
  type PasscodeRow,
  type InstallRow,
  type CustomerRow,
} from "../db"
import { createPublicCode, createPersonalCode } from "./client"

// ─── Admin Auth ───────────────────────────────────────────────────────

const ADMIN_TOKEN = process.env.ADMIN_TOKEN ?? "icode-admin-secret"

export function isAdminAuth(request: Request): boolean {
  const auth = request.headers.get("authorization")
  if (!auth) return false
  return auth === `Bearer ${ADMIN_TOKEN}`
}

// ─── Passcode Management ──────────────────────────────────────────────

export interface AdminPasscodeListResponse {
  passcodes: PasscodeRow[]
}

export function adminListPasscodes(): AdminPasscodeListResponse {
  return { passcodes: listPasscodes() }
}

export interface AdminPasscodeCreateRequest {
  type: "public" | "personal"
  expires_at: string
  max_uses?: number
  note?: string
}

export function adminCreatePasscode(req: AdminPasscodeCreateRequest): PasscodeRow {
  return createPasscode({
    type: req.type,
    expires_at: req.expires_at,
    max_uses: req.max_uses,
    note: req.note,
  })
}

export interface AdminBlockResponse {
  ok: boolean
  message: string
}

export function adminBlockPasscode(id: string): AdminBlockResponse {
  blockPasscode(id)
  return { ok: true, message: "Passcode blocked." }
}

export function adminUnblockPasscode(id: string): AdminBlockResponse {
  unblockPasscode(id)
  return { ok: true, message: "Passcode unblocked." }
}

export function adminDeletePasscode(id: string): AdminBlockResponse {
  deletePasscode(id)
  return { ok: true, message: "Passcode deleted." }
}

// ─── Install Management ───────────────────────────────────────────────

export interface AdminInstallListResponse {
  installs: InstallRow[]
}

export function adminListInstalls(): AdminInstallListResponse {
  return { installs: listInstalls() }
}

export function adminBlockInstall(id: string, reason?: string): AdminBlockResponse {
  blockInstall(id, reason)
  return { ok: true, message: "Install blocked." }
}

export function adminUnblockInstall(id: string): AdminBlockResponse {
  unblockInstall(id)
  return { ok: true, message: "Install unblocked." }
}

export function adminDeleteInstall(id: string): AdminBlockResponse {
  deleteInstall(id)
  return { ok: true, message: "Install deleted." }
}

// ─── Passcode Generation Helpers ──────────────────────────────────────

export function adminGeneratePublicCode(weeksValid: number = 3): PasscodeRow {
  const expiresAt = new Date(Date.now() + weeksValid * 7 * 24 * 60 * 60 * 1000).toISOString()
  return createPublicCode(expiresAt, `Public code - ${weeksValid} weeks`)
}

export function adminGeneratePersonalCode(daysValid: number = 30): PasscodeRow {
  const expiresAt = new Date(Date.now() + daysValid * 24 * 60 * 60 * 1000).toISOString()
  return createPersonalCode(expiresAt, undefined, `Personal code - ${daysValid} days`)
}

// ─── Customer Passcode Issuance ───────────────────────────────────────

export interface IssuePasscodeRequest {
  name?: string
  email?: string
  phone?: string
  reference?: string
  notes?: string
  days: number
}

export interface IssuePasscodeResponse {
  ok: boolean
  passcode: PasscodeRow
  customer: CustomerRow
  renewed: boolean
  message: string
}

/**
 * Confirm a (paid) customer and issue/renew their subscription passcode.
 * If a matching customer already exists (same email or reference), we renew
 * their existing passcode instead of creating a brand-new orphaned one.
 */
export function adminIssuePasscode(req: IssuePasscodeRequest): IssuePasscodeResponse {
  const existing = findCustomerByEmailOrRef(req.email, req.reference)

  if (existing && existing.passcode_id) {
    const current = getPasscode(existing.passcode_id)
    const base = current ? new Date(current.expires_at).getTime() : Date.now()
    const from = Math.max(base, Date.now())
    const newExpiry = new Date(from + req.days * 24 * 60 * 60 * 1000)
    const passcode = createPasscode({
      type: "personal",
      expires_at: newExpiry.toISOString(),
      note: `${req.name ?? "Customer"} (renewed ${req.days} days)`,
    })
    linkCustomerPasscode(existing.id, passcode.id)
    if (req.name) updateCustomerNotes(existing.id, req.notes ?? null)
    return { ok: true, passcode, customer: existing, renewed: true, message: "Passcode renewed." }
  }

  // New customer → create both
  const passcode = createPasscode({
    type: "personal",
    expires_at: new Date(Date.now() + req.days * 24 * 60 * 60 * 1000).toISOString(),
    note: `${req.name ?? "Customer"} (${req.days} days)`,
  })
  const customer = createCustomer({
    name: req.name,
    email: req.email,
    phone: req.phone,
    reference: req.reference,
    passcode_id: passcode.id,
    notes: req.notes,
  })
  return { ok: true, passcode, customer, renewed: false, message: "Passcode issued." }
}

// ─── Customers ────────────────────────────────────────────────────────

export interface AdminCustomerListResponse {
  customers: CustomerRow[]
}

export function adminListCustomers(): AdminCustomerListResponse {
  return { customers: listCustomers() }
}

export function adminDeleteCustomer(id: string): AdminBlockResponse {
  deleteCustomer(id)
  return { ok: true, message: "Customer deleted." }
}
