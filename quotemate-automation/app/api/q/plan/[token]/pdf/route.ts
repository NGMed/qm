// GET /api/q/plan/[token]/pdf — download the Gotenberg-rendered take-off
// report for a shared plan extraction. Token = plan_extractions.share_token
// (unguessable, same trust model as /q/[token]). Streams the stored PDF from
// the private plan-pdfs bucket so the download URL is stable — no signed-URL
// expiry in customer hands.

import { createClient } from '@supabase/supabase-js'

export const dynamic = 'force-dynamic'
export const runtime = 'nodejs'

const supabase = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!,
)

export async function GET(_req: Request, ctx: { params: Promise<{ token: string }> }) {
  const { token } = await ctx.params

  const { data: extraction } = await supabase
    .from('plan_extractions')
    .select('id, report_pdf_path, plan_uploads(filename)')
    .eq('share_token', token)
    .maybeSingle()

  if (!extraction) {
    return Response.json({ ok: false, error: 'Invalid or expired link' }, { status: 404 })
  }
  if (!extraction.report_pdf_path) {
    return Response.json({ ok: false, error: 'No PDF report for this run yet' }, { status: 404 })
  }

  const { data: blob, error } = await supabase.storage
    .from('plan-pdfs')
    .download(extraction.report_pdf_path as string)
  if (error || !blob) {
    console.error('[q/plan/pdf] storage download failed', error?.message)
    return Response.json({ ok: false, error: 'Report unavailable' }, { status: 500 })
  }

  const sourceName = (extraction.plan_uploads as { filename?: string } | null)?.filename ?? 'plan'
  const downloadName = `take-off-${sourceName.replace(/\.pdf$/i, '').replace(/[^a-zA-Z0-9_-]+/g, '-').slice(0, 60) || 'report'}.pdf`

  return new Response(blob.stream(), {
    status: 200,
    headers: {
      'Content-Type': 'application/pdf',
      'Content-Disposition': `attachment; filename="${downloadName}"`,
      'Cache-Control': 'private, max-age=300',
    },
  })
}
