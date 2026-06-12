// Deeper readiness probe — verifies the DB is reachable and the seed
// data exists. Don't wire this to Railway's healthcheck (any DB blip
// would cause cascading restarts); use it manually or from a paid
// uptime monitor.

import { createClient } from '@supabase/supabase-js'
import { gotenbergConfigured } from '@/lib/pdf/gotenberg'

export const dynamic = 'force-dynamic'

export async function GET() {
  const checks: Record<string, { ok: boolean; detail?: string; ms?: number }> = {}

  // 1. Env vars present?
  const requiredEnv = [
    'NEXT_PUBLIC_SUPABASE_URL',
    'SUPABASE_SERVICE_ROLE_KEY',
    'ANTHROPIC_API_KEY',
  ]
  const missing = requiredEnv.filter((k) => !process.env[k])
  checks.env = { ok: missing.length === 0, detail: missing.length ? `missing: ${missing.join(', ')}` : 'all set' }

  // 2. Supabase reachable + has seed data?
  if (process.env.NEXT_PUBLIC_SUPABASE_URL && process.env.SUPABASE_SERVICE_ROLE_KEY) {
    const supabase = createClient(
      process.env.NEXT_PUBLIC_SUPABASE_URL,
      process.env.SUPABASE_SERVICE_ROLE_KEY
    )
    const t0 = Date.now()
    const { count, error } = await supabase
      .from('shared_assemblies')
      .select('*', { count: 'exact', head: true })
    checks.supabase = {
      ok: !error && (count ?? 0) > 0,
      detail: error ? error.message : `shared_assemblies: ${count} rows`,
      ms: Date.now() - t0,
    }
  } else {
    checks.supabase = { ok: false, detail: 'env vars missing — skipped' }
  }

  // 3. Gotenberg (quote PDF + MMS) — INFORMATIONAL only. The PDF link and
  //    MMS attachment are a bonus on top of every quote SMS, so a missing
  //    or unreachable Gotenberg must NOT fail readiness. But surface it:
  //    when GOTENBERG_URL is unset, every trade's PDF link + MMS silently
  //    disappears with no error, which is otherwise invisible.
  if (gotenbergConfigured()) {
    const base = process.env.GOTENBERG_URL!.trim().replace(/\/$/, '')
    const t0 = Date.now()
    try {
      const res = await fetch(`${base}/health`, { signal: AbortSignal.timeout(5_000) })
      checks.gotenberg = {
        ok: res.ok,
        detail: res.ok ? 'reachable' : `health returned ${res.status}`,
        ms: Date.now() - t0,
      }
    } catch (e) {
      checks.gotenberg = {
        ok: false,
        detail: `unreachable: ${e instanceof Error ? e.message : String(e)}`,
        ms: Date.now() - t0,
      }
    }
  } else {
    checks.gotenberg = {
      ok: false,
      detail: 'GOTENBERG_URL not set — quote PDFs + MMS attachments are disabled',
    }
  }

  // Core readiness (env + DB) gates the HTTP status. Gotenberg is reported
  // in `checks` but excluded from the gate so the PDF/MMS layer being off
  // doesn't 503 an otherwise-healthy app.
  const coreOk = checks.env.ok && checks.supabase.ok
  return Response.json(
    { ok: coreOk, time: new Date().toISOString(), checks },
    { status: coreOk ? 200 : 503 }
  )
}
