// POST /api/tenant/commercial-painting/extract — tenant-scoped (Bearer).
//
// Runs the AI takeoff for a paint run (spec §4): Opus over the plan set
// (+ services layout as access/masking context), Sonnet transcription of
// the painter's measurements doc when present, then the PURE reconciler
// merges the two with per-line source/delta provenance. Persists one
// plan_extractions row (trade='commercial_painting') and advances
// paint_runs.status draft → extracting → ready | failed.
//
// Synchronous with a 300 s ceiling — the proven electrical-estimator
// pattern (Opus over a 15-page set runs minutes; the tab shows staged
// progress and the run survives a tab close via run status polling).
//
// Body: { paintRunId: string }

import { tenantFromBearer, estimatorSupabase } from '@/lib/estimation/auth'
import { downloadPaintDoc } from '@/lib/commercial-painting/storage'
import {
  runPaintExtraction,
  runMeasurementParse,
} from '@/lib/commercial-painting/extract'
import { reconcileTakeoff } from '@/lib/commercial-painting/reconcile'
import type { MeasurementLine } from '@/lib/commercial-painting/types'

export const dynamic = 'force-dynamic'
export const maxDuration = 300

type UploadRow = {
  id: string
  filename: string
  doc_type: string | null
  pdf_path: string | null
}

export async function POST(req: Request) {
  const tenant = await tenantFromBearer(req)
  if (!tenant) return Response.json({ ok: false, error: 'unauthorised' }, { status: 401 })

  let body: { paintRunId?: string }
  try {
    body = await req.json()
  } catch {
    return Response.json({ ok: false, error: 'invalid_json' }, { status: 400 })
  }
  const paintRunId = body.paintRunId?.trim()
  if (!paintRunId) return Response.json({ ok: false, error: 'missing_paintRunId' }, { status: 400 })

  const { data: run } = await estimatorSupabase
    .from('paint_runs')
    .select('id, job_name, site_address, status')
    .eq('id', paintRunId)
    .eq('tenant_id', tenant.id)
    .maybeSingle()
  if (!run) return Response.json({ ok: false, error: 'run_not_found' }, { status: 404 })

  const { data: uploadRows } = await estimatorSupabase
    .from('plan_uploads')
    .select('id, filename, doc_type, pdf_path')
    .eq('paint_run_id', paintRunId)
    .eq('tenant_id', tenant.id)
  const uploads = (uploadRows ?? []) as UploadRow[]

  const planSet = uploads.find((u) => u.doc_type === 'plan_set' && u.pdf_path)
  if (!planSet) {
    return Response.json(
      { ok: false, error: 'plan_set_required', detail: 'Upload an architectural plan set (or correct a document’s type) before running the takeoff.' },
      { status: 422 },
    )
  }
  const measurementDoc = uploads.find((u) => u.doc_type === 'measurement_takeoff' && u.pdf_path)
  const servicesDoc = uploads.find((u) => u.doc_type === 'services_layout' && u.pdf_path)

  const setStatus = (status: string, note?: string | null) =>
    estimatorSupabase
      .from('paint_runs')
      .update({ status, status_note: note ?? null, updated_at: new Date().toISOString() })
      .eq('id', paintRunId)

  await setStatus('extracting')

  try {
    const planBytes = await downloadPaintDoc(planSet.pdf_path!)
    const servicesBytes = servicesDoc ? await downloadPaintDoc(servicesDoc.pdf_path!) : null

    const jobHint = [run.job_name, run.site_address].filter(Boolean).join(' — ') || undefined

    // Plan takeoff (Opus) and measurements transcription (Sonnet) are
    // independent — run them concurrently.
    const [extraction, measurements] = await Promise.all([
      runPaintExtraction({ planSet: planBytes, servicesLayout: servicesBytes, jobHint }),
      (async () => {
        if (!measurementDoc) return null
        const bytes = await downloadPaintDoc(measurementDoc.pdf_path!)
        return runMeasurementParse({ pdf: bytes })
      })(),
    ])

    if (!extraction.parsed || extraction.parsed.items.length === 0) {
      await setStatus('failed', `The model could not produce a takeoff from the plan set. ${extraction.raw.slice(0, 280)}`)
      return Response.json(
        { ok: false, error: 'extraction_unparseable', model: extraction.model },
        { status: 502 },
      )
    }

    const measurementLines: MeasurementLine[] = measurements?.lines ?? []
    const reconciled = reconcileTakeoff(extraction.parsed.items, measurementLines)

    const runtime = extraction.runtimeSeconds + (measurements?.runtimeSeconds ?? 0)
    const { data: extRow, error: extErr } = await estimatorSupabase
      .from('plan_extractions')
      .insert({
        plan_upload_id: planSet.id,
        tenant_id: tenant.id,
        trade: 'commercial_painting',
        paint_run_id: paintRunId,
        items: reconciled.items,
        sheets_used: {
          job: extraction.parsed.job,
          finishes_schedule: extraction.parsed.finishes_schedule,
          measurement_line_count: measurementLines.length,
          measurement_parse_failed: Boolean(measurementDoc && !measurements?.lines),
          flags: reconciled.flags,
        },
        overall_note: extraction.parsed.overall_note || null,
        model: extraction.model,
        runtime_seconds: Math.round(runtime * 100) / 100,
      })
      .select('id')
      .single()
    if (extErr || !extRow) {
      await setStatus('failed', extErr?.message ?? 'extraction insert failed')
      return Response.json(
        { ok: false, error: 'extraction_insert_failed', detail: extErr?.message ?? 'no row' },
        { status: 500 },
      )
    }

    // Backfill job facts the model read off the cover sheet.
    const jobUpdates: Record<string, string> = {}
    if (!run.job_name && extraction.parsed.job.name) jobUpdates.job_name = extraction.parsed.job.name
    if (!run.site_address && extraction.parsed.job.address) jobUpdates.site_address = extraction.parsed.job.address
    await estimatorSupabase
      .from('paint_runs')
      .update({ ...jobUpdates, status: 'ready', status_note: null, updated_at: new Date().toISOString() })
      .eq('id', paintRunId)

    return Response.json({
      ok: true,
      extractionId: extRow.id,
      items: reconciled.items,
      flags: reconciled.flags,
      finishesSchedule: extraction.parsed.finishes_schedule,
      job: extraction.parsed.job,
      overallNote: extraction.parsed.overall_note,
      measurementLineCount: measurementLines.length,
      measurementParseFailed: Boolean(measurementDoc && !measurements?.lines),
      model: extraction.model,
      runtimeSeconds: runtime,
    })
  } catch (e) {
    const detail = e instanceof Error ? e.message : String(e)
    await setStatus('failed', detail.slice(0, 300))
    return Response.json({ ok: false, error: 'extraction_failed', detail }, { status: 502 })
  }
}
