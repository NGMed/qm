// PATCH /api/tenant/commercial-painting/upload/[id] — correct a document's
// auto-classification (spec §3: the user can correct; nothing is rejected).
// DELETE removes a document from its run (row only; storage objects are
// cleaned up with the run's natural lifecycle).

import { tenantFromBearer, estimatorSupabase } from '@/lib/estimation/auth'
import { PAINT_DOC_TYPES, type PaintDocType } from '@/lib/commercial-painting/types'

export const dynamic = 'force-dynamic'

export async function PATCH(req: Request, ctx: { params: Promise<{ id: string }> }) {
  const tenant = await tenantFromBearer(req)
  if (!tenant) return Response.json({ ok: false, error: 'unauthorised' }, { status: 401 })
  const { id } = await ctx.params

  let body: { doc_type?: string }
  try {
    body = await req.json()
  } catch {
    return Response.json({ ok: false, error: 'invalid_json' }, { status: 400 })
  }
  const docType = body.doc_type as PaintDocType | undefined
  if (!docType || !PAINT_DOC_TYPES.includes(docType)) {
    return Response.json({ ok: false, error: 'invalid_doc_type', allowed: PAINT_DOC_TYPES }, { status: 400 })
  }

  const { data, error } = await estimatorSupabase
    .from('plan_uploads')
    .update({ doc_type: docType })
    .eq('id', id)
    .eq('tenant_id', tenant.id)
    .eq('trade', 'commercial_painting')
    .select('id, doc_type')
    .maybeSingle()
  if (error) return Response.json({ ok: false, error: error.message }, { status: 500 })
  if (!data) return Response.json({ ok: false, error: 'not_found' }, { status: 404 })

  return Response.json({ ok: true, id: data.id, doc_type: data.doc_type })
}

export async function DELETE(req: Request, ctx: { params: Promise<{ id: string }> }) {
  const tenant = await tenantFromBearer(req)
  if (!tenant) return Response.json({ ok: false, error: 'unauthorised' }, { status: 401 })
  const { id } = await ctx.params

  const { data, error } = await estimatorSupabase
    .from('plan_uploads')
    .delete()
    .eq('id', id)
    .eq('tenant_id', tenant.id)
    .eq('trade', 'commercial_painting')
    .select('id')
    .maybeSingle()
  if (error) return Response.json({ ok: false, error: error.message }, { status: 500 })
  if (!data) return Response.json({ ok: false, error: 'not_found' }, { status: 404 })

  return Response.json({ ok: true })
}
