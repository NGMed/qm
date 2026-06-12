// PATCH /api/tenant/commercial-painting/upload/[id] — correct a document's
// auto-classification (spec §3: the user can correct; nothing is rejected).
// DELETE removes a document from its run. GUARD: plan_extractions rows
// reference their plan_set upload with ON DELETE CASCADE (migration 099),
// so deleting an extracted-from document would silently destroy the
// takeoff, the tradie's corrections AND the priced BOM — that delete is
// refused with 409 'has_extraction' (start a new run instead). The
// stored file is removed from the plan-pdfs bucket alongside the row.

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

  // Cascade guard: refuse to delete a document an extraction hangs off.
  const { data: dependent } = await estimatorSupabase
    .from('plan_extractions')
    .select('id')
    .eq('plan_upload_id', id)
    .eq('tenant_id', tenant.id)
    .limit(1)
    .maybeSingle()
  if (dependent) {
    return Response.json(
      {
        ok: false,
        error: 'has_extraction',
        detail:
          'This document is the source of the run’s takeoff — deleting it would destroy the takeoff and any pricing. Start a new run instead.',
      },
      { status: 409 },
    )
  }

  const { data, error } = await estimatorSupabase
    .from('plan_uploads')
    .delete()
    .eq('id', id)
    .eq('tenant_id', tenant.id)
    .eq('trade', 'commercial_painting')
    .select('id, pdf_path')
    .maybeSingle()
  if (error) return Response.json({ ok: false, error: error.message }, { status: 500 })
  if (!data) return Response.json({ ok: false, error: 'not_found' }, { status: 404 })

  // Best-effort storage cleanup while the path is still known — without
  // this the object is orphaned forever (no other lifecycle exists).
  if (data.pdf_path) {
    await estimatorSupabase.storage
      .from('plan-pdfs')
      .remove([data.pdf_path as string])
      .catch(() => {})
  }

  return Response.json({ ok: true })
}
