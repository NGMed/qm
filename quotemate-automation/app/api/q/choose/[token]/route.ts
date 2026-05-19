// WP9 — customer product-choice record API.
// Reached from the SMS link  {APP_URL}/q/choose/{token}  (and its
// page). Same trust model as /upload/[token]: the token is unguessable
// and scopes everything; no auth.
//
//   GET  → the two options + current status (for the page to render)
//   POST → record { catalogue_id } as the customer's pick (idempotent)
//
// Inert until WP9 is in use: a conversation only has product_choice
// once the (flag-gated) inbound route offers options.

import { createClient } from '@supabase/supabase-js'
import {
  applyChoiceSelection,
  type ProductChoiceState,
} from '@/lib/sms/product-options'

export const dynamic = 'force-dynamic'

const supabase = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!,
)

async function loadByToken(token: string) {
  const { data } = await supabase
    .from('sms_conversations')
    .select('id, product_choice')
    .eq('product_choice->>token', token)
    .maybeSingle()
  if (!data || !data.product_choice) return null
  return {
    id: data.id as string,
    choice: data.product_choice as ProductChoiceState,
  }
}

export async function GET(
  _req: Request,
  ctx: { params: Promise<{ token: string }> },
) {
  const { token } = await ctx.params
  const row = await loadByToken(token)
  if (!row) return Response.json({ error: 'not_found' }, { status: 404 })
  const c = row.choice
  return Response.json({
    ok: true,
    category: c.category,
    status: c.status,
    chosen_catalogue_id: c.chosen_catalogue_id ?? null,
    options: (c.options ?? []).map((o) => ({
      catalogue_id: o.catalogue_id,
      name: o.name,
      brand: o.brand,
      range_series: o.range_series,
      price_ex_gst: o.price_ex_gst,
      image_path: o.image_path,
      description: o.description,
      tier: o.tier,
    })),
  })
}

export async function POST(
  req: Request,
  ctx: { params: Promise<{ token: string }> },
) {
  const { token } = await ctx.params
  let body: { catalogue_id?: string } = {}
  try {
    body = (await req.json()) as { catalogue_id?: string }
  } catch {
    return Response.json({ error: 'invalid_json' }, { status: 400 })
  }
  const row = await loadByToken(token)
  if (!row) return Response.json({ error: 'not_found' }, { status: 404 })

  const next = applyChoiceSelection(row.choice, {
    catalogueId: body.catalogue_id ?? null,
  })
  if (!next) {
    return Response.json({ error: 'invalid_choice' }, { status: 400 })
  }

  // Idempotent: persist only when something actually changed.
  if (next !== row.choice) {
    const { error } = await supabase
      .from('sms_conversations')
      .update({ product_choice: next, updated_at: new Date().toISOString() })
      .eq('id', row.id)
    if (error) {
      return Response.json({ error: error.message }, { status: 500 })
    }
  }

  return Response.json({
    ok: true,
    status: next.status,
    chosen_catalogue_id: next.chosen_catalogue_id ?? null,
    chosen_name: next.chosen_name ?? null,
  })
}
