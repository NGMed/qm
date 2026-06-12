// POST /api/tenant/commercial-painting/save-quote — tenant-scoped.
//
// Turns a PRICED run into a real quote record: intakes
// (trade='commercial_painting') + quotes (single tender wrapped into the
// established tier shape, share_token) and a tender PDF rendered via the
// existing Gotenberg pattern into the quote-pdfs bucket at
// quotes/<quoteId>.pdf — the path /api/q/[token]/pdf already serves.
// PDF generation is best-effort: the quote stands without it.
//
// Body: { paintRunId: string, extractionId: string }

import { createClient } from '@supabase/supabase-js'
import { tenantFromBearer, estimatorSupabase } from '@/lib/estimation/auth'
import { buildPaintQuotePayloads } from '@/lib/commercial-painting/save-quote-helpers'
import { buildPaintTenderReportHtml } from '@/lib/commercial-painting/report-html'
import { gotenbergConfigured, renderPdfFromHtml } from '@/lib/pdf/gotenberg'
import { generateShareToken } from '@/lib/stripe/checkout'
import { pipelineLog } from '@/lib/log/pipeline'
import type { PricedPaintBom } from '@/lib/commercial-painting/types'

export const dynamic = 'force-dynamic'
export const maxDuration = 90

const storage = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!,
  { auth: { persistSession: false } },
)

export async function POST(req: Request) {
  const tenant = await tenantFromBearer(req)
  if (!tenant) return Response.json({ ok: false, error: 'unauthorised' }, { status: 401 })

  let body: { paintRunId?: string; extractionId?: string }
  try {
    body = await req.json()
  } catch {
    return Response.json({ ok: false, error: 'invalid_json' }, { status: 400 })
  }
  const paintRunId = body.paintRunId?.trim()
  const extractionId = body.extractionId?.trim()
  if (!paintRunId || !extractionId) {
    return Response.json({ ok: false, error: 'missing_ids' }, { status: 400 })
  }

  const [{ data: run }, { data: ext }] = await Promise.all([
    estimatorSupabase
      .from('paint_runs')
      .select('id, job_name, site_address')
      .eq('id', paintRunId)
      .eq('tenant_id', tenant.id)
      .maybeSingle(),
    estimatorSupabase
      .from('plan_extractions')
      .select('id, priced_bom, priced_at, sheets_used')
      .eq('id', extractionId)
      .eq('paint_run_id', paintRunId)
      .eq('tenant_id', tenant.id)
      .maybeSingle(),
  ])
  if (!run) return Response.json({ ok: false, error: 'run_not_found' }, { status: 404 })
  const bom = (ext?.priced_bom ?? null) as PricedPaintBom | null
  if (!bom) {
    return Response.json(
      { ok: false, error: 'not_priced', detail: 'Price the confirmed takeoff before saving a quote.' },
      { status: 422 },
    )
  }

  const appUrl = process.env.APP_URL ?? 'https://quote-mate-rho.vercel.app'

  // ── Idempotency: one quote per pricing pass. Re-saving the same
  // priced_at returns the existing quote instead of minting duplicate
  // rows + share tokens; a re-price (new priced_at) allows a new quote.
  const sheets = (ext?.sheets_used ?? {}) as Record<string, unknown> & {
    saved_quote?: { quote_id: string; share_token: string; priced_at: string; pdf_ready?: boolean }
  }
  if (sheets.saved_quote && sheets.saved_quote.priced_at === ext?.priced_at) {
    const prior = sheets.saved_quote
    return Response.json({
      ok: true,
      quoteId: prior.quote_id,
      shareToken: prior.share_token,
      // Relative — the dashboard opens these on whatever origin it runs on
      // (localhost dev included); an absolute prod URL 404s against a quote
      // that lives in the dev database.
      quoteViewUrl: `/q/${prior.share_token}`,
      pdfUrl: prior.pdf_ready ? `/api/q/${prior.share_token}/pdf` : null,
      alreadySaved: true,
    })
  }

  const { data: tenantRow } = await estimatorSupabase
    .from('tenants')
    .select('business_name')
    .eq('id', tenant.id)
    .maybeSingle()
  const businessName = (tenantRow?.business_name as string | null) ?? 'Your painter'

  const shareToken = generateShareToken()
  const payloads = buildPaintQuotePayloads({
    bom,
    tenantId: tenant.id,
    shareToken,
    jobName: run.job_name as string | null,
    siteAddress: run.site_address as string | null,
  })

  const { data: intakeRow, error: intakeErr } = await estimatorSupabase
    .from('intakes')
    .insert(payloads.intake)
    .select('id')
    .single()
  if (intakeErr || !intakeRow) {
    return Response.json(
      { ok: false, error: 'intake_insert_failed', detail: intakeErr?.message ?? 'no row' },
      { status: 500 },
    )
  }

  const { data: quoteRow, error: quoteErr } = await estimatorSupabase
    .from('quotes')
    .insert({ ...payloads.quote, intake_id: intakeRow.id })
    .select('id, share_token')
    .single()
  if (quoteErr || !quoteRow) {
    return Response.json(
      { ok: false, error: 'quote_insert_failed', detail: quoteErr?.message ?? 'no row' },
      { status: 500 },
    )
  }

  // Absolute URL only for the PRINTED footer of the tender PDF (a PDF
  // can't use a relative link); the dashboard's clickable links below
  // are relative so they work on any origin, dev included.
  const quoteViewUrl = `${appUrl}/q/${shareToken}`
  const log = pipelineLog('estimate', paintRunId)

  // ── Tender PDF — best-effort, never blocks the quote. ─────────────
  let pdfReady = false
  if (gotenbergConfigured()) {
    try {
      const html = buildPaintTenderReportHtml({
        businessName,
        jobName: run.job_name as string | null,
        siteAddress: run.site_address as string | null,
        bom,
        quoteViewUrl,
      })
      const pdf = await renderPdfFromHtml(html)
      const path = `quotes/${quoteRow.id}.pdf`
      const { error: upErr } = await storage.storage
        .from('quote-pdfs')
        .upload(path, pdf, { contentType: 'application/pdf', upsert: true })
      if (!upErr) {
        await estimatorSupabase.from('quotes').update({ pdf_path: path }).eq('id', quoteRow.id)
        pdfReady = true
      } else {
        log.err('paint tender pdf upload failed', upErr, { quoteId: quoteRow.id })
      }
    } catch (e) {
      // PDF is a bonus; the quote record is the deliverable — but the
      // failure must be visible in platform logs, not swallowed.
      log.err('paint tender pdf render failed', e, { quoteId: quoteRow.id })
    }
  } else {
    log.err('paint tender pdf skipped — GOTENBERG_URL not configured', undefined, { quoteId: quoteRow.id })
  }

  // Record the saved quote on the extraction (idempotency anchor).
  await estimatorSupabase
    .from('plan_extractions')
    .update({
      sheets_used: {
        ...sheets,
        saved_quote: {
          quote_id: quoteRow.id,
          share_token: shareToken,
          priced_at: ext?.priced_at ?? null,
          pdf_ready: pdfReady,
        },
      },
    })
    .eq('id', extractionId)

  log.ok('paint quote saved', { quoteId: quoteRow.id, totalIncGst: bom.totalIncGst, pdfReady })

  return Response.json({
    ok: true,
    quoteId: quoteRow.id,
    shareToken,
    quoteViewUrl: `/q/${shareToken}`,
    pdfUrl: pdfReady ? `/api/q/${shareToken}/pdf` : null,
  })
}
