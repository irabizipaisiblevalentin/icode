import {
  listPasscodes,
  listInstalls,
  listUsers,
  listTrials,
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
  maskCode,
  toCreatedPasscode,
  type PasscodeRow,
  type InstallRow,
  type CustomerRow,
  type PasscodeCreatedView,
  type UserListItem,
  type TrialListItem,
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

export interface AdminPasscodeView {
  id: string
  code_masked: string
  type: "public" | "personal"
  created_at: string
  expires_at: string
  max_uses: number | null
  current_uses: number
  blocked: number
  note: string | null
  payment_request_id: string | null
}

export interface AdminPasscodeListResponse {
  passcodes: AdminPasscodeView[]
}

// The admin list never returns the raw passcode or its hash. The full code is
// shown to the user exactly once, at creation time.
function toAdminPasscode(p: PasscodeRow): AdminPasscodeView {
  return {
    id: p.id,
    code_masked: maskCode(p.code),
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

export async function adminListPasscodes(): Promise<AdminPasscodeListResponse> {
  return { passcodes: (await listPasscodes()).map(toAdminPasscode) }
}

export interface AdminPasscodeCreateRequest {
  type: "public" | "personal"
  expires_at: string
  max_uses?: number
  note?: string
}

export async function adminCreatePasscode(req: AdminPasscodeCreateRequest): Promise<PasscodeCreatedView> {
  return toCreatedPasscode(
    await createPasscode({
      type: req.type,
      expires_at: req.expires_at,
      max_uses: req.max_uses,
      note: req.note,
    }),
  )
}

export interface AdminBlockResponse {
  ok: boolean
  message: string
}

export async function adminBlockPasscode(id: string): Promise<AdminBlockResponse> {
  await blockPasscode(id)
  return { ok: true, message: "Passcode blocked." }
}

export async function adminUnblockPasscode(id: string): Promise<AdminBlockResponse> {
  await unblockPasscode(id)
  return { ok: true, message: "Passcode unblocked." }
}

export async function adminDeletePasscode(id: string): Promise<AdminBlockResponse> {
  await deletePasscode(id)
  return { ok: true, message: "Passcode deleted." }
}

// ─── Install Management ───────────────────────────────────────────────

export interface AdminInstallListResponse {
  installs: InstallRow[]
}

export async function adminListInstalls(): Promise<AdminInstallListResponse> {
  return { installs: await listInstalls() }
}

// ─── User Tracking ───────────────────────────────────────────────────

export interface AdminUserListResponse {
  users: UserListItem[]
}

export async function adminListUsers(): Promise<AdminUserListResponse> {
  return { users: await listUsers() }
}

// ─── Trial Management ─────────────────────────────────────────────────

export interface AdminTrialListResponse {
  trials: TrialListItem[]
}

export async function adminListTrials(): Promise<AdminTrialListResponse> {
  return { trials: await listTrials() }
}

export async function adminBlockInstall(id: string, reason?: string): Promise<AdminBlockResponse> {
  await blockInstall(id, reason)
  return { ok: true, message: "Install blocked." }
}

export async function adminUnblockInstall(id: string): Promise<AdminBlockResponse> {
  await unblockInstall(id)
  return { ok: true, message: "Install unblocked." }
}

export async function adminDeleteInstall(id: string): Promise<AdminBlockResponse> {
  await deleteInstall(id)
  return { ok: true, message: "Install deleted." }
}

// ─── Passcode Generation Helpers ──────────────────────────────────────

export async function adminGeneratePublicCode(weeksValid: number = 3): Promise<PasscodeCreatedView> {
  const expiresAt = new Date(Date.now() + weeksValid * 7 * 24 * 60 * 60 * 1000).toISOString()
  return toCreatedPasscode(await createPublicCode(expiresAt, `Public code - ${weeksValid} weeks`))
}

export async function adminGeneratePersonalCode(daysValid: number = 30): Promise<PasscodeCreatedView> {
  const expiresAt = new Date(Date.now() + daysValid * 24 * 60 * 60 * 1000).toISOString()
  return toCreatedPasscode(await createPersonalCode(expiresAt, undefined, `Personal code - ${daysValid} days`))
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
  passcode: PasscodeCreatedView
  customer: CustomerRow
  renewed: boolean
  message: string
}

/**
 * Confirm a (paid) customer and issue/renew their subscription passcode.
 * If a matching customer already exists (same email or reference), we renew
 * their existing passcode instead of creating a brand-new orphaned one.
 */
export async function adminIssuePasscode(req: IssuePasscodeRequest): Promise<IssuePasscodeResponse> {
  const existing = await findCustomerByEmailOrRef(req.email, req.reference)

  if (existing && existing.passcode_id) {
    const current = await getPasscode(existing.passcode_id)
    const base = current ? new Date(current.expires_at).getTime() : Date.now()
    const from = Math.max(base, Date.now())
    const newExpiry = new Date(from + req.days * 24 * 60 * 60 * 1000)
    const passcode = await createPasscode({
      type: "personal",
      expires_at: newExpiry.toISOString(),
      note: `${req.name ?? "Customer"} (renewed ${req.days} days)`,
    })
    await linkCustomerPasscode(existing.id, passcode.id)
    if (req.name) await updateCustomerNotes(existing.id, req.notes ?? null)
    return { ok: true, passcode: toCreatedPasscode(passcode), customer: existing, renewed: true, message: "Passcode renewed." }
  }

  // New customer → create both
  const passcode = await createPasscode({
    type: "personal",
    expires_at: new Date(Date.now() + req.days * 24 * 60 * 60 * 1000).toISOString(),
    note: `${req.name ?? "Customer"} (${req.days} days)`,
  })
  const customer = await createCustomer({
    name: req.name,
    email: req.email,
    phone: req.phone,
    reference: req.reference,
    passcode_id: passcode.id,
    notes: req.notes,
  })
  return { ok: true, passcode: toCreatedPasscode(passcode), customer, renewed: false, message: "Passcode issued." }
}

// ─── Customers ────────────────────────────────────────────────────────

export interface AdminCustomerListResponse {
  customers: CustomerRow[]
}

export async function adminListCustomers(): Promise<AdminCustomerListResponse> {
  return { customers: await listCustomers() }
}

export async function adminDeleteCustomer(id: string): Promise<AdminBlockResponse> {
  await deleteCustomer(id)
  return { ok: true, message: "Customer deleted." }
}