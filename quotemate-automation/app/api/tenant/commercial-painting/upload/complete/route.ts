// POST /api/tenant/commercial-painting/upload/complete — tenant-scoped (Bearer).
//
// Step 3 of the two-step upload flow (see ./sign/route.ts): the browser
// has already PUT every file straight to Supabase Storage via signed
// URLs, so this route pulls each document back from storage, verifies
// it, auto-classifies it (Sonnet vision over the first page; filename
// heuristics as the never-blocking fallback) and registers the
// plan_uploads rows. Nothing is rejected — unknown documents land as
// doc_type 'other' and the tradie corrects in the UI.
//
// JSON body:
//   paintRunId — uuid from /upload/sign
//   files      — [{ uploadId, name, size, type }]

import { tenantFromBearer, estimatorSupabase } from '@/lib/estimation/auth'
import { classifyPaintDoc } from '@/lib/commercial-painting/classify'
import {
  ACCEPTED_MIME,
  MAX_FILE_BYTES,
  MAX_FILES,
  paintDocPath,
  downloadPaintDoc,
} from '@/lib/commercial-painting/storage'
import { rasterizePage, cropToPng } from '@/lib/estimation/refine'

export const dynamic = 'force-dynamic'
// Classification is one fast Sonnet call per file; downloads dominate.
export const maxDuration = 120

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

type FileMeta = { uploadId: string; name: string; size: number; type: string }

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

  let body: { paintRunId?: unknown; files?: unknown }
  try {
    body = await req.json()
  } catch {
    return Response.json({ ok: false, error: 'invalid_json' }, { status: 400 })
  }

  const runId = String(body.paintRunId ?? '').trim()
  if (!UUID_RE.test(runId)) {
    return Response.json({ ok: false, error: 'invalid_run_id' }, { status: 400 })
  }

  const rawFiles = Array.isArray(body.files) ? body.files : []
  const files: FileMeta[] = rawFiles.filter(
    (f): f is FileMeta =>
      !!f &&
      typeof f === 'object' &&
      typeof (f as FileMeta).uploadId === 'string' &&
      UUID_RE.test((f as FileMeta).uploadId) &&
      typeof (f as FileMeta).name === 'string' &&
      typeof (f as FileMeta).size === 'number' &&
      typeof (f as FileMeta).type === 'string' &&
      ACCEPTED_MIME.has((f as FileMeta).type),
  )
  if (files.length === 0) {
    return Response.json({ ok: false, error: 'no_files' }, { status: 400 })
  }
  if (files.length > MAX_FILES) {
    return Response.json({ ok: false, error: 'too_many_files', max: MAX_FILES }, { status: 400 })
  }

  // The run must belong to this tenant — the recomputed storage path is
  // scoped to it, so nothing outside the run prefix can be registered.
  const { data: run } = await estimatorSupabase
    .from('paint_runs')
    .select('id')
    .eq('id', runId)
    .eq('tenant_id', tenant.id)
    .maybeSingle()
  if (!run) return Response.json({ ok: false, error: 'run_not_found' }, { status: 404 })

  // ── Verify + classify each stored file. ───────────────────────────
  const uploads: Array<{
    id: string
    filename: string
    doc_type: string
    classification_via: string
    classification_reason: string
    size_bytes: number
  }> = []

  for (const file of files) {
    const pdfPath = paintDocPath(runId, file.uploadId, file.type)
    let bytes: Buffer
    try {
      bytes = await downloadPaintDoc(pdfPath)
    } catch {
      return Response.json(
        { ok: false, error: 'file_missing', filename: file.name },
        { status: 400 },
      )
    }
    if (bytes.length > MAX_FILE_BYTES) {
      return Response.json(
        { ok: false, error: 'file_too_large', filename: file.name, maxMb: 32 },
        { status: 400 },
      )
    }

    const image = await firstPageImage(file.type, bytes)
    const cls = await classifyPaintDoc({ filename: file.name, firstPageImage: image })

    const { error: insErr } = await estimatorSupabase.from('plan_uploads').insert({
      id: file.uploadId,
      tenant_id: tenant.id,
      filename: file.name.slice(0, 300),
      size_bytes: bytes.length,
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
      id: file.uploadId,
      filename: file.name,
      doc_type: cls.doc_type,
      classification_via: cls.via,
      classification_reason: cls.reason,
      size_bytes: bytes.length,
    })
  }

  return Response.json({ ok: true, paintRunId: runId, uploads }, { status: 200 })
}
