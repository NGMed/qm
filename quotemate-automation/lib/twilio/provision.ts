// Twilio number provisioning for tradie onboarding.
//
// Country:  Australia ONLY (hard-coded `/AU/...` paths below).
// Capabilities required: Voice + SMS + MMS.
// Capabilities preferred (best-effort): Fax.
//
// Reality check on Fax + AU mobile: Twilio's AU Mobile inventory
// typically supports Voice + SMS + MMS but NOT Fax. Fax-capable AU
// numbers are usually Local or TollFree. So this helper:
//   1. First tries AU Mobile with Voice+SMS+MMS+Fax. Rare match but ideal.
//   2. Falls back to AU Local with Voice+SMS+MMS+Fax.
//   3. Falls back to AU Mobile with Voice+SMS+MMS (drops Fax).
//   4. Falls back to AU Local with Voice+SMS+MMS.
// The result includes the final capabilities so the caller knows whether
// Fax actually landed.
//
// Gated by env flag `TWILIO_PROVISIONING_ENABLED=true`. When disabled (the
// default — keeps the test phase free of Twilio charges), returns a
// deterministic stub number derived from the tenant UUID so retries
// don't collide and the UI still has something to show.

const API_BASE = 'https://api.twilio.com/2010-04-01'
const COUNTRY = 'AU' as const

// Vapi's hosted Twilio inbound-call endpoint. When a call lands on the
// purchased Twilio number, Twilio POSTs to this URL; Vapi then looks up
// which assistant to run by the destination number (mapping configured
// via lib/vapi/register-number.ts).
//
// Constant rather than env var because this is Vapi's public endpoint
// and never changes per-deployment.
const VAPI_INBOUND_VOICE_URL = 'https://api.vapi.ai/twilio/inbound_call'

export type NumberCapabilities = {
  voice: boolean
  sms: boolean
  mms: boolean
  fax: boolean
}

export type ProvisionResult =
  | {
      ok: true
      stubbed: false
      phoneNumber: string
      twilioSid: string
      numberType: 'Mobile' | 'Local'
      capabilities: NumberCapabilities
      faxAvailable: boolean
    }
  | { ok: true; stubbed: true; phoneNumber: string }
  | { ok: false; reason: string; code?: string }

type SearchAttempt = {
  numberType: 'Mobile' | 'Local'
  requireFax: boolean
}

// Order matters — earliest match wins. Mobile is preferred because
// tradies' customers expect to text/MMS a mobile, not a landline.
const SEARCH_ORDER: SearchAttempt[] = [
  { numberType: 'Mobile', requireFax: true },   // ideal: all 4 caps on a mobile
  { numberType: 'Local',  requireFax: true },   // ideal-ish: all 4 caps on a landline
  { numberType: 'Mobile', requireFax: false },  // fallback: 3 caps on a mobile
  { numberType: 'Local',  requireFax: false },  // fallback: 3 caps on a landline
]

