// GET /api/solar/q/[token]/static-map — public, share-token-gated Google
// Maps Static proxy for a saved solar estimate. This is the REAL roof
// satellite photo used as the hero on /q/solar/[token] (no generative
// imagery — spec §1, §6). Mirrors the roofing static-map route. Centres
// on the estimate's roof polygon when present, else the saved address.

import { createClient } from '@supabase/supabase-js'
import { buildStaticMapUrl } from '@/lib/roofing/google-maps'
import { resolveSolarOverlayCenter } from '@/lib/solar/static-map-center'
import type { SolarEstimate } from '@/lib/solar/types'

export const dynamic = 'force-dynamic'

const supabase = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!,
)

export async function GET(_req: Request, ctx: { params: Promise<{ token: string }> }) {
  const { token } = await ctx.params
  if (!token || token.length < 8) {
    return Response.json({ ok: false, error: 'bad_token' }, { status: 400 })
  }

  const { data: row, error } = await supabase
    .from('solar_estimates')
    .select('address, estimate')
    .eq('public_token', token)
    .maybeSingle()
  if (error || !row) {
    return Response.json({ ok: false, error: 'not_found' }, { status: 404 })
  }

  const apiKey = process.env.GOOGLE_MAPS_API_KEY
  if (!apiKey) {
    return Response.json(
      { ok: false, error: 'GOOGLE_MAPS_API_KEY not set on the server' },
      { status: 503 },
    )
  }

  const estimate = (row.estimate as SolarEstimate | null) ?? null
  const address = (row.address as string | null) ?? undefined
  // The overlay centre: panel centroid → polygon → resolved geocode.
  // The layout/string overlays (premium quote §4.2) project against this
  // SAME coordinate, so map and overlays stay pixel-aligned by
  // construction. Address-string centring is the last resort (overlays
  // are omitted in that case — no deterministic pixel mapping exists).
  const center = estimate
    ? resolveSolarOverlayCenter({
        roof: estimate.roof,
        location: estimate.context.location ?? null,
      })
    : null
  if (!address && !center) {
    return Response.json({ ok: false, error: 'no_location' }, { status: 400 })
  }

  // Marker only when no panel geometry will be drawn over the photo —
  // a pin under the panel-layout overlay is noise.
  const hasPanels = (estimate?.roof.panels?.length ?? 0) > 0

  let target: string
  try {
    target = buildStaticMapUrl(
      {
        address: center ? undefined : address,
        center: center ?? undefined,
        zoom: 20,
        size: { width: 640, height: 480 },
        markers:
          center && !hasPanels
            ? [{ lat: center.lat, lng: center.lng, color: 'orange' }]
            : undefined,
      },
      { apiKey },
    )
  } catch (e) {
    return Response.json(
      { ok: false, error: e instanceof Error ? e.message : String(e) },
      { status: 400 },
    )
  }

  let res: Response
  try {
    res = await fetch(target, { method: 'GET' })
  } catch (e) {
    return Response.json(
      { ok: false, error: `Google Maps Static fetch failed: ${e instanceof Error ? e.message : String(e)}` },
      { status: 502 },
    )
  }
  if (!res.ok) {
    let body = ''
    try { body = (await res.text()).slice(0, 300) } catch { /* ignore */ }
    return Response.json(
      { ok: false, error: `Google Maps Static returned ${res.status}`, upstreamBody: body },
      { status: 502 },
    )
  }

  const ct = res.headers.get('content-type') ?? 'image/png'
  const arrayBuffer = await res.arrayBuffer()
  return new Response(arrayBuffer, {
    status: 200,
    headers: { 'Content-Type': ct, 'Cache-Control': 'public, max-age=86400, immutable' },
  })
}
