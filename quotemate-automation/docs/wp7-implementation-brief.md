# WP7 — Setter function for non-conversions (implementation brief)

> Source of truth for the Ralph loop. Re-read this every iteration.
> Build-brief origin: `docs/deliverables/build-brief-2026-05-18.html` /
> `QuoteMate_Revised_Build_Brief_2026-05-18.pdf`, WP7 (John's list item 10).

## The goal (from the brief, verbatim intent)

John wants a VA to follow up with people who received a quote but did not
accept it. Build a **reliable follow-up queue** for quotes that were sent
but not converted.

**What you build**
1. Make the quote lifecycle reliable enough to distinguish **sent,
   viewed, accepted and paid**.
2. Add a **needs-follow-up view** filtered by age and non-conversion status.
3. Show the customer's details, quote summary, last activity and a
   **direct path to contact them**.
4. Leave room for later automation, but make the **human VA workflow
   useful first**.

**Watch out:** the follow-up list is only as good as the underlying
status events. **Fix event reliability BEFORE trusting the queue** — do
step 1 before step 2/3.

**Done when:** a VA can open the dashboard and immediately see which
customers received quotes, did not accept, and should be contacted.

## Current state (verified — re-verify file:line before editing; the
codebase may have shifted)

`quotes` table: base in `sql/init.sql` (~L90-117); extra columns in
`sql/02_stages_06_10_partial.sql`, `sql/04_f3_finish.sql`,
`sql/migrations/015_tenants_onboarding.sql` (`tenant_id`).
Relevant lifecycle columns already present:
`status text default 'draft'` (NO check constraint — free text),
`sent_at`, `viewed_at`, `accepted_at`, `accepted_tier`, `paid_at`,
`paid_tier`, `paid_stripe_session_id`, `scheduled_at`, `created_at`,
`selected_tier`, `total_inc_gst`, `needs_inspection`,
`routing_decision`, `share_token`, `intake_id`, `tenant_id`.

Status write reality today:
- **draft** — reliably set on insert in `app/api/estimate/draft/route.ts`
  (`status:'draft'`).
- **sent** — MISSING. `sent_at` column exists but is never written; the
  quote SMS is dispatched in `app/api/estimate/draft/route.ts` (the
  dispatch block, ~L435-631) yet status stays `draft`.
- **viewed** — MISSING. `viewed_at` exists but `app/q/[token]/page.tsx`
  never records a view.
- **paid** — `paid_at`/`paid_tier`/`paid_stripe_session_id` set in
  `app/api/stripe/webhook/route.ts` (~L74-80) but `status` is NOT changed.
- **accepted** — `app/api/q/[token]/book/route.ts` (~L106-112) sets
  `status:'accepted'`, `accepted_at`, `scheduled_at`; precondition is
  `paid_at` set + `scheduled_at` null. So in this app the real order is
  **draft -> sent -> viewed -> paid -> accepted** (accept happens AFTER
  pay).

Quote -> customer is a 2-hop join: `quotes.intake_id -> intakes.id`,
`intakes.customer_id -> customers.id`. Customer contact fields live on
`customers` (mig 008): `first_name`, `full_name`, `phone_number` (E.164),
`email`, `suburb`. `lib/customers/lookup.ts` maintains them.

Dashboard: `/api/tenant/me` (`app/api/tenant/me/route.ts`) fetches the
last 20 quotes for the tenant (`select 'id, created_at, status,
selected_tier, total_inc_gst, scope_of_works, share_token, intake_id,
needs_inspection, routing_decision, good, better, best,
estimated_timeframe'`, no status/age filter) and joins intake + messages
+ a `deposit_paid` boolean (from `payments.status='succeeded'`).
Dashboard UI: `app/dashboard/page.tsx` — `QuotesTab` (~L3139-3181) +
`QuoteCard` (~L3183-3424). No follow-up / non-conversion view exists.

