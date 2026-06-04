// GET /api/signage/street-view?address=&state=&postcode= — streams a Google
// Street View photo of a studio's storefront (the storefront-shot supplement).
// Reuses lib/painting/streetview so GOOGLE_MAPS_API_KEY stays server-side.
// HQ-authed (org bearer).

import { createClient } from '@supabase/supabase-js'
import { orgFromBearer } from '@/lib/signage/org'
import { buildStreetViewUrl } from '@/lib/painting/streetview'

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

  const url = new URL(req.url)
  const location = [
    (url.searchParams.get('address') ?? '').trim(),
    (url.searchParams.get('postcode') ?? '').trim(),
    (url.searchParams.get('state') ?? '').trim(),
  ]
    .filter(Boolean)
    .join(', ')
  if (location.length < 3) return Response.json({ ok: false, code: 'no_address' }, { status: 400 })

  try {
    const res = await fetch(buildStreetViewUrl({ location }, { apiKey }))
    if (!res.ok) return Response.json({ ok: false, code: 'no_streetview' }, { status: 404 })
    const bytes = await res.arrayBuffer()
    return new Response(bytes, {
      status: 200,
      headers: {
        'Content-Type': res.headers.get('content-type') ?? 'image/jpeg',
        'Cache-Control': 'private, max-age=86400',
      },
    })
  } catch (e) {
    return Response.json({ ok: false, code: 'provider_error', detail: e instanceof Error ? e.message : String(e) }, { status: 200 })
  }
}
