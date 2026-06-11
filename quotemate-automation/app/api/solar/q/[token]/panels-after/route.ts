// GET /api/solar/q/[token]/panels-after — public, share-token-gated AI
// "panels installed" concept for a saved solar estimate.
//
// Lazy + self-caching (mirrors /api/roofing/q/[token]/after-image): on the
// first request after tradie confirmation it generates the Gemini
// image-to-image render FROM the Google satellite aerial, stores it in the
// intake-photos bucket, and streams it. Subsequent requests serve the
// cached image. If generation isn't ready (in-flight or failed) it falls
// back to streaming the plain satellite, so the <img> on /q/solar/[token]
// always shows something.
//
// Pre-confirm, only the plain satellite is served — a billable render can
// never be triggered by someone who merely holds the share token.

import { createClient } from '@supabase/supabase-js'
import { buildStaticMapUrl } from '@/lib/roofing/google-maps'
import { generateSolarPanelsImage } from '@/lib/solar/panels-after'
import { centerForSolarEstimate } from '@/lib/solar/static-map-center'
import type { SolarEstimate } from '@/lib/solar/types'

export const dynamic = 'force-dynamic'
// Gemini image generation can take 10-20s; raise the default 10s limit.
export const maxDuration = 60

const supabase = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!,
)

/** Stream the plain Google satellite — the graceful fallback. */
async function satelliteFallback(
  address: string | null,
  estimate: SolarEstimate | null,
): Promise<Response> {
  const apiKey = process.env.GOOGLE_MAPS_API_KEY
  if (!apiKey) return Response.json({ ok: false, error: 'no_maps_key' }, { status: 503 })
  const center = estimate ? centerForSolarEstimate({ roof: estimate.roof }) : null
  if (!address && !center) return Response.json({ ok: false, error: 'no_location' }, { status: 400 })
  try {
    const target = buildStaticMapUrl(
      {
        address: center ? undefined : address ?? undefined,
        center: center ?? undefined,
        zoom: 20,
        size: { width: 640, height: 480 },
      },
      { apiKey },
    )
    const res = await fetch(target)
    if (!res.ok) return Response.json({ ok: false, error: `satellite ${res.status}` }, { status: 502 })
    const ct = res.headers.get('content-type') ?? 'image/png'
    return new Response(await res.arrayBuffer(), {
      status: 200,
      // Short cache — this is the fallback while the AI render finishes.
      headers: { 'Content-Type': ct, 'Cache-Control': 'public, max-age=60' },
    })
  } catch (e) {
    return Response.json({ ok: false, error: e instanceof Error ? e.message : String(e) }, { status: 502 })
  }
}

async function streamStored(path: string): Promise<Response | null> {
  const { data, error } = await supabase.storage.from('intake-photos').download(path)
  if (error || !data) return null
  const buf = Buffer.from(await data.arrayBuffer())
  return new Response(buf, {
    status: 200,
    headers: {
      'Content-Type': data.type || 'image/png',
      'Cache-Control': 'public, max-age=86400, immutable',
    },
  })
}

export async function GET(_req: Request, ctx: { params: Promise<{ token: string }> }) {
  const { token } = await ctx.params
  if (!token || token.length < 8) {
    return Response.json({ ok: false, error: 'bad_token' }, { status: 400 })
  }

  const { data: row } = await supabase
    .from('solar_estimates')
    .select('address, estimate, panels_image_path, panels_image_status, confirmed_at')
    .eq('public_token', token)
    .maybeSingle()
  if (!row) return Response.json({ ok: false, error: 'not_found' }, { status: 404 })

  const address = (row.address as string | null) ?? null
  const estimate = (row.estimate ?? null) as SolarEstimate | null

  // Already rendered → serve the cached image.
  if (row.panels_image_status === 'ready' && row.panels_image_path) {
    const stored = await streamStored(row.panels_image_path as string)
    if (stored) return stored
  }

  // Only spend a Gemini render once the tradie has confirmed (the page
  // only shows this image post-confirm anyway).
  if (!row.confirmed_at) return satelliteFallback(address, estimate)

  // Generate on demand (CAS-guarded). On success, serve it; otherwise fall
  // back to the plain satellite so the page never shows a broken image.
  const gen = await generateSolarPanelsImage(token)
  if (gen.ok) {
    const stored = await streamStored(gen.path)
    if (stored) return stored
  }
  return satelliteFallback(address, estimate)
}
