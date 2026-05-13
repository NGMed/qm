// Update a Twilio number's SMS webhook URL.
//
// Background — why this exists:
//   Our activation flow purchases the Twilio number with SmsUrl pointed
//   at /api/sms/inbound (our pipeline). Right after that we register the
//   same number with Vapi (lib/vapi/register-number.ts) so inbound voice
//   calls reach the AI receptionist. The catch: when Vapi accepts the
//   number it ALSO rewrites the Twilio SmsUrl to its own endpoint
//   (api.vapi.ai/twilio/sms) so it can offer AI-SMS as a paid add-on.
//   We don't use Vapi's SMS routing — every inbound text needs to land
//   at our pipeline so the tenant lookup + intake structurer can run.
//
// What this helper does:
//   Looks up the Twilio IncomingPhoneNumber row by E.164 number, then
//   POSTs an update setting SmsUrl back to our handler. Idempotent and
//   safe to call multiple times.
//
// Gated by TWILIO_PROVISIONING_ENABLED — when disabled (test mode),
// returns a stub.

const API_BASE = 'https://api.twilio.com/2010-04-01'

export type SetSmsWebhookResult =
  | { ok: true; stubbed: false; twilioSid: string }
  | { ok: true; stubbed: true }
  | { ok: false; reason: string }

export async function setTwilioSmsWebhook(opts: {
  /** E.164 phone number (e.g. +61482012345) */
  phoneNumber: string
  /** Absolute https URL Twilio will POST inbound SMS to. */
  smsUrl: string
}): Promise<SetSmsWebhookResult> {
  if (process.env.TWILIO_PROVISIONING_ENABLED !== 'true') {
    return { ok: true, stubbed: true }
  }

  const sid = process.env.TWILIO_ACCOUNT_SID
  const token = process.env.TWILIO_AUTH_TOKEN
  if (!sid || !token) {
    return { ok: false, reason: 'TWILIO_ACCOUNT_SID or TWILIO_AUTH_TOKEN not set' }
  }

  const auth = 'Basic ' + Buffer.from(`${sid}:${token}`).toString('base64')

  // Step 1: resolve the Twilio SID for this phone number. The list
  // endpoint accepts a PhoneNumber filter that takes E.164; one match
  // expected per tenant.
  let numberSid: string
  try {
    const lookup = await fetch(
      `${API_BASE}/Accounts/${sid}/IncomingPhoneNumbers.json?PhoneNumber=${encodeURIComponent(opts.phoneNumber)}`,
      { headers: { Authorization: auth, Accept: 'application/json' } },
    )
    if (!lookup.ok) {
      const errText = (await lookup.text()).slice(0, 200)
      return { ok: false, reason: `lookup HTTP ${lookup.status}: ${errText}` }
    }
    const json = (await lookup.json()) as {
      incoming_phone_numbers?: Array<{ sid: string; phone_number: string }>
    }
    const match = json.incoming_phone_numbers?.find(
      (n) => n.phone_number === opts.phoneNumber,
    )
    if (!match) {
      return {
        ok: false,
        reason: `No IncomingPhoneNumbers row matches ${opts.phoneNumber}. Vapi may have transferred ownership of the number.`,
      }
    }
    numberSid = match.sid
  } catch (e: unknown) {
    const msg = e instanceof Error ? e.message : String(e)
    return { ok: false, reason: `lookup threw: ${msg}` }
  }

  // Step 2: update SmsUrl + SmsMethod. POST to the resource path acts
  // as a partial update (Twilio convention — same body shape as create).
  try {
    const body = new URLSearchParams()
    body.set('SmsUrl', opts.smsUrl)
    body.set('SmsMethod', 'POST')
    // Wipe SmsFallbackUrl so a stale fallback can't undo the reset on
    // Twilio's side if our primary handler returns a 5xx.
    body.set('SmsFallbackUrl', '')

    const res = await fetch(
      `${API_BASE}/Accounts/${sid}/IncomingPhoneNumbers/${numberSid}.json`,
      {
        method: 'POST',
        headers: {
          Authorization: auth,
          'Content-Type': 'application/x-www-form-urlencoded',
          Accept: 'application/json',
        },
        body: body.toString(),
      },
    )
    if (!res.ok) {
      const errText = (await res.text()).slice(0, 200)
      return { ok: false, reason: `update HTTP ${res.status}: ${errText}` }
    }
    return { ok: true, stubbed: false, twilioSid: numberSid }
  } catch (e: unknown) {
    const msg = e instanceof Error ? e.message : String(e)
    return { ok: false, reason: `update threw: ${msg}` }
  }
}
