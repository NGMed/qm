// POST /api/tenant/commercial-painting/upload — tenant-scoped (Bearer).
//
// Multi-file intake for a commercial painting run (spec §3). Accepts
// PDFs + images (≤32 MB each), creates (or appends to) a paint_run,
// stores every file in the plan-pdfs bucket, and auto-classifies each
// document (Sonnet vision over the first page; filename heuristics as
// the never-blocking fallback). Nothing is rejected — unknown documents
// land as doc_type 'other' and the tradie corrects in the UI.
//
// Multipart fields:
//   files       — one or more File entries (at least one)
//   job_name    — optional text
//   site_address— optional text
//   paint_run_id— optional uuid (append to an existing draft run)

import { tenantFromBearer, estimatorSupabase } from '@/lib/estimation/auth'
import { classifyPaintDoc } from '@/lib/commercial-painting/classify'
import { uploadPaintDoc } from '@/lib/commercial-painting/storage'
import { rasterizePage, cropToPng } from '@/lib/estimation/refine'

export const dynamic = 'force-dynamic'
// Classification is one fast Sonnet call per file; uploads dominate.
export const maxDuration = 120

const MAX_FILE_BYTES = 32 * 1024 * 1024
const MAX_FILES = 12
const ACCEPTED_MIME = new Set([
  'application/pdf',
  'image/png',
  'image/jpeg',
  'image/webp',
])

/** First page of a PDF (or the image itself) as PNG/JPEG bytes for vision. */
async function firstPageImage(
  mime: string,
  bytes: Buffer,
): Promise<{ data: Buffer; mediaType: 'image/png' | 'image/jpeg' } | null> {
  try {
    if (mime === 'image/png') return { data: bytes, mediaType: 'image/png' }
    if (mime === 'image/jpeg') return { data: bytes, mediaType: 'image/jpeg' }
    if (mime === 'application/pdf') {
      // Modest resolution — classification needs layout, not symbols.
      const raster = await rasterizePage(bytes, 1, 1200)
      const png = await cropToPng(raster, { x: 0, y: 0, w: raster.widthPx, h: raster.heightPx })
      return { data: png, mediaType: 'image/png' }
    }
  } catch {
    // Rasterisation failure must never block an upload.
  }
  return null
}

export async function POST(req: Request) {
  const tenant = await tenantFromBearer(req)
  if (!tenant) return Response.json({ ok: false, error: 'unauthorised' }, { status: 401 })

  let form: FormData
  try {
    form = await req.formData()
  } catch {
    return Response.json({ ok: false, error: 'invalid_multipart' }, { status: 400 })
  }

  const files = form.getAll('files').filter((f): f is File => f instanceof File)
  if (files.length === 0) {
    return Response.json({ ok: false, error: 'no_files' }, { status: 400 })
  }
  if (files.length > MAX_FILES) {
    return Response.json({ ok: false, error: 'too_many_files', max: MAX_FILES }, { status: 400 })
  }
  for (const f of files) {
    if (f.size > MAX_FILE_BYTES) {
      return Response.json(
        { ok: false, error: 'file_too_large', filename: f.name, maxMb: 32 },
        { status: 400 },
      )
    }
    if (!ACCEPTED_MIME.has(f.type)) {
      return Response.json(
        { ok: false, error: 'unsupported_type', filename: f.name, type: f.type },
        { status: 400 },
      )
    }
  }

  const jobName = String(form.get('job_name') ?? '').trim() || null
  const siteAddress = String(form.get('site_address') ?? '').trim() || null
  const existingRunId = String(form.get('paint_run_id') ?? '').trim() || null

  // ── Resolve or create the run (tenant-scoped). ────────────────────
  let runId: string
  if (existingRunId) {
    const { data: run } = await estimatorSupabase
      .from('paint_runs')
      .select('id')
      .eq('id', existingRunId)
      .eq('tenant_id', tenant.id)
      .maybeSingle()
    if (!run) return Response.json({ ok: false, error: 'run_not_found' }, { status: 404 })
    runId = run.id as string
    if (jobName || siteAddress) {
      await estimatorSupabase
        .from('paint_runs')
        .update({
          ...(jobName ? { job_name: jobName } : {}),
          ...(siteAddress ? { site_address: siteAddress } : {}),
          updated_at: new Date().toISOString(),
        })
        .eq('id', runId)
    }
  } else {
    const { data: run, error } = await estimatorSupabase
      .from('paint_runs')
      .insert({ tenant_id: tenant.id, job_name: jobName, site_address: siteAddress, status: 'draft' })
      .select('id')
      .single()
    if (error || !run) {
      return Response.json(
        { ok: false, error: 'run_insert_failed', detail: error?.message ?? 'no row' },
        { status: 500 },
      )
    }
    runId = run.id as string
  }

  // ── Store + classify each file. ───────────────────────────────────
  const uploads: Array<{
    id: string
    filename: string
    doc_type: string
    classification_via: string
    classification_reason: string
    size_bytes: number
  }> = []

  for (const file of files) {
    const bytes = Buffer.from(await file.arrayBuffer())
    const uploadId = crypto.randomUUID()
    const pdfPath = await uploadPaintDoc({ runId, uploadId, mime: file.type, data: bytes })

    const image = await firstPageImage(file.type, bytes)
    const cls = await classifyPaintDoc({ filename: file.name, firstPageImage: image })

    const { error: insErr } = await estimatorSupabase.from('plan_uploads').insert({
      id: uploadId,
      tenant_id: tenant.id,
      filename: file.name.slice(0, 300),
      size_bytes: file.size,
      trade: 'commercial_painting',
      doc_type: cls.doc_type,
      paint_run_id: runId,
      pdf_path: pdfPath,
      source: 'dashboard',
    })
    if (insErr) {
      return Response.json(
        { ok: false, error: 'upload_insert_failed', detail: insErr.message },
        { status: 500 },
      )
    }
    uploads.push({
      id: uploadId,
      filename: file.name,
      doc_type: cls.doc_type,
      classification_via: cls.via,
      classification_reason: cls.reason,
      size_bytes: file.size,
    })
  }

  return Response.json({ ok: true, paintRunId: runId, uploads }, { status: 200 })
}
