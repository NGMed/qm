// /api/onboard/activate — final step of the tradie onboarding wizard.
//
// What it does (atomic-ish, with manual rollback on partial failure):
//   1. Validate payload via Zod (includes optional intent_token for SMS flow)
//   2. Insert tenants row (the new tradie's record, status='onboarding')
//   3. Insert pricing_book row tied to that tenant
//   4. Insert tenant_service_offerings (auto-enable the easy-5 for their trade)
//   5. Provision AU Twilio number (gated by TWILIO_PROVISIONING_ENABLED)
//   5b. Register the number with Vapi (gated by VAPI_PROVISIONING_ENABLED)
//   6. SMS-only: markIntentUsed() — flip tradie_signup_intents row to
//      consumed, back-link the originating sms_conversations row to the
//      new tenant. Skipped silently for web-initiated onboarding.
//   7. Update tenants row → status='active', stamp twilio + vapi IDs
//   8. Send welcome SMS from the new tenant number to the owner's mobile
//
// On Twilio failure or Vapi failure, the tenant + pricing_book + service
// rows still exist with status='onboarding'. The activate retry button on
// the success screen can re-attempt provisioning without re-running step 1-4.

import { createClient } from '@supabase/supabase-js'
import { OnboardActivateSchema, defaultsForTrade } from '@/lib/onboard/schema'
import { provisionTwilioNumber } from '@/lib/twilio/provision'
import { sendWelcomeSms } from '@/lib/twilio/welcome-sms'
import { provisionVapiAssistant } from '@/lib/vapi/provision'
import { registerNumberWithVapi } from '@/lib/vapi/register-number'
import { markIntentUsed } from '@/lib/onboard/intent-tokens'

const supabase = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!,
)

