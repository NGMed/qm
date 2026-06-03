// POST /api/painting/estimate — runs an address + job inputs through the
// painting orchestrator and returns { ok, estimate } for the dashboard's
// two-tab painting tool.
//
// Auth: same bearer-token pattern as /api/roofing/measure — the
// dashboard passes the Supabase access token. No tenant-data write
// happens here (Phase 1: read-only estimate). `source` selects the tab:
//   'rea'  → realestate.com.au provider (inert until a scraper/paste
//            backend is wired; demo toggle returns sample data)
//   'auto' → the "other tools" provider stack (Solar/Geoscape/Domain —
//            mock until their adapters + keys land)

import { createClient } from '@supabase/supabase-js'
import { EstimateRequestSchema } from '@/lib/painting/request-schema'
import { estimatePainting } from '@/lib/painting/measure'
import { DEFAULT_PAINTING_RATE_CARD } from '@/lib/painting/pricing'
import type { PaintingRateCard } from '@/lib/painting/types'

export const dynamic = 'force-dynamic'

const supabase = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!,
)

async function userAndTenantFromBearer(
  req: Request,
): Promise<{ userId: string; tenantId: string | null; primaryTrade: string | null } | null> {
  const auth = req.headers.get('authorization') ?? ''
  if (!auth.toLowerCase().startsWith('bearer ')) return null
  const token = auth.slice(7).trim()
  if (!token) return null
  const { data, error } = await supabase.auth.getUser(token)
  if (error || !data.user) return null
  const { data: tenant } = await supabase
    .from('tenants')
    .select('id, trade')
    .eq('owner_user_id', data.user.id)
    .maybeSingle()
  return {
    userId: data.user.id,
    tenantId: (tenant?.id as string | undefined) ?? null,
    primaryTrade: (tenant?.trade as string | null | undefined) ?? null,
  }
}

/** Best-effort — fetch the per-tenant painting rate-card overlay from
 *  pricing_book.overlays.painting_rate_card and shallow-merge it onto the
 *  default. Returns null on any miss so the caller uses the default. */
async function loadPaintingOverlay(
  tenantId: string,
  primaryTrade: string | null,
): Promise<unknown> {
  try {
    let q = supabase
      .from('pricing_book')
      .select('overlays')
      .eq('tenant_id', tenantId)
    if (primaryTrade) q = q.eq('trade', primaryTrade)
    const { data } = await q.limit(1).maybeSingle()
    const overlays = (data?.overlays as Record<string, unknown> | null | undefined) ?? null
    return overlays?.painting_rate_card ?? null
  } catch {
    return null
  }
}

/** Defensive shallow merge of an overlay JSON onto the default rate card.
 *  Only known keys are taken; rate_per_unit merges per-scope. */
function effectivePaintingRateCard(overlay: unknown): PaintingRateCard {
  const base = DEFAULT_PAINTING_RATE_CARD
  if (overlay == null || typeof overlay !== 'object') return base
  const o = overlay as Record<string, unknown>
  const num = (v: unknown, fallback: number) =>
    typeof v === 'number' && Number.isFinite(v) ? v : fallback
  return {
    ...base,
    rate_per_unit: {
      walls: num((o.rate_per_unit as Record<string, unknown>)?.walls, base.rate_per_unit.walls),
      ceilings: num((o.rate_per_unit as Record<string, unknown>)?.ceilings, base.rate_per_unit.ceilings),
      trim: num((o.rate_per_unit as Record<string, unknown>)?.trim, base.rate_per_unit.trim),
      exterior: num((o.rate_per_unit as Record<string, unknown>)?.exterior, base.rate_per_unit.exterior),
    },
    double_storey_loading_pct: num(o.double_storey_loading_pct, base.double_storey_loading_pct),
    premium_uplift_pct: num(o.premium_uplift_pct, base.premium_uplift_pct),
    good_refresh_fraction: num(o.good_refresh_fraction, base.good_refresh_fraction),
    call_out_minimum_ex_gst: num(o.call_out_minimum_ex_gst, base.call_out_minimum_ex_gst ?? 0),
    gst_registered:
      typeof o.gst_registered === 'boolean' ? o.gst_registered : base.gst_registered,
  }
}

export async function POST(req: Request) {
  const auth = await userAndTenantFromBearer(req)
  if (!auth) {
    return Response.json({ ok: false, error: 'unauthorized' }, { status: 401 })
  }

  let body: unknown
  try {
    body = await req.json()
  } catch {
    return Response.json({ ok: false, error: 'invalid_json' }, { status: 400 })
  }

  const parsed = EstimateRequestSchema.safeParse(body)
  if (!parsed.success) {
    return Response.json(
      { ok: false, error: 'invalid_request', issues: parsed.error.issues },
      { status: 400 },
    )
  }

  const { address, inputs, source, use_mock_provider } = parsed.data

  let rateCard: PaintingRateCard | undefined
  if (auth.tenantId) {
    const overlayJson = await loadPaintingOverlay(auth.tenantId, auth.primaryTrade)
    if (overlayJson != null) rateCard = effectivePaintingRateCard(overlayJson)
  }

  const result = await estimatePainting(address, inputs, {
    source: source ?? 'auto',
    useMock: use_mock_provider,
    rateCard,
  })

  if (!result.ok) {
    return Response.json({ ok: false, code: result.code, detail: result.detail }, { status: 200 })
  }

  return Response.json({ ok: true, estimate: result.estimate }, { status: 200 })
}
