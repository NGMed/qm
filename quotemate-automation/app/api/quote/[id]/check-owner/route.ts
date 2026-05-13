// GET /api/quote/[id]/check-owner
//
// Lightweight authorisation probe used by the tradie-edit UI on the
// customer-facing quote page (/q/<token>). The UI mounts a client
// component on every quote page load that calls this endpoint with the
// caller's Supabase Bearer token; on success the "Edit quote" affordance
// renders. Visitors without a session, or signed-in tradies viewing
// someone else's quote, get { owner: false } and the edit panel stays
// hidden so the customer view is undisturbed.
//
// This endpoint does NOT expose the quote payload — it only confirms
// ownership. Editing happens via POST /api/quote/[id]/edit which does
// the same auth check before mutating.

import { createClient } from '@supabase/supabase-js'

export const dynamic = 'force-dynamic'

const supabase = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!,
)

export async function GET(
  req: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id: quoteId } = await params

  const auth = req.headers.get('authorization') ?? ''
  if (!auth.toLowerCase().startsWith('bearer ')) {
    return Response.json({ owner: false, reason: 'no_session' })
  }
  const token = auth.slice(7).trim()
  if (!token) return Response.json({ owner: false, reason: 'empty_bearer' })

  const { data: userData, error: userErr } = await supabase.auth.getUser(token)
  if (userErr || !userData.user) {
    return Response.json({ owner: false, reason: 'bad_token' })
  }
  const userId = userData.user.id

  // Pull the quote → tenant, then check whether `tenants.owner_user_id`
  // matches the caller. The single round trip keeps the latency of the
  // page-load owner check below 100ms.
  const { data: quote } = await supabase
    .from('quotes')
    .select('id, tenant_id, paid_at')
    .eq('id', quoteId)
    .maybeSingle()
  if (!quote) return Response.json({ owner: false, reason: 'no_quote' })
  if (!quote.tenant_id) {
    // Legacy pre-v6 quotes without tenant scoping — nobody "owns" them in
    // the multi-tenant sense. Refuse edit access.
    return Response.json({ owner: false, reason: 'unscoped_quote' })
  }

  const { data: tenant } = await supabase
    .from('tenants')
    .select('id, owner_user_id, business_name')
    .eq('id', quote.tenant_id)
    .maybeSingle()
  if (!tenant || tenant.owner_user_id !== userId) {
    return Response.json({ owner: false, reason: 'not_owner' })
  }

  return Response.json({
    owner: true,
    tenantBusinessName: tenant.business_name,
    paid: !!quote.paid_at,
  })
}
