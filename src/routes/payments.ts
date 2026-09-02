import {
  createPaymentRequest,
  getPaymentRequest,
  listPaymentRequests,
  updatePaymentRequestStatus,
  getPaymentStats,
  listAuditLog,
  createPasscode,
  linkCustomerPasscode,
  getCustomer,
  writeAudit,
  findCustomerByEmailOrRef,
  createCustomer,
  getPasscode,
  blockPasscode,
  unblockPasscode,
  ACCESS_DURATION_DAYS,
  PAYMENT_AMOUNT_RWF,
  randomAccessCode,
  type PaymentRequestRow,
  type PasscodeRow,
  type CustomerRow,
} from "../db"

// ─── Webhook: receive an external form submission ─────────────────────

export interface WebhookFormInput {
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

export interface WebhookFormResponse {
  ok: boolean
  id?: string
  isDuplicate?: boolean
  error?: string
}

export function handleFormWebhook(body: WebhookFormInput): WebhookFormResponse {
  const errors = validateWebhookInput(body)
  if (errors.length > 0) {
    return { ok: false, error: errors.join("; ") }
  }
  const { request, isDuplicate } = createPaymentRequest({
    fullName: body.fullName,
    email: body.email,
    phoneNumber: body.phoneNumber,
    paymentMethod: body.paymentMethod,
    transactionReference: body.transactionReference,
    paymentAmount: body.paymentAmount,
    paymentDate: body.paymentDate,
    paymentTime: body.paymentTime,
    paymentProof: body.paymentProof,
  })
  writeAudit("PAYMENT_SUBMITTED", "system", request.id, { method: body.paymentMethod })
  return { ok: true, id: request.id, isDuplicate }
}

function validateWebhookInput(input: WebhookFormInput): string[] {
  const errors: string[] = []
  if (!input.fullName || !input.fullName.trim()) errors.push("fullName is required")
  if (input.email && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(input.email)) errors.push("email is invalid")
  if (input.phoneNumber && !/^[+0-9][0-9\s\-()]{6,}$/.test(input.phoneNumber.trim())) errors.push("phoneNumber is invalid")
  const allowedMethods = ["MTN_MOMO", "BK_BANK", "momo", "bank", "other"]
  if (input.paymentMethod && !allowedMethods.includes(input.paymentMethod)) errors.push("paymentMethod is not allowed")
  if (input.paymentAmount !== undefined && input.paymentAmount !== null && Number(input.paymentAmount) !== PAYMENT_AMOUNT_RWF) {
    errors.push(`paymentAmount must equal ${PAYMENT_AMOUNT_RWF}`)
  }
  if (!input.transactionReference || !input.transactionReference.trim()) errors.push("transactionReference is required")
  return errors
}

// ─── Admin: payment request management ────────────────────────────────

export interface ApproveRequest {
  adminNote?: string
  days?: number
  verifiedBy?: string
}

export interface ApproveResponse {
  ok: boolean
  error?: string
  messages?: string[]
  passcode?: string
  expiresAt?: string
  request?: PaymentRequestRow
}

export function adminApprovePaymentRequest(id: string, req: ApproveRequest): ApproveResponse {
  const request = getPaymentRequest(id)
  if (!request) return { ok: false, error: "Payment request not found." }
  if (request.status !== "PENDING") return { ok: false, error: "Only pending payment requests can be approved." }
  if (request.is_duplicate) {
    return { ok: false, error: "Possible duplicate payment. This transaction reference has already been submitted." }
  }

  const actor = req.verifiedBy ?? "admin"
  const days = req.days ?? ACCESS_DURATION_DAYS
  const expiresAt = new Date(Date.now() + days * 24 * 60 * 60 * 1000).toISOString()

  const code = randomAccessCode()
  const passcode = createPasscode({
    type: "personal",
    expires_at: expiresAt,
    code,
    note: `${request.full_name} (${days} days) - ${request.transaction_reference ?? ""}`.trim(),
    payment_request_id: request.id,
  })

  const existing = findCustomerByEmailOrRef(request.email ?? undefined, request.transaction_reference ?? undefined)
  let customer: CustomerRow
  if (existing) {
    linkCustomerPasscode(existing.id, passcode.id)
    customer = existing
  } else {
    customer = createCustomer({
      name: request.full_name,
      email: request.email ?? undefined,
      phone: request.phone_number ?? undefined,
      reference: request.transaction_reference ?? undefined,
      passcode_id: passcode.id,
      notes: request.admin_note ?? undefined,
    })
  }

  updatePaymentRequestStatus(id, "APPROVED", { adminNote: req.adminNote, verifiedBy: actor })
  writeAudit("PAYMENT_APPROVED", actor, request.id, { reference: request.transaction_reference })
  writeAudit("PASSCODE_CREATED", actor, passcode.id, { paymentRequestId: id })
  writeAudit("ACCESS_GRANTED", actor, passcode.id, { expiry: expiresAt })

  return {
    ok: true,
    passcode: passcode.code,
    expiresAt,
    request: getPaymentRequest(id)!,
  }
}

export function adminRejectPaymentRequest(id: string, adminNote?: string, actor?: string): { ok: boolean; error?: string } {
  const request = getPaymentRequest(id)
  if (!request) return { ok: false, error: "Payment request not found." }
  if (request.status !== "PENDING") return { ok: false, error: "Only pending payment requests can be rejected." }
  updatePaymentRequestStatus(id, "REJECTED", { adminNote, verifiedBy: actor ?? "admin" })
  writeAudit("PAYMENT_REJECTED", actor ?? "admin", request.id, { note: adminNote })
  return { ok: true }
}

// ─── Admin: passcode revoke/reactivate ────────────────────────────────

export function adminRevokePasscode(passcodeId: string, actor?: string): { ok: boolean; error?: string } {
  const passcode = getPasscode(passcodeId)
  if (!passcode) return { ok: false, error: "Passcode not found." }
  blockPasscode(passcodeId)
  writeAudit("PASSCODE_REVOKED", actor ?? "admin", passcodeId, {})
  return { ok: true }
}

export function adminReactivatePasscode(passcodeId: string, actor?: string): { ok: boolean; error?: string } {
  const passcode = getPasscode(passcodeId)
  if (!passcode) return { ok: false, error: "Passcode not found." }
  unblockPasscode(passcodeId)
  writeAudit("PASSCODE_REACTIVATED", actor ?? "admin", passcodeId, {})
  return { ok: true }
}
