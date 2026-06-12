// ════════════════════════════════════════════════════════════════════
// POST /api/solar/confirm/[token] — the forced tradie review step.
//
// No solar estimate auto-sends. The tradie reviews the drafted tiers and
// confirms; that stamps confirmed_at on the solar_estimates row, which is
// what canShowPrices() + solarPayRedirectTarget() unlock against. A
// flagged estimate (guardrail_flags non-empty) cannot be confirmed — the
// tradie must adjust the numbers (clearing the flags on re-draft) first.
//
// Next 16: params is a Promise (await it). Bearer auth required.
// ════════════════════════════════════════════════════════════════════

import { createClient } from '@supabase/supabase-js'
import { after } from 'next/server'
import { ensureSolarQuotePdf, solarQuotePdfUrl, signQuotePdfUrl } from '@/lib/quote/pdf'
import { dispatchQuoteWithPdf } from '@/lib/sms/send-quote-pdf'
import { buildSolarCustomerSms } from '@/lib/solar/notify'
import type { SolarEstimate } from '@/lib/solar/types'

export const dynamic = 'force-dynamic'

function getSupabase() {
  return createClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.SUPABASE_SERVICE_ROLE_KEY!,
  )
}

export type ConfirmEligibilityInput = {
  guardrailFlags: string[]
  alreadyConfirmedAt: string | null
}

export type ConfirmEligibilityResult =
  | { ok: true; stamp: boolean }
  | { ok: false; status: number; error: string }

/**
 * PURE — decide whether this estimate may be confirmed.
 *  • guardrail flags present → 409, cannot confirm
 *  • already confirmed       → ok, stamp:false (idempotent no-op)
 *  • clean + unconfirmed     → ok, stamp:true
 */
export function confirmEligibility(
  input: ConfirmEligibilityInput,
): ConfirmEligibilityResult {
  if (input.guardrailFlags.length > 0) {
    return {
      ok: false,
      status: 409,
      error:
        'This estimate has open checks (guardrail flags). Adjust the tiers and re-draft before confirming.',
    }
  }
  if (input.alreadyConfirmedAt) return { ok: true, stamp: false }
  return { ok: true, stamp: true }
}

export async function POST(
  req: Request,
  ctx: { params: Promise<{ token: string }> },
) {
  const { token } = await ctx.params
  if (!token || token.length < 8) {
    return Response.json({ ok: false, error: 'invalid_token' }, { status: 400 })
  }

  const auth = req.headers.get('authorization') ?? ''
  if (!auth.toLowerCase().startsWith('bearer ')) {
    return Response.json({ ok: false, error: 'unauthorized' }, { status: 401 })
  }
  const accessToken = auth.slice(7).trim()
  const supabase = getSupabase()
  const { data: userData, error: userErr } = await supabase.auth.getUser(accessToken)
  if (userErr || !userData?.user) {
    return Response.json({ ok: false, error: 'unauthorized' }, { status: 401 })
  }

  const { data: row, error } = await supabase
    .from('solar_estimates')
    .select('id, tenant_id, public_token, intake_id, routing, address, confirmed_at, guardrail_flags')
    .eq('public_token', token)
    .maybeSingle()
  if (error || !row) {
    return Response.json({ ok: false, error: 'not_found' }, { status: 404 })
  }

  const eligibility = confirmEligibility({
    guardrailFlags: (row.guardrail_flags as string[] | null) ?? [],
    alreadyConfirmedAt: (row.confirmed_at as string | null) ?? null,
  })
  if (!eligibility.ok) {
    return Response.json(
      { ok: false, error: eligibility.error },
      { status: eligibility.status },
    )
  }

  if (eligibility.stamp) {
    const confirmedAt = new Date().toISOString()
    const { error: updErr } = await supabase
      .from('solar_estimates')
      .update({ confirmed_at: confirmedAt })
      .eq('id', row.id)
    if (updErr) {
      return Response.json(
        { ok: false, error: 'confirm_failed' },
        { status: 500 },
      )
    }
    // First confirmation → text the customer their quote (PDF link +
    // best-effort MMS), after the response so confirm never blocks on the
    // SMS. No-op unless a customer mobile was captured at estimate time.
    after(() =>
      sendCustomerSolarQuote(supabase, {
        tenantId: (row.tenant_id as string | null) ?? null,
        publicToken: row.public_token as string,
        intakeId: (row.intake_id as string | null) ?? null,
        routing: (row.routing as string | null) ?? null,
      }),
    )
    return Response.json({ ok: true, confirmed_at: confirmedAt })
  }

  return Response.json({ ok: true, confirmed_at: row.confirmed_at })
}

/**
 * Best-effort customer quote SMS on tradie-confirm. Reads the optional
 * customer mobile from intake.caller (captured at estimate time); when
 * present and the estimate is priced (not inspection-routed), generates the
 * solar PDF and texts the durable quote + PDF link with a best-effort MMS.
 * Never throws — solar confirmation must not depend on the customer SMS.
 */
async function sendCustomerSolarQuote(
  supabase: ReturnType<typeof getSupabase>,
  row: {
    tenantId: string | null
    publicToken: string
    intakeId: string | null
    routing: string | null
  },
): Promise<void> {
  try {
    if (row.routing === 'inspection_required') return
    if (!row.intakeId) return

    const { data: intake } = await supabase
      .from('intakes')
      .select('caller')
      .eq('id', row.intakeId)
      .maybeSingle()
    const caller = (intake?.caller as { name?: string; phone?: string } | null) ?? null
    const phone = caller?.phone?.trim()
    if (!phone) return

    const { data: est } = await supabase
      .from('solar_estimates')
      .select('estimate')
      .eq('public_token', row.publicToken)
      .maybeSingle()
    const estimate = (est?.estimate as SolarEstimate | null) ?? null
    if (!estimate) return
    // Headline = largest tier (last), matching the share-page hero.
    const headline = estimate.price.tiers[estimate.price.tiers.length - 1]

    const { data: tenant } = await supabase
      .from('tenants')
      .select('business_name, twilio_sms_number')
      .eq('id', row.tenantId)
      .maybeSingle()
    const businessName = (tenant?.business_name as string | null) ?? 'Your installer'

    const appUrl = (process.env.APP_URL ?? 'https://quote-mate-rho.vercel.app').replace(/\/$/, '')
    const pdfPath = await ensureSolarQuotePdf(row.publicToken)
    const body = buildSolarCustomerSms({
      businessName,
      customerName: caller?.name || null,
      systemKw: headline?.system_kw_dc ?? 0,
      netIncGst: headline?.net_inc_gst ?? 0,
      quoteUrl: `${appUrl}/q/solar/${row.publicToken}`,
      pdfUrl: pdfPath ? solarQuotePdfUrl(row.publicToken) : null,
    })
    await dispatchQuoteWithPdf({
      to: phone,
      text: body,
      from: (tenant?.twilio_sms_number as string | null) ?? process.env.TWILIO_SMS_NUMBER,
      pdfPath,
      signMediaUrl: signQuotePdfUrl,
    })
  } catch (e) {
    console.error(
      '[solar/confirm] customer quote send failed (non-fatal)',
      e instanceof Error ? e.message : e,
    )
  }
}
