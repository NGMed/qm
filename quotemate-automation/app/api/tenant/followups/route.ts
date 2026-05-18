// /api/tenant/followups — WP7 needs-follow-up queue for the VA.
//
// GET  → quotes the authed tradie sent that the customer did NOT accept,
//        stale enough to chase, oldest-first, with the customer's
//        contact details + a quote summary so a VA can act immediately.
// POST → { quoteId, action: 'mark_contacted' | 'reopen', note? }
//        records / clears followed_up_at so an actioned lead drops out
//        of the active queue (human workflow first; room for automation
//        later).
//
// Auth mirrors /api/tenant/me: Authorization: Bearer <supabase token> →
// supabase.auth.getUser → tenant by owner_user_id. Service-role client
// for data (RLS not shipped yet, per CLAUDE.md). Every quote read/write
// is scoped to the caller's tenant_id so one tradie can never see or
// touch another's leads.

import { createClient } from '@supabase/supabase-js'
import {
  FOLLOWUP_MIN_AGE_HOURS,
  ageHoursSince,
  followupReason,
  lastActivityIso,
  selectFollowups,
  type FollowupQuote,
} from '@/lib/quote/followup'

export const dynamic = 'force-dynamic'

const supabase = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!,
)

async function tenantFromBearer(req: Request) {
  const auth = req.headers.get('authorization') ?? ''
  if (!auth.toLowerCase().startsWith('bearer ')) return null
  const token = auth.slice(7).trim()
  if (!token) return null
  const { data, error } = await supabase.auth.getUser(token)
  if (error || !data.user) return null
  const { data: tenant } = await supabase
    .from('tenants')
    .select('id')
    .eq('owner_user_id', data.user.id)
    .maybeSingle()
  if (!tenant) return null
  return tenant as { id: string }
}

// Columns the follow-up selector + the dashboard card need.
const QUOTE_COLS =
  'id, status, sent_at, viewed_at, paid_at, accepted_at, last_status_at, ' +
  'created_at, followed_up_at, followup_note, selected_tier, ' +
  'total_inc_gst, share_token, intake_id, needs_inspection, scope_of_works'

