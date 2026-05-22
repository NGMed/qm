# Stripe Connect (Express) — Dashboard Setup Guide

> Step-by-step setup of Stripe Connect for QuoteMate, so the platform can
> collect money from customers and pay out to tradies (minus QuoteMate's 2%).
>
> **Do every step in TEST MODE first.** Repeat in Live mode only when you're
> ready to launch (Stage 8).
>
> Stripe occasionally renames menu items. Where a label may differ, the
> navigation *path* is given — follow the path, not the exact word.

---

## Stage 0 — Before you start

- You need the QuoteMate Stripe account login (the one tied to `STRIPE_SECRET_KEY`).
- Go to **https://dashboard.stripe.com**.
- The current Stripe dashboard uses **Sandboxes** instead of the old
  "Test mode" toggle. Confirm the account switcher (top-left) shows a
  **sandbox** (e.g. "QuoteMate sandbox") and the top banner reads
  *"You're testing in a sandbox."* Everything below is done in the sandbox.
  The **"Switch to live account"** button (top-right) is for Stage 8 only.
- Keep this checklist open in one tab, Stripe in another.

You will finish this guide with **3 values** to put into the app:

| Value | Where it comes from | Goes into |
|---|---|---|
| `STRIPE_SECRET_KEY` | Stage 6 (you likely already have this) | `.env.local` + Vercel |
| `STRIPE_CONNECT_WEBHOOK_SECRET` | Stage 5 | `.env.local` + Vercel |
| `STRIPE_PROVISIONING_ENABLED=true` | you set this manually | `.env.local` + Vercel |

---

## Stage 1 — Enable Connect on the account

1. In the **left sidebar**, look for **Connect**.
   - If you see a **"Get started"** / **"Enable Connect"** button → click it.
   - If there is no Connect entry, click the **Settings** gear (top-right) →
     scroll to the **Connect** section → **Enable Connect** / **Get started**.
2. Stripe asks **"How will you use Connect?"** — choose the option that means
   *"I run a platform/marketplace and pay out to other businesses"*
   (wording is usually **"Platform or marketplace"**).
3. Stripe asks who creates accounts and who they're for → choose
   **"Other businesses"** (your tradies), not "myself".
4. Confirm. Connect is now enabled **in test mode**. No review is required
   for test mode — the review only happens for Live mode (Stage 8).

✅ **Check:** the left sidebar now has a **Connect** section with sub-items
like *Accounts*, *Settings*.

---

## Stage 2 — Complete the Connect platform profile

This is the questionnaire Stripe uses to understand your money flow. Getting
it right now avoids friction at Live-mode review.

1. Go to **Settings** (gear, top-right) → under **Connect** → **Platform profile**
   (may also appear as **Connect → Settings → Platform profile**).
2. Fill it in describing QuoteMate honestly:
   - **What does your platform do?** → e.g. *"AI-assisted quoting platform for
     trade businesses (electricians, plumbers). Customers pay a deposit and
     final balance; we pay the tradie."*
   - **Who are your users / connected accounts?** → *Australian sole-trader and
     small trade businesses.*
   - **Do you collect payments from customers on behalf of your users?** → **Yes.**
   - **Refunds and chargebacks liability** → **Platform** (QuoteMate).
     ⚠️ This is **NOT optional**. QuoteMate uses the Express Dashboard for
     tradies, and Stripe's rules forbid `Express Dashboard` + `Stripe
     liability` — Express *requires* the platform to carry liability. If
     this is set to "Stripe", Express account creation will not work.
     It must say **Platform**. (Mitigated in practice: tradie payouts are
     on a manual schedule, so you withhold an unreleased payout if a
     dispute lands.)
   - **Do you charge your users a fee?** → **Yes**, a percentage fee (2%).
   - **Countries** → **Australia**.
3. **Acknowledge everything.** On the Platform profile page, click every
   pending **"Acknowledge"** link — there is one for *Refunds and
   chargebacks liability* and one for *Ongoing seller compliance*. The
   profile is not complete until all acknowledgements are done.
4. Save.

> The **Platform profile** page shows *historical* answers from Connect
> onboarding. To change current config, use the **"platform setup"** link
> in the note at the top of that page.

✅ **Check:** liability reads **Platform**, both **Acknowledge** links are
done, and the profile shows as **Complete**.

---

## Stage 3 — Set Connect branding

This is what tradies see on the Stripe-hosted onboarding screens and on their
Express dashboard.

1. Go to **Settings** → **Connect** → **Branding**
   (path: **Connect → Settings → Branding**).
2. Set:
   - **Business / platform name:** `QuoteMate`
   - **Logo / icon:** upload the QuoteMate / Maintain logo.
   - **Brand colour:** the QuoteMate accent — `#ff5a1f`.
   - **Accent colour:** same or a complementary dark.
3. Save.

✅ **Check:** the branding preview shows the QuoteMate logo and orange.

---

## Stage 4 — Confirm account & payout defaults

The *account type* ("Express"), liability, and **manual payout schedule** are
all set **by the code** in `lib/stripe/provision.ts` when each tradie's account
is created — you do **not** set them per-account in the dashboard. But confirm
the platform-level defaults don't fight the code:

1. Go to **Settings** → **Connect** → **Settings** (general Connect settings).
2. **Statement descriptor:** since QuoteMate's charges use `on_behalf_of` the
   tradie, the *tradie's* descriptor shows on the customer's card statement.
   Set a sensible **platform fallback descriptor** anyway — e.g. `QUOTEMATE`.
3. **Support contact:** set a support email / phone — this appears to tradies
   and customers if they query a charge.
4. Leave **payout schedule** defaults alone — the code sets each tradie's
   account to **manual payouts** explicitly, so QuoteMate controls when money
   reaches their bank (released on job completion).

✅ **Check:** support email + statement descriptor are set.

---

## Stage 5 — Create the Connected-accounts webhook  ⚠️ MOST IMPORTANT STEP

This is how QuoteMate learns a tradie finished onboarding (`account.updated`).
It is a **separate** webhook from your existing payment webhook.

1. Go to **Developers** → **Webhooks**
   (newer dashboards: **Developers → Workbench → Webhooks**, or there is an
   **"Event destinations"** screen — same thing).
2. Click **Add endpoint** (or **Add destination**).
3. **Endpoint URL** — type exactly:
   ```
   https://quote-mate-rho.vercel.app/api/stripe/connect-webhook
   ```
   (For local testing you can use the Stripe CLI instead — see Stage 7.)
4. **Listen to events on…** — you will see a choice between
   **"Your account"** and **"Connected accounts"**.
   👉 **Select "Connected accounts".** This is the critical setting. If you
   leave it on "Your account", `account.updated` for tradies will never arrive.
5. **Select events** → search and tick:
   - `account.updated`  ← required now
   - (optional, for the later disbursement phase) `payout.paid`,
     `payout.failed`, `transfer.created`, `transfer.reversed`
6. Click **Add endpoint** to save.
7. On the saved endpoint's page, find **Signing secret** → click **Reveal** →
   copy the value. It starts with `whsec_…`.
8. Put it in the app config:
   - In `quotemate-automation/.env.local`:
     ```
     STRIPE_CONNECT_WEBHOOK_SECRET=whsec_xxxxxxxxxxxxx
     ```
   - In **Vercel** → Project → **Settings → Environment Variables** → add the
     same key/value for the **Production** (and Preview) environments.

✅ **Check:** the webhook endpoint is listed, its mode is **"Connected"** (not
"Account"), and you have copied the `whsec_…` secret.

> ⚠️ Do NOT delete or edit your existing `/api/stripe/webhook` endpoint — that
> one stays on **"Your account"** and handles customer payments. You now have
> **two** webhooks, with **two different signing secrets**.

---

## Stage 6 — Confirm your API keys

1. Go to **Developers** → **API keys**.
2. Confirm you have the **test** secret key (`sk_test_…`).
   - This is your existing `STRIPE_SECRET_KEY`. **Connect needs no new key** —
     the same key gains Connect powers once Connect is enabled (Stage 1).
3. If `STRIPE_SECRET_KEY` is already set in `.env.local` and Vercel, leave it.

✅ **Check:** `.env.local` has `STRIPE_SECRET_KEY=sk_test_…`.

---

## Stage 7 — Turn it on and test (test mode)

1. In `quotemate-automation/.env.local`, set:
   ```
   STRIPE_PROVISIONING_ENABLED=true
   STRIPE_CONNECT_WEBHOOK_SECRET=whsec_…   (from Stage 5)
   ```
   Add both to **Vercel** env vars too.
2. Apply the database migration (adds the Connect-status columns):
   ```
   node --env-file=.env.staging.local scripts/run-migration-056.mjs   # staging first
   node --env-file=.env.local         scripts/run-migration-056.mjs   # then production
   ```
3. **Test the connected-account creation + onboarding link.**
   Once the dashboard "Set up payouts" panel is wired (next build step), a
   tradie clicks it → they're redirected to Stripe's hosted onboarding.
   To test before the UI exists, call the route directly with a tradie's
   Supabase token:
   ```
   POST https://quote-mate-rho.vercel.app/api/stripe/connect/start
   Header: Authorization: Bearer <tradie supabase access token>
   ```
   It returns `{ ok: true, url: "https://connect.stripe.com/..." }`.
4. Open that `url`. You'll see Stripe's **test-mode onboarding form**.
   Use Stripe's **test values** (the form offers a *"use test data / skip"*
   helper in test mode). For an AU test account:
   - Test phone / SSN-equivalent: use the autofill the form provides.
   - Test bank: BSB `000-000`, account number `000123456`.
