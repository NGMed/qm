// /api/signage/studios
//   GET  → list this org's studios (for the manage-studios UI)
//   POST → add one real studio { name, address?, region?, state?, postcode?,
//          contact_phone?, contact_email? } (e.g. from address autocomplete)
//
// Auth: bearer → org. Service-role client; org-scoped in the app layer.

import { createClient } from '@supabase/supabase-js'
import { z } from 'zod'
import { orgFromBearer } from '@/lib/signage/org'

export const dynamic = 'force-dynamic'

const supabase = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!,
)

export async function GET(req: Request) {
  const ctx = await orgFromBearer(supabase, req)
  if (!ctx) return Response.json({ ok: false, error: 'unauthorized' }, { status: 401 })
  const { data, error } = await supabase
    .from('studios')
    .select('id, name, region, status, address, state, postcode')
    .eq('org_id', ctx.orgId)
    .order('region')
    .order('name')
  if (error) return Response.json({ ok: false, error: error.message }, { status: 500 })
  return Response.json({ ok: true, studios: data ?? [] })
}

const CreateStudioSchema = z.object({
  name: z.string().trim().min(1).max(120),
  address: z.string().trim().max(240).optional(),
  region: z.string().trim().max(60).optional(),
  state: z.string().trim().max(20).optional(),
  postcode: z.string().trim().max(12).optional(),
  contact_phone: z.string().trim().max(40).optional(),
  contact_email: z.string().trim().max(120).optional(),
})

export async function POST(req: Request) {
  const ctx = await orgFromBearer(supabase, req)
  if (!ctx) return Response.json({ ok: false, error: 'unauthorized' }, { status: 401 })

  let body: unknown
  try {
    body = await req.json()
  } catch {
    return Response.json({ ok: false, error: 'invalid_json' }, { status: 400 })
  }
  const parsed = CreateStudioSchema.safeParse(body)
  if (!parsed.success) {
    return Response.json({ ok: false, error: 'invalid_request', issues: parsed.error.issues }, { status: 400 })
  }
  const d = parsed.data
  const { data, error } = await supabase
    .from('studios')
    .insert({
      org_id: ctx.orgId,
      name: d.name,
      address: d.address ?? null,
      region: d.region ?? null,
      state: d.state ?? null,
      postcode: d.postcode ?? null,
      contact_phone: d.contact_phone ?? null,
      contact_email: d.contact_email ?? null,
      status: 'open',
    })
    .select('id, name, region, status, address, state, postcode')
    .single()
  if (error) return Response.json({ ok: false, error: error.message }, { status: 500 })
  return Response.json({ ok: true, studio: data })
}
