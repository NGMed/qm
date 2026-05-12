// Register a freshly-purchased Twilio number with Vapi.
//
// This is the link that makes the inbound voice path work end-to-end:
//   • Customer dials the tenant's Twilio number
//   • Twilio's Voice webhook is set to https://api.vapi.ai/twilio/inbound_call
//   • Vapi receives the request, looks up the number in ITS database,
//     and runs the assistant we bound to that number
//
// Without this registration step, Vapi gets a call but doesn't know
// which assistant should handle it.
//
// Gated by VAPI_PROVISIONING_ENABLED — same flag as the assistant
// creation. When off, returns a stub so the activate flow still ticks
// through without external API calls.

const VAPI_API = 'https://api.vapi.ai'

export type VapiRegisterResult =
  | { ok: true; stubbed: false; vapiPhoneNumberId: string }
  | { ok: true; stubbed: true }
  | { ok: false; reason: string }

export async function registerNumberWithVapi(opts: {
  /** E.164 phone number (e.g. +61482012345) */
  phoneNumber: string
  /** The Vapi assistant_id returned by provisionVapiAssistant */
  assistantId: string
  /** Display name for the Vapi dashboard */
  name: string
}): Promise<VapiRegisterResult> {
  if (process.env.VAPI_PROVISIONING_ENABLED !== 'true') {
    return { ok: true, stubbed: true }
  }

  const apiKey = process.env.VAPI_API_KEY
  const twilioSid = process.env.TWILIO_ACCOUNT_SID
  const twilioToken = process.env.TWILIO_AUTH_TOKEN

  if (!apiKey) {
    return { ok: false, reason: 'VAPI_API_KEY not set' }
  }
  if (!twilioSid || !twilioToken) {
    return { ok: false, reason: 'TWILIO_ACCOUNT_SID or TWILIO_AUTH_TOKEN not set' }
  }

  const body = {
    provider: 'twilio',
    number: opts.phoneNumber,
    twilioAccountSid: twilioSid,
    twilioAuthToken: twilioToken,
    assistantId: opts.assistantId,
    name: opts.name,
  }

  try {
    const res = await fetch(`${VAPI_API}/phone-number`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${apiKey}`,
        'Content-Type': 'application/json',
        Accept: 'application/json',
      },
      body: JSON.stringify(body),
    })
    const text = await res.text()
    const parsed = (() => { try { return JSON.parse(text) } catch { return null } })()
    if (!res.ok) {
      return {
        ok: false,
        reason: parsed?.message ?? parsed?.error ?? `HTTP ${res.status}: ${text.slice(0, 200)}`,
      }
    }
    if (!parsed?.id) {
      return { ok: false, reason: 'Vapi response missing phone-number id' }
    }
    return { ok: true, stubbed: false, vapiPhoneNumberId: parsed.id }
  } catch (e: any) {
    return { ok: false, reason: `Vapi /phone-number threw: ${e?.message ?? String(e)}` }
  }
}
