// Optional outbound notification layer (spec §31).
//
// When a passcode is issued, iCode Control can post a template to an external
// channel so the user actually receives their code. Nothing is sent unless
// NOTIFICATION_WEBHOOK_URL is configured: set it to e.g. a Telegram bot / an
// email-relay / a Slack webhook that accepts a JSON POST.
//
//   NOTIFICATION_WEBHOOK_URL     e.g. https://example.com/iCodeNotify
//   NOTIFICATION_WEBHOOK_TOKEN   optional bearer token ("Authorization: Bearer <token>")

export interface NotificationMessage {
  userId: string
  name: string
  email: string | null
  phone: string | null
  passcode: string
  expiresAt: string
}

const NOTIFICATION_URL = process.env.NOTIFICATION_WEBHOOK_URL
const NOTIFICATION_TOKEN = process.env.NOTIFICATION_WEBHOOK_TOKEN

export function notificationConfigured(): boolean {
  return !!NOTIFICATION_URL
}

export async function sendPasscodeNotification(msg: NotificationMessage): Promise<boolean> {
  if (!NOTIFICATION_URL) return false
  try {
    const headers: Record<string, string> = { "Content-Type": "application/json" }
    if (NOTIFICATION_TOKEN) headers.Authorization = `Bearer ${NOTIFICATION_TOKEN}`
    const response = await fetch(NOTIFICATION_URL, {
      method: "POST",
      headers,
      body: JSON.stringify({
        // Provides a ready-to-place message you can format on the receiving side.
        subject: "iCode Passcode — Murakaza neza!",
        message: [
          "Murakaza neza kuri iCode!",
          "Ubwishyu bwawe bwa 1,000 RWF bwemejwe.",
          `Passcode yawe: ${msg.passcode}`,
          "Koresha iyi Passcode kugira ngo utangire gukoresha iCode.",
          `Itangirira: ${msg.expiresAt}`,
          "",
          "— iCode",
          "Irabizi Paisible Valentin",
        ].join("\n"),
        recipient: { email: msg.email, phone: msg.phone },
        passcode: msg.passcode,
        expiresAt: msg.expiresAt,
        name: msg.name,
      }),
    })
    return response.ok
  } catch {
    // Notifications must never break the approval flow.
    return false
  }
}
