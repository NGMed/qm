// POST /api/stripe/connect/start
//
// Starts (or resumes) Stripe Connect onboarding for the authed tradie.
//   1. Auth via Bearer supabase token → resolve tenant.
//   2. If the tenant has no stripe_connect_account_id, create a connected
//      account and persist the acct_… id.
//   3. Mint a fresh single-use hosted onboarding link.
//   4. Return { url } — the dashboard redirects the tradie there.
//
// Safe to call repeatedly: an existing account is reused; only the
// onboarding link is regenerated each call (links are single-use).
//
// When STRIPE_PROVISIONING_ENABLED !== 'true' the account create is
// stubbed and there is no real link — the route returns
// { ok:false, error:'provisioning_disabled' } so the dashboard can show
// a "coming soon" state instead of a broken redirect.

import { createClient } from '@supabase/supabase-js'
import {
  provisionStripeConnectAccount,
  createConnectOnboardingLink,
} from '@/lib/stripe/provision'

export const dynamic = 'force-dynamic'

const supabase = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!,
)

async function userFromBearer(req: Request) {
  const auth = req.headers.get('authorization') ?? ''
  if (!auth.toLowerCase().startsWith('bearer ')) return null
  const token = auth.slice(7).trim()
  if (!token) return null
  const { data, error } = await supabase.auth.getUser(token)
  if (error || !data.user) return null
  return data.user
}

export async function POST(req: Request) {
  const user = await userFromBearer(req)
  if (!user) {
    return Response.json({ ok: false, error: 'unauthorized' }, { status: 401 })
  }

  const { data: tenant, error: tErr } = await supabase
    .from('tenants')
    .select('id, owner_email, business_name, stripe_connect_account_id')
    .eq('owner_user_id', user.id)
    .maybeSingle()

  if (tErr) {
    return Response.json({ ok: false, error: tErr.message }, { status: 500 })
  }
  if (!tenant) {
    return Response.json({ ok: false, error: 'no_tenant' }, { status: 404 })
  }

  const appUrl =
    process.env.APP_URL ?? process.env.NEXT_PUBLIC_APP_URL ?? null
  if (!appUrl) {
    return Response.json(
      { ok: false, error: 'APP_URL not set — cannot build onboarding return URLs' },
      { status: 500 },
    )
  }

  // ─── 1. Ensure a connected account exists ───────────────────────
  let accountId = tenant.stripe_connect_account_id as string | null

  if (!accountId) {
    const created = await provisionStripeConnectAccount({
      tenantId: tenant.id,
      ownerEmail: tenant.owner_email,
      businessName: tenant.business_name,
    })
    if (!created.ok) {
      return Response.json(
        { ok: false, error: 'account_create_failed', detail: created.reason },
        { status: 502 },
      )
    }
    if (created.stubbed) {
      return Response.json(
        { ok: false, error: 'provisioning_disabled' },
        { status: 503 },
      )
    }
    accountId = created.accountId
    const { error: upErr } = await supabase
      .from('tenants')
      .update({ stripe_connect_account_id: accountId })
      .eq('id', tenant.id)
    if (upErr) {
      // The account exists on Stripe but we failed to persist its id.
      // Surface loudly — a retry would orphan-create a second account.
      return Response.json(
        { ok: false, error: 'account_persist_failed', detail: upErr.message, accountId },
        { status: 500 },
      )
    }
  }

  // ─── 2. Mint a fresh hosted onboarding link ─────────────────────
  const link = await createConnectOnboardingLink({ accountId, appUrl })
  if (!link.ok) {
    return Response.json(
      { ok: false, error: 'link_create_failed', detail: link.reason },
      { status: 502 },
    )
  }

  return Response.json({ ok: true, url: link.url, accountId })
}
