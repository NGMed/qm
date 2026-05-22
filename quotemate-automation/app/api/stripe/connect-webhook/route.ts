// Stripe Connect webhook — kept separate from /api/stripe/webhook because
// it is signed with a DIFFERENT secret (STRIPE_CONNECT_WEBHOOK_SECRET) and
// listens to events on CONNECTED accounts, not the platform account.
//
// In the Stripe Dashboard this endpoint MUST be created with the
// "Events on Connected accounts" option ticked.
//
// Subscribed event: `account.updated`. Fires whenever a tradie's Express
// onboarding progresses — we mirror the readiness flags onto the tenant
// row so the disbursement path knows when the tradie can be paid out.
// A tradie is payout-eligible only when payouts_enabled is true.

import { createClient } from '@supabase/supabase-js'
import { getStripe } from '@/lib/stripe/client'
import { pipelineLog } from '@/lib/log/pipeline'
import type Stripe from 'stripe'

export const maxDuration = 60

const supabase = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!,
)

export async function POST(req: Request) {
  const log = pipelineLog('dispatch')
  log.step('stripe connect webhook received')

  const sig = req.headers.get('stripe-signature')
  const secret = process.env.STRIPE_CONNECT_WEBHOOK_SECRET
  if (!sig || !secret) {
    log.err('missing signature or connect webhook secret', null, {
      has_sig: !!sig,
      has_secret: !!secret,
    })
    return new Response('Missing signature', { status: 400 })
  }

  const raw = await req.text()
  let event: Stripe.Event
  try {
    event = await getStripe().webhooks.constructEventAsync(raw, sig, secret)
  } catch (err: unknown) {
    log.err('signature verification failed', err)
    return new Response('Invalid signature', { status: 400 })
  }

  log.ok('connect event verified', { type: event.type, id: event.id, account: event.account })

  if (event.type !== 'account.updated') {
    log.ok('event type not handled, acknowledging', { type: event.type })
    return Response.json({ received: true })
  }

  const account = event.data.object as Stripe.Account
  const accountId = account.id
  const metaTenantId = account.metadata?.tenant_id ?? null

  const chargesEnabled = !!account.charges_enabled
  const payoutsEnabled = !!account.payouts_enabled
  const detailsSubmitted = !!account.details_submitted

  // Resolve the tenant — primary by the persisted acct_… id, fallback to
  // the tenant_id we stamped in account metadata at creation time (covers
  // the race where account.updated fires before connect/start persisted).
  const byAccount = await supabase
    .from('tenants')
    .select('id, stripe_connect_onboarded_at')
    .eq('stripe_connect_account_id', accountId)
    .maybeSingle()

  let tenant = byAccount.data
  if (!tenant && metaTenantId) {
    const byMeta = await supabase
      .from('tenants')
      .select('id, stripe_connect_onboarded_at')
      .eq('id', metaTenantId)
      .maybeSingle()
    tenant = byMeta.data
  }

  if (!tenant) {
    // Ack so Stripe stops retrying — but log it: an account with no tenant
    // is an orphan worth investigating.
    log.err('account.updated for unknown tenant', null, { account: accountId, meta_tenant_id: metaTenantId })
    return Response.json({ received: true, unmatched: true })
  }

  const patch: Record<string, unknown> = {
    stripe_connect_account_id: accountId,
    stripe_connect_charges_enabled: chargesEnabled,
    stripe_connect_payouts_enabled: payoutsEnabled,
    stripe_connect_details_submitted: detailsSubmitted,
  }
  // Stamp the first time the account is fully live; never clear it after.
  if (chargesEnabled && payoutsEnabled && !tenant.stripe_connect_onboarded_at) {
    patch.stripe_connect_onboarded_at = new Date().toISOString()
  }

  const { error } = await supabase.from('tenants').update(patch).eq('id', tenant.id)
  if (error) {
    log.err('tenant connect-state update failed', error.message, { tenant_id: tenant.id })
    return new Response('DB update failed', { status: 500 })
  }

  log.done('tenant connect state synced', {
    tenant_id: tenant.id,
    account: accountId,
    charges_enabled: chargesEnabled,
    payouts_enabled: payoutsEnabled,
    details_submitted: detailsSubmitted,
  })
  return Response.json({ received: true })
}
