import { randomBytes } from "crypto"
import {
  createOAuthState,
  getOAuthState,
  deleteOAuthState,
  upsertGoogleAccount,
  activateInstallByGoogle,
} from "../db"
import { hitRateLimit } from "../rate-limit"

// Google OAuth is brokered by this server:
//  1. The editor (or CLI) asks for a sign-in URL via /v1/google/begin.
//  2. The user opens that URL (Google consent), which redirects back to
//     /v1/google/callback on this server with an authorization `code`.
//  3. This server exchanges the code, reads the user's email, creates or
//     reuses the Google account (one 21-day trial per email, first sign-in
//     only) and links the machine identified in the OAuth `state` to it.
//  4. The editor polls /v1/install/status until the machine is licensed.
//
// Environment:
//   GOOGLE_CLIENT_ID, GOOGLE_CLIENT_SECRET — Google Cloud OAuth app.
//   GOOGLE_REDIRECT_URI — optional override; defaults to
//     <request origin>/v1/google/callback.

const GOOGLE_CLIENT_ID = process.env.GOOGLE_CLIENT_ID ?? ""
const GOOGLE_CLIENT_SECRET = process.env.GOOGLE_CLIENT_SECRET ?? ""
const GOOGLE_REDIRECT_URI = process.env.GOOGLE_REDIRECT_URI ?? ""

const SCOPES = "openid email profile"
const AUTH_URL = "https://accounts.google.com/o/oauth2/v2/auth"
const TOKEN_URL = "https://oauth2.googleapis.com/token"
const USERINFO_URL = "https://openidconnect.googleapis.com/v1/userinfo"

export function googleConfigured(): boolean {
  return !!(GOOGLE_CLIENT_ID && GOOGLE_CLIENT_SECRET)
}

function redirectUri(request: Request): string {
  if (GOOGLE_REDIRECT_URI) return GOOGLE_REDIRECT_URI
  const origin = request.headers.get("origin") ?? request.headers.get("x-forwarded-proto")
  const host = request.headers.get("host")
  if (host) {
    const proto = request.headers.get("x-forwarded-proto") ?? "https"
    return `${proto}://${host}/v1/google/callback`
  }
  if (origin) return `${origin}/v1/google/callback`
  throw new Error("Could not determine the OAuth redirect URI.")
}

export interface BeginGoogleRequest {
  machine_id?: string
  hardware_id?: string
  platform?: string
  arch?: string
  version?: string
}

export interface BeginGoogleResponse {
  ok: boolean
  url?: string
  message?: string
}

export async function beginGoogleAuth(req: BeginGoogleRequest, request: Request): Promise<BeginGoogleResponse> {
  if (!googleConfigured()) {
    return { ok: false, message: "Google sign-in is not configured on the iCode server yet." }
  }
  const machineId = (req.machine_id ?? "").trim()
  if (!machineId) {
    return { ok: false, message: "machine_id is required to sign in with Google." }
  }

  const limiter = hitRateLimit(`google:begin:${machineId}`, 10, 60_000)
  if (!limiter.allowed) {
    return { ok: false, message: "Too many sign-in attempts. Please wait a moment and try again." }
  }

  const state = randomBytes(24).toString("hex")
  await createOAuthState({
    state,
    machine_id: machineId,
    hardware_id: req.hardware_id,
    platform: req.platform,
    arch: req.arch,
    version: req.version,
  })

  const params = new URLSearchParams({
    client_id: GOOGLE_CLIENT_ID,
    redirect_uri: redirectUri(request),
    response_type: "code",
    scope: SCOPES,
    state,
    access_type: "online",
    prompt: "select_account",
  })

  return { ok: true, url: `${AUTH_URL}?${params.toString()}` }
}

interface GoogleTokenResponse {
  access_token?: string
  id_token?: string
  error?: string
  error_description?: string
}

interface GoogleUserInfo {
  sub?: string
  email?: string
  email_verified?: boolean
  name?: string
}

export interface GoogleCallbackResult {
  ok: boolean
  email?: string
  message: string
  html: string
}

