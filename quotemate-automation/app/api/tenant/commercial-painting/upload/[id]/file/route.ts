// GET /api/tenant/commercial-painting/upload/[id]/file — hand the owning
// tenant a short-lived signed storage URL for a stored run document
// (Bearer-auth, tenant-scoped). The bytes never pass through this
// function: Vercel caps function responses at ~4.5 MB, which a plan set
// routinely exceeds. The client fetches the signed URL directly and
// feeds the shared PlanOverlay (PDFs) or an <img> (site photos).

import { tenantFromBearer, estimatorSupabase } from '@/lib/estimation/auth'
import { createPaintDocSignedDownload } from '@/lib/commercial-painting/storage'

export const dynamic = 'force-dynamic'
export const maxDuration = 60

const MIME_BY_EXT: Record<string, string> = {
  pdf: 'application/pdf',
  png: 'image/png',
  jpg: 'image/jpeg',
  webp: 'image/webp',
}

export async function GET(req: Request, ctx: { params: Promise<{ id: string }> }) {
  const tenant = await tenantFromBearer(req)
  if (!tenant) return Response.json({ ok: false, error: 'unauthorised' }, { status: 401 })
  const { id } = await ctx.params

  const { data: upload } = await estimatorSupabase
    .from('plan_uploads')
    .select('id, filename, pdf_path')
    .eq('id', id)
    .eq('tenant_id', tenant.id)
    .eq('trade', 'commercial_painting')
    .maybeSingle()
  if (!upload?.pdf_path) return Response.json({ ok: false, error: 'not_found' }, { status: 404 })

  let url: string
  try {
    url = await createPaintDocSignedDownload(upload.pdf_path as string)
  } catch (e) {
    return Response.json(
      { ok: false, error: 'sign_failed', detail: e instanceof Error ? e.message : String(e) },
      { status: 502 },
    )
  }

  const ext = (upload.pdf_path as string).split('.').pop()?.toLowerCase() ?? ''
  return Response.json(
    {
      ok: true,
      url,
      filename: upload.filename ?? 'document',
      mime: MIME_BY_EXT[ext] ?? 'application/octet-stream',
    },
    { status: 200, headers: { 'Cache-Control': 'no-store' } },
  )
}
