// GET   /api/tenant/commercial-painting/run/[id] — full run detail:
//       paint_run + its uploads + the latest extraction (items,
//       corrected_items, flags, priced bom). The tab's resume/refresh
//       source of truth.
// PATCH — save the tradie's confirmed takeoff (corrected_items).
//       Clears priced_bom/priced_at: edits invalidate pricing (same
//       contract as the electrical estimator).

import { tenantFromBearer, estimatorSupabase } from '@/lib/estimation/auth'
import type { PaintTakeoffItem } from '@/lib/commercial-painting/types'
import { PAINT_SYSTEMS } from '@/lib/commercial-painting/types'

export const dynamic = 'force-dynamic'

async function loadRun(tenantId: string, runId: string) {
  const { data: run } = await estimatorSupabase
    .from('paint_runs')
    .select('id, job_name, site_address, status, status_note, created_at, updated_at')
    .eq('id', runId)
    .eq('tenant_id', tenantId)
    .maybeSingle()
  return run
}

export async function GET(req: Request, ctx: { params: Promise<{ id: string }> }) {
  const tenant = await tenantFromBearer(req)
  if (!tenant) return Response.json({ ok: false, error: 'unauthorised' }, { status: 401 })
  const { id } = await ctx.params

  const run = await loadRun(tenant.id, id)
  if (!run) return Response.json({ ok: false, error: 'not_found' }, { status: 404 })

  const [{ data: uploads }, { data: extractions }] = await Promise.all([
    estimatorSupabase
      .from('plan_uploads')
      .select('id, filename, doc_type, size_bytes, created_at')
      .eq('paint_run_id', id)
      .eq('tenant_id', tenant.id)
      .order('created_at', { ascending: true }),
    estimatorSupabase
      .from('plan_extractions')
      .select('id, items, corrected_items, sheets_used, overall_note, model, runtime_seconds, priced_bom, priced_at, created_at')
      .eq('paint_run_id', id)
      .eq('tenant_id', tenant.id)
      .order('created_at', { ascending: false })
      .limit(1),
  ])

  return Response.json({
    ok: true,
    run,
    uploads: uploads ?? [],
    extraction: extractions?.[0] ?? null,
  })
}

/** Tolerant server-side narrowing of submitted takeoff rows. */
function sanitiseItems(raw: unknown): PaintTakeoffItem[] | null {
  if (!Array.isArray(raw)) return null
  const items: PaintTakeoffItem[] = []
  for (const r0 of raw) {
    if (!r0 || typeof r0 !== 'object') continue
    const r = r0 as Record<string, unknown>
    const surface = typeof r.surface === 'string' ? r.surface.trim().slice(0, 200) : ''
    const quantity = typeof r.quantity === 'number' && Number.isFinite(r.quantity) ? r.quantity : NaN
    const system = PAINT_SYSTEMS.includes(r.system as never) ? (r.system as PaintTakeoffItem['system']) : null
    if (!surface || !system || !Number.isFinite(quantity) || quantity < 0) continue
    const coats = typeof r.coats === 'number' && r.coats >= 1 && r.coats <= 4 ? Math.round(r.coats) : 2
    const height = typeof r.height_m === 'number' && r.height_m > 0 && r.height_m < 30 ? r.height_m : undefined
    items.push({
      surface,
      room: typeof r.room === 'string' && r.room.trim() ? r.room.trim().slice(0, 120) : 'General',
      substrate: typeof r.substrate === 'string' && r.substrate.trim() ? r.substrate.trim().slice(0, 120) : 'unknown',
      system,
      unit: r.unit === 'item' ? 'item' : 'm2',
      quantity,
      coats,
      ...(height != null ? { height_m: height } : {}),
      confidence: r.confidence === 'high' || r.confidence === 'low' ? r.confidence : 'medium',
      source:
        r.source === 'measurements' || r.source === 'both' || r.source === 'manual'
          ? r.source
          : 'plan',
      ...(typeof r.delta_pct === 'number' && Number.isFinite(r.delta_pct) ? { delta_pct: r.delta_pct } : {}),
      ...(r.separate_price === true ? { separate_price: true } : {}),
      ...(r.excluded === true ? { excluded: true } : {}),
      ...(typeof r.note === 'string' && r.note.trim() ? { note: r.note.trim().slice(0, 400) } : {}),
    })
  }
  return items
}

export async function PATCH(req: Request, ctx: { params: Promise<{ id: string }> }) {
  const tenant = await tenantFromBearer(req)
  if (!tenant) return Response.json({ ok: false, error: 'unauthorised' }, { status: 401 })
  const { id } = await ctx.params

  const run = await loadRun(tenant.id, id)
  if (!run) return Response.json({ ok: false, error: 'not_found' }, { status: 404 })

  let body: { extractionId?: string; corrected_items?: unknown }
  try {
    body = await req.json()
  } catch {
    return Response.json({ ok: false, error: 'invalid_json' }, { status: 400 })
  }
  const extractionId = body.extractionId?.trim()
  if (!extractionId) return Response.json({ ok: false, error: 'missing_extractionId' }, { status: 400 })

  const items = sanitiseItems(body.corrected_items)
  if (!items || items.length === 0) {
    return Response.json({ ok: false, error: 'no_valid_items' }, { status: 400 })
  }

  const { data, error } = await estimatorSupabase
    .from('plan_extractions')
    .update({
      corrected_items: items,
      // Edits invalidate any prior pricing — re-price deterministically.
      priced_bom: null,
      priced_at: null,
      updated_at: new Date().toISOString(),
    })
    .eq('id', extractionId)
    .eq('paint_run_id', id)
    .eq('tenant_id', tenant.id)
    .select('id')
    .maybeSingle()
  if (error) return Response.json({ ok: false, error: error.message }, { status: 500 })
  if (!data) return Response.json({ ok: false, error: 'extraction_not_found' }, { status: 404 })

  // A confirmed-but-unpriced run is back to 'ready'.
  await estimatorSupabase
    .from('paint_runs')
    .update({ status: 'ready', updated_at: new Date().toISOString() })
    .eq('id', id)

  return Response.json({ ok: true, savedItems: items.length })
}
