import { validate, heartbeat, status, type ValidateRequest, type HeartbeatRequest, type StatusRequest } from "./routes/client"
import {
  isAdminAuth,
  adminListPasscodes,
  adminListInstalls,
  adminBlockPasscode,
  adminUnblockPasscode,
  adminDeletePasscode,
  adminBlockInstall,
  adminUnblockInstall,
  adminDeleteInstall,
  adminGeneratePublicCode,
  adminGeneratePersonalCode,
  adminCreatePasscode,
  adminIssuePasscode,
  adminListCustomers,
  adminDeleteCustomer,
  type AdminPasscodeCreateRequest,
  type IssuePasscodeRequest,
} from "./routes/admin"
import {
  handleFormWebhook,
  adminApprovePaymentRequest,
  adminRejectPaymentRequest,
  adminRevokePasscode,
  adminReactivatePasscode,
  type WebhookFormInput,
  type ApproveRequest,
} from "./routes/payments"
import { listPaymentRequests, getPaymentRequest, getPaymentStats, listAuditLog, isValidWebhook } from "./db"
import { hitRateLimit } from "./rate-limit"

const PORT = parseInt(process.env.PORT ?? "4097")
const DASHBOARD_PATH = new URL("../public/index.html", import.meta.url).pathname

function corsHeaders(): HeadersInit {
  return {
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Methods": "GET, POST, PATCH, DELETE, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type, Authorization, x-webhook-token",
  }
}

function json(data: unknown, status: number = 200): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "Content-Type": "application/json", ...corsHeaders() },
  })
}

function parseBody<T>(request: Request): Promise<T> {
  return request.json() as Promise<T>
}

// ─── Server ───────────────────────────────────────────────────────────

