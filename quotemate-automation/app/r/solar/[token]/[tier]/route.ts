// ════════════════════════════════════════════════════════════════════
// GET /r/solar/[token]/[tier] — solar deposit short-link.
//
// Mirrors app/r/[token]/[tier]/route.ts but layers the forced-confirm
// gate (solarPayRedirectTarget):
//   locked → /q/solar/[token]?locked=1  (deposit not yet unlocked)
//   book   → /q/solar/[token]/book?tier=…
//   paid   → /q/solar/[token]/paid?tier=…&already=1
//   stripe → the stored stripe_links[tier] checkout URL
//
// Next 16: params is a Promise (await it).
// ════════════════════════════════════════════════════════════════════

import { createClient } from '@supabase/supabase-js'
import { solarPayRedirectTarget, type SolarPayRedirectKind } from '../../../../../lib/solar/publish'

export const dynamic = 'force-dynamic'

export const VALID_SOLAR_TIERS = new Set(['good', 'better', 'best', 'inspection'])

function getSupabase() {
  return createClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.SUPABASE_SERVICE_ROLE_KEY!,
  )
}

/**
 * PURE — build the redirect destination from a resolved target. Returns
 * null only when target is 'stripe' but no checkout link is stored
 * (caller then 404s).
 */
export function buildSolarRedirectUrl(args: {
  target: SolarPayRedirectKind
  token: string
  tier: string
  stripeUrl: string | null
  appUrl: string
}): string | null {
  const { target, token, tier, stripeUrl, appUrl } = args
  if (target === 'locked') return `${appUrl}/q/solar/${token}?locked=1`
  if (target === 'book') return `${appUrl}/q/solar/${token}/book?tier=${tier}`
  if (target === 'paid') return `${appUrl}/q/solar/${token}/paid?tier=${tier}&already=1`
  return stripeUrl ?? null
}

export async function GET(
  _req: Request,
  ctx: { params: Promise<{ token: string; tier: string }> },
) {
  const { token, tier } = await ctx.params
  if (!VALID_SOLAR_TIERS.has(tier)) {
    return new Response('Invalid tier', { status: 400 })
  }

  const { data: row } = await getSupabase()
    .from('solar_estimates')
    .select('confirmed_at, paid_at, scheduled_at, stripe_links')
    .eq('token', token)
    .maybeSingle()
  if (!row) return new Response('Not found', { status: 404 })

  const target = solarPayRedirectTarget({
    confirmedAt: (row.confirmed_at as string | null) ?? null,
    paid: !!(row.paid_at as string | null),
    scheduledAt: (row.scheduled_at as string | null) ?? null,
    tier,
  })

  const stripeUrl =
    (row.stripe_links as Record<string, string> | null)?.[tier] ?? null
  const appUrl = process.env.APP_URL ?? process.env.NEXT_PUBLIC_APP_URL ?? ''
  const dest = buildSolarRedirectUrl({ target, token, tier, stripeUrl, appUrl })

  if (!dest) return new Response('No payment link for this tier', { status: 404 })
  return Response.redirect(dest, 302)
}