export async function provisionTwilioNumber(opts: {
  tenantId: string
  /** Customer-facing label for the number — shows in Twilio console */
  friendlyName: string
  /** AU area code preference (e.g. '02' Sydney, '07' Brisbane). Mobile defaults to '04'. */
  areaCode?: string
}): Promise<ProvisionResult> {
  // Gate the live API call. When unset or "false", return a stub so the
  // rest of the activate flow can run end-to-end without burning Twilio money.
  if (process.env.TWILIO_PROVISIONING_ENABLED !== 'true') {
    return {
      ok: true,
      stubbed: true,
      phoneNumber: stubNumberFor(opts.tenantId),
    }
  }

  const sid = process.env.TWILIO_ACCOUNT_SID
  const token = process.env.TWILIO_AUTH_TOKEN
  const appUrl = process.env.APP_URL ?? process.env.NEXT_PUBLIC_APP_URL
  // AU numbers require an AddressSid at purchase time (Twilio regulatory
  // bundle). We attach the single platform-level address registered on
  // QuoteMate's Twilio account to every tradie's number. The tradie's own
  // address isn't required here — Twilio only needs a verifiable address
  // for the account doing the purchase, which is us. Set this in Vercel
  // to the SID shown under Twilio Console → Phone Numbers → Regulatory
  // Compliance → Addresses (starts with AD…).
  const addressSid = process.env.TWILIO_ADDRESS_SID
  if (!sid || !token) {
    return { ok: false, reason: 'TWILIO_ACCOUNT_SID or TWILIO_AUTH_TOKEN not set' }
  }
  if (!appUrl) {
    return { ok: false, reason: 'APP_URL or NEXT_PUBLIC_APP_URL must be set so webhooks resolve' }
  }
  if (!addressSid) {
    return {
      ok: false,
      reason:
        'TWILIO_ADDRESS_SID not set. AU numbers require an address on the purchase. ' +
        'Grab the SID from Twilio Console → Phone Numbers → Regulatory Compliance → ' +
        'Addresses (starts with AD…) and add it to Vercel env vars.',
    }
  }

  const auth = 'Basic ' + Buffer.from(sid + ':' + token).toString('base64')

  // Step 1: walk the search order until we find an available number.
  let picked: { number: string; numberType: 'Mobile' | 'Local'; requireFax: boolean } | null = null
  const searchAttempts: string[] = []

  for (const attempt of SEARCH_ORDER) {
    const sp = new URLSearchParams({
      VoiceEnabled: 'true',
      SmsEnabled: 'true',
      MmsEnabled: 'true',
      Limit: '5',
    })
    if (attempt.requireFax) sp.set('FaxEnabled', 'true')
    if (opts.areaCode) sp.set('AreaCode', opts.areaCode)

    const path = `/AU/${attempt.numberType}.json`
    try {
      const res = await fetch(
        `${API_BASE}/Accounts/${sid}/AvailablePhoneNumbers${path}?${sp.toString()}`,
        { headers: { Authorization: auth, Accept: 'application/json' } },
      )
      if (!res.ok) {
        const errText = (await res.text()).slice(0, 200)
        searchAttempts.push(`${attempt.numberType}${attempt.requireFax ? '+fax' : ''}: HTTP ${res.status} — ${errText}`)
        continue
      }
      const json = (await res.json()) as {
        available_phone_numbers?: Array<{ phone_number: string }>
      }
      const first = json.available_phone_numbers?.[0]?.phone_number
      if (first) {
        picked = { number: first, numberType: attempt.numberType, requireFax: attempt.requireFax }
        break
      }
      searchAttempts.push(`${attempt.numberType}${attempt.requireFax ? '+fax' : ''}: 0 results`)
    } catch (e: any) {
      searchAttempts.push(`${attempt.numberType}${attempt.requireFax ? '+fax' : ''}: threw — ${e?.message ?? String(e)}`)
    }
  }

  if (!picked) {
    return {
      ok: false,
      reason:
        `No AU number available with Voice+SMS+MMS (tried Mobile and Local, with and without Fax). ` +
        `Search attempts: ${searchAttempts.join(' | ')}`,
    }
  }

  // Step 2: purchase + auto-configure webhooks.
  //
  //   SmsUrl   → our /api/sms/inbound (Twilio posts inbound SMS here;
  //              we handle them in-process via the tenant lookup pipeline)
  //   VoiceUrl → Vapi's hosted Twilio inbound endpoint. Vapi looks up
  //              the assistant by the destination number after we register
  //              the number with Vapi (lib/vapi/register-number.ts).
  //
  // Tradies never have to set any of this manually — the activate flow
  // does it end-to-end.
  //
  // (Twilio also has a FaxUrl property; we leave it unset for now since
  // fax routing isn't built. Numbers with Fax capability still work for
  // Voice/SMS/MMS — fax just won't be answered by us.)
  const purchaseBody = new URLSearchParams()
  purchaseBody.set('PhoneNumber', picked.number)
  purchaseBody.set('FriendlyName', opts.friendlyName)
  // AddressSid is mandatory for AU number purchases — without it Twilio
  // rejects with "Phone Number Requires an Address but the 'AddressSid'
  // parameter was empty." See lib/twilio/provision.ts addressSid resolution.
  purchaseBody.set('AddressSid', addressSid)
  purchaseBody.set('SmsUrl', `${appUrl}/api/sms/inbound`)
  purchaseBody.set('SmsMethod', 'POST')
  purchaseBody.set('VoiceUrl', VAPI_INBOUND_VOICE_URL)
  purchaseBody.set('VoiceMethod', 'POST')

  try {
    const buyRes = await fetch(
      `${API_BASE}/Accounts/${sid}/IncomingPhoneNumbers.json`,
      {
        method: 'POST',
        headers: {
          Authorization: auth,
          'Content-Type': 'application/x-www-form-urlencoded',
          Accept: 'application/json',
        },
        body: purchaseBody.toString(),
      },
    )
    const text = await buyRes.text()
    const parsed = (() => { try { return JSON.parse(text) } catch { return null } })()
    if (!buyRes.ok) {
      return {
        ok: false,
        reason: parsed?.message ?? `purchase failed: HTTP ${buyRes.status}`,
        code: parsed?.code != null ? String(parsed.code) : undefined,
      }
    }

    // Twilio returns capabilities on the purchased number. Surface them
    // so the caller (and ultimately the tenant row) knows exactly what
    // the new number can do.
    // Twilio's REST API has returned capability keys in both lowercase
    // (current) and uppercase (older accounts) forms — accept either.
    const caps = parsed.capabilities ?? {}
    const capabilities: NumberCapabilities = {
      voice: !!(caps.voice ?? caps.VOICE),
      sms:   !!(caps.sms   ?? caps.SMS),
      mms:   !!(caps.mms   ?? caps.MMS),
      fax:   !!(caps.fax   ?? caps.FAX),
    }

    return {
      ok: true,
      stubbed: false,
      phoneNumber: parsed.phone_number,
      twilioSid: parsed.sid,
      numberType: picked.numberType,
      capabilities,
      faxAvailable: capabilities.fax,
    }
  } catch (e: any) {
    return { ok: false, reason: `purchase threw: ${e?.message ?? String(e)}` }
  }
}

/**
 * Deterministic placeholder number derived from the tenant UUID.
 * Format: +61 482 0XX XXX — within the AU mobile band, recognisable as
 * a placeholder once you've seen one, and stable across retries.
 */
function stubNumberFor(tenantId: string): string {
  const hex = tenantId.replace(/-/g, '').slice(0, 5)
  const num = (parseInt(hex, 16) % 100000).toString().padStart(5, '0')
  return `+614820${num.slice(0, 2)}${num.slice(2)}`
}