const server = Bun.serve({
  port: PORT,
  async fetch(request) {
    const url = new URL(request.url)
    const path = url.pathname
    const method = request.method

    // CORS preflight
    if (method === "OPTIONS") {
      return new Response(null, { status: 204, headers: corsHeaders() })
    }

    // ── Client API (no auth) ──────────────────────────────────────────

    if (path === "/v1/passcode/validate" && method === "POST") {
      const body = await parseBody<ValidateRequest>(request)
      const result = validate(body)
      return json(result, result.ok ? 200 : 403)
    }

    if (path === "/v1/install/heartbeat" && method === "POST") {
      const body = await parseBody<HeartbeatRequest>(request)
      const result = heartbeat(body)
      return json(result, result.ok ? 200 : 403)
    }

    if (path === "/v1/install/status" && method === "POST") {
      const body = await parseBody<StatusRequest>(request)
      const result = status(body)
      return json(result, result.ok ? 200 : 403)
    }

    // ── Webhook: external form submission (Google Forms / Apps Script) ─
    if (path === "/v1/webhook/form" && method === "POST") {
      const limiter = hitRateLimit("webhook:form", 60, 60_000)
      if (!limiter.allowed) {
        return json({ ok: false, error: "Rate limited. Try again shortly." }, 429)
      }
      if (!isValidWebhook(request)) {
        return json({ ok: false, error: "Invalid webhook token." }, 401)
      }
      const body = await parseBody<WebhookFormInput>(request)
      const result = handleFormWebhook(body)
      return json(result, result.ok ? 201 : 400)
    }

    // ── Health check ──────────────────────────────────────────────────

    if (path === "/v1/health") {
      return json({ ok: true, timestamp: new Date().toISOString() })
    }

    // ── Web UI (access page + admin dashboard SPA) ────────────────────

    if (path === "/" || path === "/access" || path === "/admin" || path === "/admin/") {
      return new Response(Bun.file(DASHBOARD_PATH), {
        headers: { "Content-Type": "text/html" },
      })
    }

    // ── Admin API (auth required) ─────────────────────────────────────

    if (path.startsWith("/v1/admin/")) {
      if (!isAdminAuth(request)) {
        return json({ error: "Unauthorized" }, 401)
      }

      // Dashboard statistics
      if (path === "/v1/admin/dashboard/stats" && method === "GET") {
        return json(getPaymentStats())
      }

      // Audit log
      if (path === "/v1/admin/audit-log" && method === "GET") {
        return json({ entries: listAuditLog() })
      }

      // Payment requests
      if (path === "/v1/admin/payment-requests" && method === "GET") {
        return json({ requests: listPaymentRequests() })
      }

      const approveMatch = path.match(/^\/v1\/admin\/payment-requests\/([^/]+)\/approve$/)
      if (approveMatch && method === "POST") {
        const body = await parseBody<ApproveRequest>(request)
        const result = adminApprovePaymentRequest(approveMatch[1], body)
        return json(result, result.ok ? 200 : 400)
      }

      const rejectMatch = path.match(/^\/v1\/admin\/payment-requests\/([^/]+)\/reject$/)
      if (rejectMatch && method === "POST") {
        const body = await parseBody<{ adminNote?: string }>(request)
        const result = adminRejectPaymentRequest(rejectMatch[1], body.adminNote)
        return json(result, result.ok ? 200 : 400)
      }

      const paymentMatch = path.match(/^\/v1\/admin\/payment-requests\/([^/]+)$/)
      if (paymentMatch && method === "GET") {
        const req = getPaymentRequest(paymentMatch[1])
        if (!req) return json({ error: "Payment request not found" }, 404)
        return json({ request: req })
      }

      // Passcodes
      if (path === "/v1/admin/passcodes" && method === "GET") {
        return json(adminListPasscodes())
      }

      if (path === "/v1/admin/passcodes" && method === "POST") {
        const body = await parseBody<AdminPasscodeCreateRequest>(request)
        const passcode = adminCreatePasscode(body)
        return json(passcode, 201)
      }

      if (path === "/v1/admin/passcodes/generate" && method === "POST") {
        const body = await parseBody<{ type: "public" | "personal"; weeks?: number; days?: number }>(request)
        if (body.type === "public") {
          return json(adminGeneratePublicCode(body.weeks ?? 3), 201)
        } else {
          return json(adminGeneratePersonalCode(body.days ?? 30), 201)
        }
      }

      // Issue/renew a passcode for a confirmed-paying customer
      if (path === "/v1/admin/passcodes/issue" && method === "POST") {
        const body = await parseBody<IssuePasscodeRequest>(request)
        const result = adminIssuePasscode(body)
        return json(result, 201)
      }

      const passcodeMatch = path.match(/^\/v1\/admin\/passcodes\/([^/]+)$/)
      if (passcodeMatch) {
        const id = passcodeMatch[1]
        if (path.endsWith("/revoke") && method === "POST") {
          return json(adminRevokePasscode(id))
        }
        if (path.endsWith("/reactivate") && method === "POST") {
          return json(adminReactivatePasscode(id))
        }
        if (method === "PATCH") {
          const body = await parseBody<{ blocked?: boolean }>(request)
          if (body.blocked === true) return json(adminBlockPasscode(id))
          if (body.blocked === false) return json(adminUnblockPasscode(id))
          return json({ error: "Invalid patch" }, 400)
        }
        if (method === "DELETE") {
          return json(adminDeletePasscode(id))
        }
      }

      // Installs
      if (path === "/v1/admin/installs" && method === "GET") {
        return json(adminListInstalls())
      }

      // Customers
      if (path === "/v1/admin/customers" && method === "GET") {
        return json(adminListCustomers())
      }

      const customerMatch = path.match(/^\/v1\/admin\/customers\/([^/]+)$/)
      if (customerMatch && method === "DELETE") {
        return json(adminDeleteCustomer(customerMatch[1]))
      }

      const installMatch = path.match(/^\/v1\/admin\/installs\/([^/]+)$/)
      if (installMatch) {
        const id = installMatch[1]
        if (method === "PATCH") {
          const body = await parseBody<{ blocked?: boolean; reason?: string }>(request)
          if (body.blocked === true) return json(adminBlockInstall(id, body.reason))
          if (body.blocked === false) return json(adminUnblockInstall(id))
          return json({ error: "Invalid patch" }, 400)
        }
        if (method === "DELETE") {
          return json(adminDeleteInstall(id))
        }
      }

      return json({ error: "Not found" }, 404)
    }

    return json({ error: "Not found" }, 404)
  },
})

console.log(`iCode Control Server running on port ${server.port}`)
