// ════════════════════════════════════════════════════════════════════
// Pylon — light API integration (premium quote spec §4.5).
//
// SERVER-ONLY. api.getpylon.com is REST/JSON:API with a Bearer token
// read from PYLON_API_KEY (never hardcoded; the key once shared in chat
// must be rotated). The whole integration is enrichment:
//
//   • GET /v1/au/stc_amount — Pylon's official STC quantity calculator,
//     used as a CROSS-CHECK guardrail against our deterministic STC
//     math. It never changes a price; a mismatch only flags the
//     estimate for tradie review.
//   • POST /v1/opportunities_form — optional CRM lead push on first
//     confirm, behind the per-tenant pylon_lead_push flag.
//
// Flags: PYLON_ENABLED env gate (default off) + PYLON_API_KEY present.
// Every function returns a result object and NEVER throws — Pylon
// unreachable means the estimate flow is bit-identical to today
// (degradation matrix §4.6).
// ════════════════════════════════════════════════════════════════════

const PYLON_BASE_URL = 'https://api.getpylon.com'
const TIMEOUT_MS = 5_000

/** PURE — the integration gate. Enabled only when PYLON_ENABLED is
 *  'true'/'1' AND a key exists. Callers pass process.env values. */
export function pylonEnabled(env: {
  PYLON_ENABLED?: string
  PYLON_API_KEY?: string
}): boolean {
  const on = env.PYLON_ENABLED === 'true' || env.PYLON_ENABLED === '1'
  return on && typeof env.PYLON_API_KEY === 'string' && env.PYLON_API_KEY.length > 0
}

/**
 * PURE — per-tenant CRM lead-push gate (spec §4.5). The spec calls for a
 * tenant-level flag; the tenants table has no settings jsonb yet (and
 * this feature ships with NO DB migration), so the allowlist lives in
 * the PYLON_LEAD_PUSH_TENANTS env var: comma-separated tenant ids, or
 * '*' for all tenants. Moves into tenant settings when that column
 * lands. Requires the master pylonEnabled() gate too.
 */