export async function handleGoogleCallback(code: string | null, state: string | null, request: Request): Promise<GoogleCallbackResult> {
  if (!googleConfigured()) {
    return {
      ok: false,
      message: "Google sign-in is not configured on the iCode server yet.",
      html: donePage(false, "Google sign-in is not configured on the iCode server yet."),
    }
  }
  if (!code || !state) {
    return {
      ok: false,
      message: "Missing Google authorization response. Please try again.",
      html: donePage(false, "The Google sign-in response was incomplete. Please try again."),
    }
  }

  const oauthState = await getOAuthState(state)
  if (!oauthState) {
    return {
      ok: false,
      message: "This sign-in link has expired. Please start a new sign-in from the iCode app.",
      html: donePage(false, "This sign-in link has expired. Please start a new sign-in from the iCode app."),
    }
  }
  if (new Date(oauthState.expires_at) < new Date()) {
    await deleteOAuthState(state)
    return {
      ok: false,
      message: "This sign-in link has expired. Please start a new sign-in from the iCode app.",
      html: donePage(false, "This sign-in link has expired. Please start a new sign-in from the iCode app."),
    }
  }
  await deleteOAuthState(state)

  const tokenRes = await fetch(TOKEN_URL, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      code,
      client_id: GOOGLE_CLIENT_ID,
      client_secret: GOOGLE_CLIENT_SECRET,
      redirect_uri: redirectUri(request),
      grant_type: "authorization_code",
    }),
    signal: AbortSignal.timeout(10_000),
  })
  const token = (await tokenRes.json()) as GoogleTokenResponse
  if (!tokenRes.ok || !token.access_token) {
    return {
      ok: false,
      message: "Google could not complete the sign-in. Please try again.",
      html: donePage(false, "Google could not complete the sign-in. Please try again."),
    }
  }

  const userRes = await fetch(USERINFO_URL, {
    headers: { Authorization: `Bearer ${token.access_token}` },
    signal: AbortSignal.timeout(10_000),
  })
  const user = (await userRes.json()) as GoogleUserInfo
  const email = (user.email ?? "").toLowerCase().trim()
  const sub = user.sub ?? email
  if (!userRes.ok || !email || !sub) {
    return {
      ok: false,
      message: "Could not read your Google profile. Please try again.",
      html: donePage(false, "Could not read your Google profile. Please try again."),
    }
  }

  const account = await upsertGoogleAccount({
    google_sub: sub,
    email,
    display_name: user.name ?? null,
  })

  await activateInstallByGoogle({
    machine_id: oauthState.machine_id,
    hardware_id: oauthState.hardware_id ?? undefined,
    platform: oauthState.platform ?? "unknown",
    arch: oauthState.arch ?? "unknown",
    version: oauthState.version ?? undefined,
    google_account_id: account.id,
  })

  const alreadyUsed = account.trial_started_at !== null
  const trialEnded = !!account.trial_expires_at && new Date(account.trial_expires_at) < new Date()
  const message = trialEnded
    ? "This Google account has already used its free trial. To keep using iCode, please get a Passcode."
    : alreadyUsed
      ? "Your Google trial is already active. You can now return to iCode Editor."
      : "Your 21-day free Google trial is now active. You can return to iCode Editor."
  return { ok: true, email, message, html: donePage(true, message, email) }
}

function donePage(ok: boolean, message: string, email?: string): string {
  const heading = ok ? "Sign-in successful" : "Sign-in failed"
  const color = ok ? "#197a3a" : "#b42318"
  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>iCode — ${heading}</title>
  <style>
    body { font-family: system-ui, -apple-system, sans-serif; background: #0f1117; color: #e6e6e6; display: flex; align-items: center; justify-content: center; min-height: 100vh; margin: 0; }
    .card { background: #181c27; border: 1px solid #2a3140; border-radius: 12px; padding: 32px; max-width: 420px; text-align: center; }
    h1 { color: ${color}; font-size: 20px; margin: 0 0 12px; }
    p { color: #c9c9c9; line-height: 1.5; margin: 0 0 8px; }
    .email { color: #8ab4ff; font-family: monospace; }
    .note { font-size: 13px; color: #7a7f8a; }
  </style>
</head>
<body>
  <div class="card">
    <h1>${heading}</h1>
    <p>${message}</p>
    ${email ? `<p class="email">${email}</p>` : ""}
    <p class="note">You can now close this tab and return to iCode Editor.</p>
  </div>
</body>
</html>`
}