5. Finish the form → Stripe redirects to `/onboard/stripe/return`.
6. **Confirm the webhook fired.** Back in Stripe → **Developers → Webhooks →**
   your Connect endpoint → **Recent events** — you should see `account.updated`
   with a **200** response.
7. **Confirm the database updated.** The tradie's `tenants` row should now have
   `stripe_connect_account_id` populated and
   `stripe_connect_payouts_enabled = true` (test accounts usually clear
   instantly).

✅ **Check:** webhook shows `account.updated` → 200, and the tenant row has
`stripe_connect_payouts_enabled = true`.

---

## Stage 8 — Going Live (do NOT do this until launch)

When you're ready for real money:

1. Toggle the dashboard to **Live mode**.
2. **Repeat Stages 1–6 in Live mode** — Live mode is a separate environment:
   - Enabling Connect in Live mode triggers a **Stripe platform review** of
     QuoteMate. Do this **well before** launch day, not the morning of.
   - Create the **Live** Connect webhook (same URL, "Connected accounts",
     `account.updated`) → it gives a **new** `whsec_…` — that's the value for
     the **Production** env var.
   - Use the **Live** secret key (`sk_live_…`) for production `STRIPE_SECRET_KEY`.
3. Complete Stripe's **Go-Live checklist**:
   https://docs.stripe.com/get-started/checklist/go-live