Tests: `vitest.config.ts`, node env, picks up `lib/**/*.test.ts` and
`tests/**/*.test.ts` (e2e `tests/e2e/**/*.spec.ts` excluded). Run with
`npm test` (= `vitest run`). NO quote-lifecycle tests exist yet.
Migrations are applied manually: a numbered `sql/migrations/0NN_*.sql`
plus a `scripts/run-migration-0NN.mjs` runner mirroring
`scripts/run-migration-023.mjs` (uses `SUPABASE_DB_URL`). Next free
number is **027** (024 = pricing_book unique index, 025 =
pricing_book.tenant_id NOT NULL, 026 = WP6 price-hold/booking_state).

`quotemate-automation/AGENTS.md` warns the Next.js version has breaking
changes — consult `node_modules/next/dist/docs/` before using any Next
API you are not 100% sure of (route handlers, `after()`, server
components/actions, params Promise).

## Build plan — do in this order

### Step 1 — Reliable lifecycle events (FIRST; the queue depends on it)

1. **Migration `sql/migrations/027_quote_lifecycle.sql`** (+ runner
   `scripts/run-migration-027.mjs` mirroring 023): additive only.
   - Document the canonical status set:
     `draft, sent, viewed, paid, accepted` (+ keep `inspection`/legacy
     values tolerated — never crash on an unknown value).
   - Add `last_status_at timestamptz` (nullable) bumped on every
     transition so "last activity" is a single sortable column.
   - Add optional VA-workflow columns (additive, nullable):
     `followed_up_at timestamptz`, `followup_note text`.
   - Backfill: set `status` from existing timestamps using the rank
     ladder so historical rows are classified (e.g. `accepted_at` ->
     'accepted', else `paid_at` -> 'paid', else `viewed_at` -> 'viewed',
     else `sent_at` -> 'sent', else leave as-is). Set `last_status_at`
     to the newest known lifecycle timestamp.
   - Index supporting the follow-up query, e.g.
     `(tenant_id, status, created_at)` (and/or a partial index on
     non-converted rows). Idempotent (`if not exists`).
   - PostgREST: avoid PARTIAL unique indexes as `onConflict` targets
     (see migration 024 lesson — partial indexes can't be inferred).

2. **`lib/quote/lifecycle.ts`** — single source of truth:
   - Pure, exported `STATUS_RANK: Record<string, number>` and
     `rankOf(status): number` (unknown/legacy -> -1, never throws).
   - Pure `nextStatus(current, event): string` and a pure
     `shouldAdvance(current, target): boolean` (monotonic: only advance
     when `rankOf(target) > rankOf(current)`; never regress paid/accepted).
   - `advanceQuoteStatus(supabase, quoteId, target)` that reads current
     status, applies `shouldAdvance`, and on advance writes
     `{ status: target, <target>_at: now (if column exists & unset),
     last_status_at: now }`. Idempotent + concurrency-safe (re-running
     for the same/older state is a no-op). Keep all DB-free logic in
     pure functions so it is unit-testable without Supabase.

3. **Wire the write sites through the helper** (verify exact lines first):
   - `app/api/estimate/draft/route.ts`: after the quote SMS is
     dispatched successfully, advance to `sent`. Inspection-routed
     quotes are still "sent" (the customer received something).
   - **View recording**: add `app/api/q/[token]/view/route.ts` (POST,
     by `share_token`) that advances to `viewed` (monotonic — must NOT
     downgrade a paid/accepted quote, must be safe to call repeatedly).
     Call it from `app/q/[token]/page.tsx` on first load (fire-and-
     forget; never block render; do not record tradie/owner previews as
     customer views — there is an owner check at
     `app/api/quote/[id]/check-owner/route.ts` / `TradieEditor` you can
     reuse the signal from).
   - `app/api/stripe/webhook/route.ts`: when payment completes, also
     advance status to `paid` (keep existing `paid_at` writes).
   - `app/api/q/[token]/book/route.ts`: route its `accepted` write
     through `advanceQuoteStatus` for consistency (behaviour unchanged).

### Step 2 — Needs-follow-up queue (only after Step 1)

- Pure selector in `lib/quote/followup.ts`:
  `isFollowupCandidate(quote, now, opts)` -> boolean and
  `followupReason(quote)` -> short string. Candidate =
  status in {sent, viewed} AND `paid_at` null AND `accepted_at` null
  AND age past threshold. Threshold from `last_status_at` (fallback
  `sent_at` then `created_at`), default **24h**, configurable via an
  exported constant / optional arg. Oldest-first ordering helper.
- Expose it: extend `/api/tenant/me` (or add
  `app/api/tenant/followups/route.ts`) returning, tenant-scoped, the
  candidate quotes with: customer first/full name, phone (E.164),
  suburb, quote summary (selected tier + `total_inc_gst` + job_type),
  `last_activity` (= last_status_at), `age_hours`, `status`,
  `followup_reason`, `share_token`, `followed_up_at`. Reuse the
  existing intake/customer join already in tenant/me.

### Step 3 — Dashboard VA view (human workflow first)

- In `app/dashboard/page.tsx` add a **Follow-ups** view (new sidebar
  section or a filter/sub-tab in QuotesTab) listing the queue:
  customer name, **tappable phone (`tel:` + `sms:` links)**, suburb,
  quote total + tier + job type, last activity (relative + absolute),
  age, status badge, link to the share page. Sorted oldest-first.
  Empty state: clear "no follow-ups — all quotes converted or too
  recent" message. AU formatting (currency inc-GST display, dates
  DD/MM, mobile not "cell"). Match existing dashboard styling /
  Maintain design system already in use.