export async function POST(req: Request) {
  let tenantId: string | null = null
  try {
    const raw = await req.json()
    const parsed = OnboardActivateSchema.safeParse(raw)
    if (!parsed.success) {
      return Response.json(
        {
          ok: false,
          error: 'validation_failed',
          fieldErrors: parsed.error.flatten().fieldErrors,
        },
        { status: 400 },
      )
    }
    const form = parsed.data
    const defaults = defaultsForTrade(form.trade)

    // ─── 1. Insert tenants row ─────────────────────────────────
    const { data: tenant, error: tErr } = await supabase
      .from('tenants')
      .insert({
        owner_user_id: form.owner_user_id || null,
        business_name: form.business_name,
        owner_first_name: form.owner_first_name,
        owner_last_name: form.owner_last_name || null,
        owner_email: form.owner_email.toLowerCase(),
        owner_mobile: normaliseAuMobile(form.owner_mobile),
        trade: form.trade,
        state: form.state,
        abn: form.abn || null,
        licence_type: form.licence_type || null,
        licence_number: form.licence_number || null,
        licence_expiry: form.licence_expiry || null,
        status: 'onboarding',
      })
      .select('id')
      .single()

    if (tErr || !tenant) {
      const errMsg = tErr?.message ?? 'tenant insert failed'
      // Friendly message for the obvious unique-violation case
      const friendly = errMsg.toLowerCase().includes('owner_email')
        ? 'An account with that email already exists. Sign in instead.'
        : errMsg
      return Response.json({ ok: false, error: friendly }, { status: 400 })
    }
    // Use a non-nullable const for downstream calls; tenantId stays in
    // outer scope so the catch-all rollback can find it.
    const id: string = tenant.id
    tenantId = id

    // ─── 2. Insert pricing_book row ───────────────────────────
    const { error: pbErr } = await supabase.from('pricing_book').insert({
      tenant_id: id,
      trade: form.trade,
      hourly_rate: form.hourly_rate,
      call_out_minimum: form.call_out_minimum,
      default_markup_pct: form.default_markup_pct,
      apprentice_rate: form.apprentice_rate ?? defaults.apprentice_rate,
      senior_rate: form.senior_rate ?? defaults.senior_rate,
      after_hours_multiplier: form.after_hours_multiplier ?? defaults.after_hours_multiplier,
      min_labour_hours: form.min_labour_hours ?? defaults.min_labour_hours,
      risk_buffer_pct: form.risk_buffer_pct ?? defaults.risk_buffer_pct,
      gst_registered: form.gst_registered ?? true,
      licence_type: form.licence_type || null,
      licence_number: form.licence_number || null,
      licence_state: form.state,
      licence_expiry: form.licence_expiry || null,
    })

    if (pbErr) {
      // Roll back the tenant row so a retry doesn't trip the unique email constraint.
      await supabase.from('tenants').delete().eq('id', id)
      return Response.json(
        { ok: false, error: `pricing_book insert failed: ${pbErr.message}` },
        { status: 500 },
      )
    }

    // ─── 3. Auto-enable the trade's easy-5 services ──────────
    const { data: assemblies } = await supabase
      .from('shared_assemblies')
      .select('id')
      .eq('trade', form.trade)

    if (assemblies && assemblies.length > 0) {
      const rows = assemblies.map((a) => ({
        tenant_id: id,
        assembly_id: a.id,
        enabled: true,
      }))
      // ignore unique-violation conflicts on re-run
      await supabase.from('tenant_service_offerings').upsert(rows, {
        onConflict: 'tenant_id,assembly_id',
      })
    }

    // ─── 4. Provision Twilio number ───────────────────────────
    // Real Twilio API call when TWILIO_PROVISIONING_ENABLED=true,
    // deterministic stub otherwise. See lib/twilio/provision.ts.
    const twilio = await provisionTwilioNumber({
      tenantId: id,
      friendlyName: `${form.business_name} — QuoteMate`,
    })
    if (!twilio.ok) {
      return Response.json(
        {
          ok: true,
          tenantId: id,
          phoneNumber: null,
          warning: `Tenant + pricing saved, but Twilio number provisioning failed: ${twilio.reason}. Retry from dashboard.`,
        },
        { status: 200 },
      )
    }
    const provisionedNumber = twilio.phoneNumber

    // ─── 5. Provision Vapi assistant ──────────────────────────
    // Real Vapi API call when VAPI_PROVISIONING_ENABLED=true,
    // deterministic stub otherwise. See lib/vapi/provision.ts.
    const vapi = await provisionVapiAssistant({
      tenantId: id,
      businessName: form.business_name,
      trade: form.trade,
      phoneNumber: provisionedNumber,
    })
    if (!vapi.ok) {
      return Response.json(
        {
          ok: true,
          tenantId: id,
          phoneNumber: provisionedNumber,
          warning: `Tenant + pricing + Twilio number saved, but Vapi assistant creation failed: ${vapi.reason}. Retry from dashboard.`,
        },
        { status: 200 },
      )
    }

    // ─── 5b. Register the Twilio number with Vapi ────────────────
    // Ties the bought number to the assistant so when Twilio forwards
    // inbound calls to api.vapi.ai/twilio/inbound_call (configured at
    // purchase time), Vapi knows which assistant should answer.
    const vapiNumber = await registerNumberWithVapi({
      phoneNumber: provisionedNumber,
      assistantId: vapi.assistantId,
      name: `${form.business_name} — QuoteMate`,
    })
    if (!vapiNumber.ok) {
      // Not fatal: assistant + Twilio number both exist. Voice routing
      // simply won't work until the registration retries successfully.
      console.warn('[activate] Vapi number registration failed', vapiNumber.reason)
    }

    // ─── 6. Mark SMS signup intent as used (SMS-only step) ───────
    // Only fires when the wizard was reached via the SMS magic-link
    // flow (intent_token present in payload). markIntentUsed flips
    // the tradie_signup_intents row to consumed AND back-links the
    // originating sms_conversations row:
    //   • tenant_id           = new tenant
    //   • conversation_type   = 'converted'
    // Idempotent — if the token is already consumed (concurrent retry),
    // ok=false is returned silently and we continue. Non-fatal: a stale
    // unused intent row will just expire on its own 24h TTL.
    if (form.intent_token) {
      try {
        const marked = await markIntentUsed(supabase, {
          token: form.intent_token,
          tenantId: id,
        })
        if (marked.ok) {
          console.log('[activate] SMS intent consumed + conversation back-linked', {
            tenantId: id,
            conversationId: marked.conversationId,
          })
        } else {
          console.warn('[activate] markIntentUsed returned ok=false (token already consumed or missing)', {
            tenantId: id,
            token: form.intent_token,
          })
        }
      } catch (e: any) {
        // Non-fatal — tenant is still live, the SMS thread just stays
        // unconverted. An admin retry endpoint can re-run this later.
        console.warn('[activate] markIntentUsed threw — non-fatal', {
          tenantId: id,
          message: e?.message ?? String(e),
        })
      }
    }

    // ─── 7. Update tenants row with provisioned IDs + activate ─
    const { error: updErr } = await supabase
      .from('tenants')
      .update({
        twilio_sms_number: provisionedNumber,
        twilio_voice_number: provisionedNumber,
        vapi_assistant_id: vapi.assistantId,
        status: 'active',
        activated_at: new Date().toISOString(),
      })
      .eq('id', id)

    if (updErr) {
      return Response.json(
        {
          ok: true,
          tenantId: id,
          phoneNumber: provisionedNumber,
          stubbed: twilio.stubbed,
          warning: 'Tenant created but activation update failed — retry from /onboard/success',
          updateError: updErr.message,
        },
        { status: 200 },
      )
    }

    // ─── 8. Welcome SMS dispatch (gated by same Twilio flag) ──
    const welcome = await sendWelcomeSms({
      fromNumber: provisionedNumber,
      toMobile: normaliseAuMobile(form.owner_mobile),
      firstName: form.owner_first_name,
      businessName: form.business_name,
    })
    if (!welcome.ok) {
      // Welcome SMS failure does NOT roll back — tenant is still live.
      // Surface the warning so the UI can show a "we couldn't text you" note.
      console.warn('[activate] welcome SMS failed', welcome.reason)
    }

    return Response.json({
      ok: true,
      tenantId: id,
      phoneNumber: provisionedNumber,
      stubbed: twilio.stubbed,
      welcomeSent: welcome.ok && !('stubbed' in welcome && welcome.stubbed),
    })
  } catch (err: any) {
    // Catch-all rollback if we created a tenant but threw afterwards.
    if (tenantId) {
      try {
        await supabase.from('tenants').delete().eq('id', tenantId)
      } catch {
        // best-effort
      }
    }
    return Response.json(
      { ok: false, error: err?.message ?? String(err) },
      { status: 500 },
    )
  }
}

// ─────────────────────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────────────────────

/** Normalise AU mobiles to E.164: 0412345678 → +61412345678. Idempotent. */
function normaliseAuMobile(input: string): string {
  const stripped = input.replace(/\s+/g, '')
  if (stripped.startsWith('+61')) return stripped
  if (stripped.startsWith('61')) return `+${stripped}`
  if (stripped.startsWith('04')) return `+61${stripped.slice(1)}`
  if (stripped.startsWith('4')) return `+61${stripped}`
  return stripped // fall through — Zod already validated shape
}