4. Real tradies onboard with real identity + real bank details; real KYC runs.

---

## Quick reference — what each thing is

| Term | Plain meaning |
|---|---|
| **Connect** | The Stripe feature that lets QuoteMate move money to other businesses. Mandatory for paying tradies. |
| **"Express"** | The flavour where Stripe hosts the tradie's signup form and runs their identity/bank KYC for you. Set in code (`controller.stripe_dashboard.type: 'express'`). |
| **Connected account** (`acct_…`) | One per tradie. Created by `lib/stripe/provision.ts`. |
| **Account link** | The single-use, short-lived URL that takes a tradie into the hosted onboarding form. |
| **`account.updated` webhook** | How QuoteMate hears that a tradie's onboarding/KYC progressed. Stage 5. |
| **Manual payout schedule** | Money sits in the tradie's Stripe balance; QuoteMate releases it to their bank on job completion. Set in code. |
| **`on_behalf_of`** | Makes the tradie the merchant of record (correct for AU GST / tax invoices). Applied on the charge, not in the dashboard. |
| **`application_fee_amount`** | QuoteMate's 2% cut, taken automatically on the charge. Applied in code. |

---

## Done?

After Stages 1–7 you have connected accounts that **can receive money**. The
actual money movement (collecting with `application_fee_amount` + `on_behalf_of`,
holding, and releasing payouts on job completion) is the next build phase in
the app code — it does not need any further Stripe Dashboard setup beyond what's
above.