- "Leave room for automation": include a **Mark contacted** action
  that sets `followed_up_at` (and removes it from the active queue or
  visibly de-emphasises it) — additive, human-driven, no auto-send.
  No automated outbound in WP7 (v1 keeps tradie/VA human-in-loop).

### Step 4 — Tests (the completion gate)

Add focused **vitest** tests (node env, pure logic, NO live DB),
mirroring existing `lib/**/*.test.ts`:
- `lib/quote/lifecycle.test.ts`: rank ordering; `shouldAdvance`
  monotonic (draft->sent->viewed->paid->accepted advances; any regress
  or equal is rejected; unknown/legacy status never throws and never
  regresses a real status); timestamp-from-event mapping.
- `lib/quote/followup.test.ts`: candidate true/false across the
  matrix (paid excluded, accepted excluded, too-recent excluded,
  sent+old included, viewed+old included, threshold boundary,
  ordering oldest-first, reason text).
- Any other pure helper you extract.

Keep DB-touching code thin; put all branching logic in pure functions
so it is covered without network.

## Definition of done / completion promise

Output `<promise>All tests pass</promise>` **only when ALL are TRUE**:
1. `npm test` (vitest run) exits 0, **zero** failing tests, and the new
   `lib/quote/lifecycle.test.ts` + `lib/quote/followup.test.ts` exist
   and pass and meaningfully cover Step 1 & 2 logic.
2. `npx tsc --noEmit -p tsconfig.json` reports **0 errors**.
3. No NEW eslint errors introduced by changed files (pre-existing
   `no-explicit-any` in untouched code is acceptable; do not add `any`).
4. Steps 1-3 are actually implemented and wired (migration + runner +
   `lib/quote/*` + the four write sites + follow-up endpoint +
   dashboard Follow-ups view with a direct contact path), not stubbed.
5. Changes are additive and do not regress existing behaviour: existing
   93 tests still pass; the estimator/grounding ("price-checker") is
   untouched; status transitions are monotonic (never regress
   paid/accepted); multi-tenant scoping preserved; no auto-send added.

Do NOT emit the promise to escape the loop if any item is false. The
migration cannot be run against prod from here — that is expected and
does NOT block the promise (the promise is about code + tests + types,
and the migration/runner being present and correct). Note in your final
summary that `node --env-file=.env.local scripts/run-migration-027.mjs`
must be run to apply the schema.

## Guardrails

- Re-verify file:line before each edit (recon may be stale).
- Idempotent migration; additive columns; no destructive DDL.
- View recording must be idempotent and must never downgrade status.
- Respect `AGENTS.md`: check `node_modules/next/dist/docs/` for any
  Next API you are unsure about before using it.
- Commit per the repo convention when a coherent slice is green
  (Ralph persists progress via git + files between iterations).
- Keep CLAUDE.md decisions intact (portal-first v1, human-in-loop, no
  auto-send, AU formatting, multi-tenant scoping).
