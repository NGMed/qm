// GET /api/tenant/commercial-painting/upload/[id]/file — stream a stored
// run document back to its owning tenant (Bearer-auth, tenant-scoped).
// Powers the in-tab plan viewer: the client fetches with an
// Authorization header, turns the blob into a File and feeds the shared
// PlanOverlay (PDFs) or an <img> (site photos).

import { tenantFromBearer, estimatorSupabase } from '@/lib/estimation/auth'
import { downloadPaintDoc } from '@/lib/commercial-painting/storage'

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

  let bytes: Buffer
  try {
    bytes = await downloadPaintDoc(upload.pdf_path as string)
  } catch (e) {
    return Response.json(
      { ok: false, error: 'download_failed', detail: e instanceof Error ? e.message : String(e) },
      { status: 502 },
    )
  }

  const ext = (upload.pdf_path as string).split('.').pop()?.toLowerCase() ?? ''
  const mime = MIME_BY_EXT[ext] ?? 'application/octet-stream'
  return new Response(new Uint8Array(bytes), {
    status: 200,
    headers: {
      'Content-Type': mime,
      'Content-Disposition': `inline; filename="${encodeURIComponent(String(upload.filename ?? 'document'))}"`,
      'Cache-Control': 'private, max-age=300',
    },
  })
}