// ─── GET /api/tenant/followups ─────────────────────────────────────
export async function GET(req: Request) {
  const tenant = await tenantFromBearer(req)
  if (!tenant) {
    return Response.json({ error: 'unauthorized' }, { status: 401 })
  }

  const url = new URL(req.url)
  const minAgeHoursRaw = Number(url.searchParams.get('minAgeHours'))
  const minAgeHours =
    Number.isFinite(minAgeHoursRaw) && minAgeHoursRaw >= 0
      ? minAgeHoursRaw
      : FOLLOWUP_MIN_AGE_HOURS
  const includeActioned = url.searchParams.get('includeActioned') === '1'

  // Coarse DB filter (cheap, index-backed): tenant + delivered-but-not-
  // converted. The precise staleness / actioned rules are applied by the
  // pure selectFollowups() so they stay unit-tested and single-sourced.
  const { data: rows, error } = await supabase
    .from('quotes')
    .select(QUOTE_COLS)
    .eq('tenant_id', tenant.id)
    .in('status', ['sent', 'viewed'])
    .is('paid_at', null)
    .is('accepted_at', null)
    .order('last_status_at', { ascending: true, nullsFirst: false })
    .limit(500)

  if (error) {
    return Response.json({ error: error.message }, { status: 500 })
  }

  const candidates = selectFollowups(
    (rows ?? []) as FollowupQuote[],
    Date.now(),
    { minAgeHours, includeActioned },
  ) as Array<FollowupQuote & Record<string, unknown>>

  // Resolve customer contact details. intakes.caller is JSONB
  // ({name,phone,email}); fall back to the customers row (phone_number /
  // first_name / suburb) when the intake caller block is thin.
  const intakeIds = Array.from(
    new Set(
      candidates
        .map((q) => q.intake_id as string | null)
        .filter((id): id is string => !!id),
    ),
  )
  type IntakeJoin = {
    caller: { name?: string; phone?: string; email?: string } | null
    suburb: string | null
    job_type: string | null
    customer_id: string | null
  }
  const intakeMap: Record<string, IntakeJoin> = {}
  const customerIds: string[] = []
  if (intakeIds.length > 0) {
    const { data: intakes } = await supabase
      .from('intakes')
      .select('id, caller, suburb, job_type, customer_id')
      .in('id', intakeIds)
    for (const i of intakes ?? []) {
      const j: IntakeJoin = {
        caller: (i.caller as IntakeJoin['caller']) ?? null,
        suburb: (i.suburb as string | null) ?? null,
        job_type: (i.job_type as string | null) ?? null,
        customer_id: (i.customer_id as string | null) ?? null,
      }
      intakeMap[i.id as string] = j
      if (j.customer_id) customerIds.push(j.customer_id)
    }
  }
  type CustomerJoin = {
    first_name: string | null
    full_name: string | null
    phone_number: string | null
    suburb: string | null
    email: string | null
  }
  const customerMap: Record<string, CustomerJoin> = {}
  if (customerIds.length > 0) {
    const { data: customers } = await supabase
      .from('customers')
      .select('id, first_name, full_name, phone_number, suburb, email')
      .in('id', Array.from(new Set(customerIds)))
    for (const c of customers ?? []) {
      customerMap[c.id as string] = {
        first_name: (c.first_name as string | null) ?? null,
        full_name: (c.full_name as string | null) ?? null,
        phone_number: (c.phone_number as string | null) ?? null,
        suburb: (c.suburb as string | null) ?? null,
        email: (c.email as string | null) ?? null,
      }
    }
  }

  const now = Date.now()
  const followups = candidates.map((q) => {
    const intake = q.intake_id ? intakeMap[q.intake_id as string] : null
    const customer = intake?.customer_id
      ? customerMap[intake.customer_id]
      : null
    const callerName = intake?.caller?.name?.trim() || null
    const fullName = callerName || customer?.full_name || null
    const phone =
      intake?.caller?.phone?.trim() || customer?.phone_number || null
    const lastIso = lastActivityIso(q)
    return {
      quote_id: q.id as string,
      share_token: (q.share_token as string | null) ?? null,
      status: (q.status as string | null) ?? null,
      followup_reason: followupReason(q),
      last_activity: lastIso,
      age_hours:
        lastIso !== null
          ? Math.floor(ageHoursSince(lastIso, now) ?? 0)
          : null,
      total_inc_gst: (q.total_inc_gst as number | null) ?? null,
      selected_tier: (q.selected_tier as string | null) ?? null,
      job_type: intake?.job_type ?? null,
      needs_inspection: !!q.needs_inspection,
      scope_of_works: (q.scope_of_works as string | null) ?? null,
      followed_up_at: (q.followed_up_at as string | null) ?? null,
      followup_note: (q.followup_note as string | null) ?? null,
      customer: {
        first_name:
          callerName?.split(' ')[0] ?? customer?.first_name ?? null,
        full_name: fullName,
        phone,
        suburb: intake?.suburb ?? customer?.suburb ?? null,
        email: intake?.caller?.email?.trim() || customer?.email || null,
      },
    }
  })

  return Response.json({
    followups,
    meta: {
      count: followups.length,
      min_age_hours: minAgeHours,
      include_actioned: includeActioned,
      generated_at: new Date(now).toISOString(),
    },
  })
}

// ─── POST /api/tenant/followups ────────────────────────────────────
// Mark a lead contacted (or reopen it). Tenant-scoped: the update only
// matches when the quote belongs to the caller's tenant, so a wrong /
// foreign quoteId silently affects zero rows → 404.
export async function POST(req: Request) {
  const tenant = await tenantFromBearer(req)
  if (!tenant) {
    return Response.json({ error: 'unauthorized' }, { status: 401 })
  }

  let body: { quoteId?: unknown; action?: unknown; note?: unknown }
  try {
    body = await req.json()
  } catch {
    return Response.json({ error: 'invalid_json' }, { status: 400 })
  }

  const quoteId = typeof body.quoteId === 'string' ? body.quoteId : null
  const action = body.action === 'reopen' ? 'reopen' : 'mark_contacted'
  const note =
    typeof body.note === 'string' && body.note.trim()
      ? body.note.trim().slice(0, 500)
      : null
  if (!quoteId) {
    return Response.json({ error: 'quoteId is required' }, { status: 400 })
  }

  const patch: Record<string, unknown> =
    action === 'reopen'
      ? { followed_up_at: null }
      : { followed_up_at: new Date().toISOString() }
  if (note !== null) patch.followup_note = note

  const { data, error } = await supabase
    .from('quotes')
    .update(patch)
    .eq('id', quoteId)
    .eq('tenant_id', tenant.id) // ownership guard
    .select('id, followed_up_at, followup_note')
    .maybeSingle()

  if (error) {
    return Response.json({ error: error.message }, { status: 500 })
  }
  if (!data) {
    return Response.json({ error: 'not_found' }, { status: 404 })
  }

  return Response.json({ ok: true, quote: data, action })
}