export function pylonLeadPushEnabled(
  env: { PYLON_ENABLED?: string; PYLON_API_KEY?: string; PYLON_LEAD_PUSH_TENANTS?: string },
  tenantId: string | null,
): boolean {
  if (!pylonEnabled(env)) return false
  if (!tenantId) return false
  const list = (env.PYLON_LEAD_PUSH_TENANTS ?? '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean)
  return list.includes('*') || list.includes(tenantId)
}

export type PylonResult<T> =
  | { ok: true; data: T }
  | { ok: false; code: 'disabled' | 'http_error' | 'network_error' | 'invalid_response'; detail: string }

export type PylonClientOpts = {
  apiKey?: string
  baseUrl?: string
  fetchImpl?: typeof fetch
  timeoutMs?: number
}

async function pylonGet(
  path: string,
  params: Record<string, string>,
  opts: PylonClientOpts,
): Promise<PylonResult<unknown>> {
  return pylonRequest(path + '?' + new URLSearchParams(params).toString(), { method: 'GET' }, opts)
}

async function pylonRequest(
  pathWithQuery: string,
  init: RequestInit,
  opts: PylonClientOpts,
): Promise<PylonResult<unknown>> {
  const apiKey = opts.apiKey ?? process.env.PYLON_API_KEY
  if (!apiKey) {
    return { ok: false, code: 'disabled', detail: 'PYLON_API_KEY is not set.' }
  }
  const base = (opts.baseUrl ?? PYLON_BASE_URL).replace(/\/$/, '')
  const doFetch = opts.fetchImpl ?? fetch
  let res: Response
  try {
    res = await doFetch(base + pathWithQuery, {
      ...init,
      headers: {
        Authorization: `Bearer ${apiKey}`,
        Accept: 'application/vnd.api+json, application/json',
        ...(init.body ? { 'Content-Type': 'application/json' } : {}),
        ...(init.headers ?? {}),
      },
      signal: AbortSignal.timeout(opts.timeoutMs ?? TIMEOUT_MS),
    })
  } catch (e) {
    return {
      ok: false,
      code: 'network_error',
      detail: e instanceof Error ? e.message : String(e),
    }
  }
  if (!res.ok) {
    let body = ''
    try {
      body = (await res.text()).slice(0, 300)
    } catch {
      /* ignore */
    }
    return { ok: false, code: 'http_error', detail: `Pylon returned ${res.status}: ${body}` }
  }
  try {
    return { ok: true, data: await res.json() }
  } catch (e) {
    return {
      ok: false,
      code: 'invalid_response',
      detail: e instanceof Error ? e.message : String(e),
    }
  }
}

// ── STC amount cross-check (spec §4.5) ───────────────────────────────

export type PylonStcAmount = {
  stcs: number
  zone: string | null
  zone_rating: number | null
  deeming_period: number | null
}

/**
 * GET /v1/au/stc_amount — Pylon's official STC calculator (no special
 * permissions required per their docs). Never throws.
 */
export async function fetchPylonStcAmount(
  args: {
    output_kw: number
    site_postcode: string
    installation_year: number
    sgu_kind?: string
  },
  opts: PylonClientOpts = {},
): Promise<PylonResult<PylonStcAmount>> {
  const res = await pylonGet(
    '/v1/au/stc_amount',
    {
      sgu_kind: args.sgu_kind ?? 'solar_deemed',
      output_kw: String(args.output_kw),
      site_postcode: args.site_postcode,
      installation_year: String(args.installation_year),
    },
    opts,
  )
  if (!res.ok) return res

  // Tolerate both flat and JSON:API-wrapped payloads.
  const body = res.data as Record<string, unknown>
  const flat =
    body && typeof body === 'object' && body.data && typeof body.data === 'object'
      ? ((body.data as Record<string, unknown>).attributes ?? body.data)
      : body
  const obj = (flat ?? {}) as Record<string, unknown>
  const stcs = numberOrNull(obj.stcs)
  if (stcs === null) {
    return {
      ok: false,
      code: 'invalid_response',
      detail: 'Pylon stc_amount response carried no numeric stcs field.',
    }
  }
  return {
    ok: true,
    data: {
      stcs,
      zone: typeof obj.zone === 'string' ? obj.zone : null,
      zone_rating: numberOrNull(obj.zone_rating),
      deeming_period: numberOrNull(obj.deeming_period),
    },
  }
}

// ── CRM lead push (spec §4.5) ────────────────────────────────────────

export type PylonOpportunityLead = {
  name: string
  phone?: string | null
  email?: string | null
  address?: string | null
  /** Free-text system summary, e.g. "10 kW solar — QuoteMate estimate". */
  summary?: string | null
}

/**
 * POST /v1/opportunities_form — push a confirmed QuoteMate estimate into
 * the tenant's Pylon pipeline as a lead. Fire-and-forget; never throws.
 */
export async function pushPylonOpportunity(
  lead: PylonOpportunityLead,
  opts: PylonClientOpts = {},
): Promise<PylonResult<unknown>> {
  return pylonRequest(
    '/v1/opportunities_form',
    {
      method: 'POST',
      body: JSON.stringify({
        name: lead.name,
        phone: lead.phone ?? undefined,
        email: lead.email ?? undefined,
        address: lead.address ?? undefined,
        notes: lead.summary ?? undefined,
      }),
    },
    opts,
  )
}

// ── helpers ──────────────────────────────────────────────────────────

function numberOrNull(v: unknown): number | null {
  if (typeof v === 'number' && Number.isFinite(v)) return v
  if (typeof v === 'string') {
    const n = Number.parseFloat(v)
    if (Number.isFinite(n)) return n
  }
  return null
}
