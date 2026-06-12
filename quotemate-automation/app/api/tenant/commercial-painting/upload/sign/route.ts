// POST /api/tenant/commercial-painting/upload/sign — tenant-scoped (Bearer).
//
// Step 1 of the two-step upload flow (spec §3). Vercel rejects function
// request bodies over ~4.5 MB with a 413, so plan sets can't be POSTed
// through the API as multipart. Instead the browser:
//   1. POSTs file metadata here → gets a paint_run + one signed Supabase
//      Storage upload URL per file,
//   2. PUTs each file straight to storage,
//   3. POSTs /upload/complete to classify + register the documents.
//
// JSON body:
//   files        — [{ name, size, type }] (at least one)
//   job_name     — optional text
//   site_address — optional text
//   paint_run_id — optional uuid (append to an existing draft run)

import { tenantFromBearer, estimatorSupabase } from '@/lib/estimation/auth'
import {
  ACCEPTED_MIME,
  MAX_FILE_BYTES,
  MAX_FILES,
  createPaintDocSignedUpload,
} from '@/lib/commercial-painting/storage'

export const dynamic = 'force-dynamic'
export const maxDuration = 60

type FileMeta = { name: string; size: number; type: string }

export async function POST(req: Request) {
  const tenant = await tenantFromBearer(req)
  if (!tenant) return Response.json({ ok: false, error: 'unauthorised' }, { status: 401 })

  let body: {
    files?: unknown
    job_name?: unknown
    site_address?: unknown
    paint_run_id?: unknown
  }
  try {
    body = await req.json()
  } catch {
    return Response.json({ ok: false, error: 'invalid_json' }, { status: 400 })
  }

  const rawFiles = Array.isArray(body.files) ? body.files : []
  const files: FileMeta[] = rawFiles
    .filter(
      (f): f is FileMeta =>
        !!f &&
        typeof f === 'object' &&
        typeof (f as FileMeta).name === 'string' &&
        typeof (f as FileMeta).size === 'number' &&
        typeof (f as FileMeta).type === 'string',
    )
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

  const jobName = String(body.job_name ?? '').trim() || null
  const siteAddress = String(body.site_address ?? '').trim() || null
  const existingRunId = String(body.paint_run_id ?? '').trim() || null

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

  // ── One signed upload target per file. ────────────────────────────
  const uploads: Array<{ uploadId: string; filename: string; signedUrl: string }> = []
  for (const f of files) {
    const uploadId = crypto.randomUUID()
    try {
      const target = await createPaintDocSignedUpload({ runId, uploadId, mime: f.type })
      uploads.push({ uploadId, filename: f.name, signedUrl: target.signedUrl })
    } catch (e) {
      return Response.json(
        { ok: false, error: 'sign_failed', detail: e instanceof Error ? e.message : String(e) },
        { status: 502 },
      )
    }
  }

  return Response.json({ ok: true, paintRunId: runId, uploads }, { status: 200 })
}
