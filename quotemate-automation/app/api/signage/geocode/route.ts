// GET /api/signage/geocode?address=... — address -> { lat, lng,
// formatted_address } via the Google Geocoding API, so the add-studio form
// can show a live map preview before saving. HQ-authed; key stays server-side.

import { createClient } from '@supabase/supabase-js'
import { orgFromBearer } from '@/lib/signage/org'
import { buildGeocodeUrl, parseGeocode } from '@/lib/signage/maps'

export const dynamic = 'force-dynamic'

const supabase = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!,
)

export async function GET(req: Request) {
  const ctx = await orgFromBearer(supabase, req)
  if (!ctx) return Response.json({ ok: false, error: 'unauthorized' }, { status: 401 })

  const apiKey = process.env.GOOGLE_MAPS_API_KEY
  if (!apiKey) return Response.json({ ok: false, code: 'maps_key_missing' }, { status: 200 })

  const address = (new URL(req.url).searchParams.get('address') ?? '').trim()
  if (address.length < 4) return Response.json({ ok: false, code: 'no_address' }, { status: 400 })

  try {
    const g = parseGeocode(await (await fetch(buildGeocodeUrl(address, apiKey))).json())
    if (!g) return Response.json({ ok: false, code: 'not_found' }, { status: 200 })
    return Response.json({ ok: true, lat: g.lat, lng: g.lng, formatted_address: g.formatted_address, place_id: g.place_id })
  } catch (e) {
    return Response.json({ ok: false, code: 'provider_error', detail: e instanceof Error ? e.message : String(e) }, { status: 200 })
  }
}
