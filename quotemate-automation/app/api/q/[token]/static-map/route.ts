// GET /api/q/[token]/static-map — public-share-token-gated Google Maps
// Static proxy for the customer-facing /q/[token] page. The /api/roofing/
// static-map route requires a Supabase bearer token; this one accepts an
// unguessable share_token from the URL path, the same auth model the
// existing customer quote page uses.

import { createClient } from '@supabase/supabase-js'
import { buildStaticMapUrl, type StaticMapInput } from '@/lib/roofing/google-maps'

export const dynamic = 'force-dynamic'

const supabase = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!,
)

type Marker = NonNullable<StaticMapInput['markers']>[number]

function parseMarkers(raw: string | null): Marker[] | undefined {
  if (!raw) return undefined
  const out: Marker[] = []
  for (const seg of raw.split(';').map((s) => s.trim()).filter(Boolean)) {
    const [lat, lng, color] = seg.split(',')
    const fLat = Number(lat)
    const fLng = Number(lng)
    if (!Number.isFinite(fLat) || !Number.isFinite(fLng)) continue
    const c = color?.trim()
    out.push(c ? { lat: fLat, lng: fLng, color: c } : { lat: fLat, lng: fLng })
  }
  return out
}

export async function GET(
  req: Request,
  ctx: { params: Promise<{ token: string }> },
) {
  const { token } = await ctx.params
  if (!token || token.length < 8) {
    return Response.json({ ok: false, error: 'bad_token' }, { status: 400 })
  }

  // Resolve the share token — confirm a quote exists for this token.
  // We don't validate intake.trade here; the customer-side hero only
  // renders when the page already knows it's a roofing quote, so any
  // share_token that maps to a valid quote can request its own map.
  const { data: quote, error: qErr } = await supabase
    .from('quotes')
    .select('id')
    .eq('share_token', token)
    .maybeSingle()
  if (qErr || !quote) {
    return Response.json({ ok: false, error: 'not_found' }, { status: 404 })
  }

  const apiKey = process.env.GOOGLE_MAPS_API_KEY
  if (!apiKey) {
    return Response.json(
      { ok: false, error: 'GOOGLE_MAPS_API_KEY not set on the server' },
      { status: 503 },
    )
  }

  const url = new URL(req.url)
  const address = url.searchParams.get('address') ?? undefined
  const latRaw = url.searchParams.get('lat')
  const lngRaw = url.searchParams.get('lng')
  const center =
    latRaw && lngRaw && Number.isFinite(Number(latRaw)) && Number.isFinite(Number(lngRaw))
      ? { lat: Number(latRaw), lng: Number(lngRaw) }
      : undefined
  if (!address && !center) {
    return Response.json(
      { ok: false, error: 'address or lat+lng is required' },
      { status: 400 },
    )
  }

  const zoom = url.searchParams.get('zoom') ? Number(url.searchParams.get('zoom')) : undefined
  const w = url.searchParams.get('w') ? Number(url.searchParams.get('w')) : undefined
  const h = url.searchParams.get('h') ? Number(url.searchParams.get('h')) : undefined
  const markers = parseMarkers(url.searchParams.get('markers'))

  let target: string
  try {
    target = buildStaticMapUrl(
      {
        address,
        center,
        zoom,
        size: w && h ? { width: w, height: h } : undefined,
        markers,
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
    try {
      body = (await res.text()).slice(0, 500)
    } catch {
      /* ignore */
    }
    return Response.json(
      { ok: false, error: `Google Maps Static returned ${res.status}`, upstreamBody: body },
      { status: 502 },
    )
  }
  const ct = res.headers.get('content-type') ?? 'image/png'
  const arrayBuffer = await res.arrayBuffer()
  return new Response(arrayBuffer, {
    status: 200,
    headers: {
      'Content-Type': ct,
      'Cache-Control': 'public, max-age=86400, immutable',
    },
  })
}
