# Invitation Codes Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add an allowlist + campaign-attribution invitation-code gate to QuoteMate tradie onboarding, covering both the web (`/onboard`) and SMS (`JOIN <code>`) entry paths.

**Architecture:** A new `onboarding_codes` table (reusable codes with quota, nullable `tenant_id` for tenant-vs-platform scope) and a `code_redemptions` ledger. Validation logic lives in one lib module (`lib/onboard/invitation-codes.ts`) reused by every entry point. A *check* (read-only) runs at capture time and at the `/onboard` Step-0 gate; a single idempotent *consume* runs inside `/api/onboard/activate` after the tenant row is created. Spec: [docs/superpowers/specs/2026-06-15-invitation-codes-design.md](../specs/2026-06-15-invitation-codes-design.md).

**Tech Stack:** Next.js 16 App Router, TypeScript, Supabase (Postgres 17 + service-role key), Zod, `pg` for migrations, Vitest for unit tests. Maintain design system (dark `ink-*`/`accent` Tailwind tokens) for UI.

**Deliberate consolidation (DRY):** The spec lists code capture on `/signup/verify` (§6.1) *and* a re-check gate at `/onboard` Step 0 (§6.2). For the web path these are redundant — the Step-0 gate is the single authoritative checkpoint, so the web tradie types the code once at Step 0. `/signup/verify` is left untouched. The SMS path pre-captures the code (from `JOIN <code>`) and Step 0 renders it pre-filled + locked. One capture per path, one validation gate.

**Platform-admin identification (resolves spec §10 open question a):** start with an env allowlist `PLATFORM_ADMIN_USER_IDS` (comma-separated Supabase `auth.users` UUIDs). No migration, no new table. A helper `isPlatformAdmin(userId)` reads it.

**Random-suffix length (resolves spec §10 open question b):** 4 chars from an unambiguous 32-char alphabet (`23456789ABCDEFGHJKLMNPQRSTUVWXYZ` — no `0/O/1/I`).

---

## File Structure

**Create:**
- `quotemate-automation/sql/migrations/112_invitation_codes.sql` — schema (2 tables + tenants column + RLS).
- `quotemate-automation/scripts/run-migration-112.mjs` — apply + verify migration.
- `quotemate-automation/lib/onboard/invitation-codes.ts` — `generateInvitationCode`, `checkInvitationCode`, `consumeInvitationCode`, `isPlatformAdmin`, types.
- `quotemate-automation/lib/onboard/invitation-codes.test.ts` — unit tests (pure helpers + mocked-supabase logic).
- `quotemate-automation/app/api/onboard/validate-code/route.ts` — POST check endpoint.
- `quotemate-automation/app/api/dashboard/invites/codes/route.ts` — GET list + POST generate.
- `quotemate-automation/app/api/dashboard/invites/codes/[id]/route.ts` — PATCH update.
- `quotemate-automation/app/dashboard/invites/page.tsx` — admin codes UI.

**Modify:**
- `quotemate-automation/lib/onboard/schema.ts` — add `invitation_code` field to `OnboardActivateSchema`.
- `quotemate-automation/app/api/onboard/activate/route.ts` — call `consumeInvitationCode` after tenant insert.
- `quotemate-automation/app/onboard/page.tsx` — add Step-0 code gate.
- `quotemate-automation/app/api/sms/inbound/route.ts` — parse `JOIN <code>`, validate, stash `code_id`.
- `quotemate-automation/sql/init.sql` — append the two new tables so init stays representative.

---

## Task 1: Database migration (schema + RLS)

**Files:**
- Create: `quotemate-automation/sql/migrations/112_invitation_codes.sql`
- Create: `quotemate-automation/scripts/run-migration-112.mjs`
- Modify: `quotemate-automation/sql/init.sql` (append new tables near the other tenancy tables)

- [ ] **Step 1: Write the migration SQL**

Create `quotemate-automation/sql/migrations/112_invitation_codes.sql`:

```sql
-- Migration 112 — invitation codes (tradie onboarding allowlist + attribution).
-- See docs/superpowers/specs/2026-06-15-invitation-codes-design.md.
-- Idempotent: all `if not exists` / guarded.

-- ── 1. onboarding_codes ──────────────────────────────────────────
create table if not exists onboarding_codes (
  id           uuid primary key default gen_random_uuid(),
  code         text not null unique,                       -- canonical UPPER-case
  tenant_id    uuid references tenants(id) on delete cascade, -- null = platform-wide
  campaign     text,
  description  text,
  quota_total  integer not null check (quota_total > 0),
  quota_used   integer not null default 0,
  status       text not null default 'active'
                 check (status in ('active','paused','revoked')),
  expires_at   timestamptz,
  created_by   uuid references auth.users(id) on delete set null,
  created_at   timestamptz not null default now(),
  constraint quota_not_exceeded check (quota_used <= quota_total)
);

create unique index if not exists idx_onboarding_codes_code_lower
  on onboarding_codes (lower(code));
create index if not exists idx_onboarding_codes_tenant
  on onboarding_codes (tenant_id);

-- ── 2. code_redemptions (attribution ledger) ─────────────────────
create table if not exists code_redemptions (
  id          uuid primary key default gen_random_uuid(),
  code_id     uuid not null references onboarding_codes(id) on delete cascade,
  tenant_id   uuid not null references tenants(id) on delete cascade,
  channel     text not null check (channel in ('web','sms')),
  redeemed_at timestamptz not null default now(),
  unique (code_id, tenant_id)
);
create index if not exists idx_code_redemptions_code on code_redemptions (code_id);

-- ── 3. tenants convenience pointer ───────────────────────────────
alter table tenants
  add column if not exists used_onboarding_code_id uuid
    references onboarding_codes(id) on delete set null;

-- ── 4. RLS — enable, no public policy (matches migration 040 Phase 1) ──
alter table onboarding_codes enable row level security;
alter table code_redemptions enable row level security;
```

- [ ] **Step 2: Write the run-migration script**

Create `quotemate-automation/scripts/run-migration-112.mjs`:

```js
// QuoteMate · run migration 112 (invitation codes)
// Usage: node --env-file=.env.local scripts/run-migration-112.mjs
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import pg from 'pg'

const { Client } = pg
const here = dirname(fileURLToPath(import.meta.url))
const sqlPath = join(here, '..', 'sql', 'migrations', '112_invitation_codes.sql')

const dbUrl = process.env.SUPABASE_DB_URL
if (!dbUrl) {
  console.error('Missing SUPABASE_DB_URL in .env.local')
  process.exit(1)
}

const sql = readFileSync(sqlPath, 'utf8')
const c = new Client({ connectionString: dbUrl, ssl: { rejectUnauthorized: false } })

try {
  await c.connect()
  console.log(`→ Applying 112_invitation_codes.sql (${sql.length.toLocaleString()} chars)...`)
  await c.query(sql)
  const { rows } = await c.query(
    `select
       exists (select 1 from information_schema.tables
         where table_schema='public' and table_name='onboarding_codes') as codes_ok,
       exists (select 1 from information_schema.tables
         where table_schema='public' and table_name='code_redemptions') as redemptions_ok,
       exists (select 1 from information_schema.columns
         where table_schema='public' and table_name='tenants'
           and column_name='used_onboarding_code_id') as col_ok`,
  )
  const r = rows[0]
  console.log(`  ${r.codes_ok ? '✓' : '✗'} onboarding_codes: ${r.codes_ok}`)
  console.log(`  ${r.redemptions_ok ? '✓' : '✗'} code_redemptions: ${r.redemptions_ok}`)
  console.log(`  ${r.col_ok ? '✓' : '✗'} tenants.used_onboarding_code_id: ${r.col_ok}`)
  if (!(r.codes_ok && r.redemptions_ok && r.col_ok)) process.exit(1)
  console.log('\nOK — migration 112 verified.')
} catch (err) {
  console.error('Migration failed:', err.message ?? err)
  process.exit(1)
} finally {
  await c.end()
}
```

- [ ] **Step 3: Apply the migration to Supabase**

Run: `cd quotemate-automation && node --env-file=.env.local scripts/run-migration-112.mjs`
Expected output ends with:
```
  ✓ onboarding_codes: true
  ✓ code_redemptions: true
  ✓ tenants.used_onboarding_code_id: true

OK — migration 112 verified.
```

- [ ] **Step 4: Mirror the new tables into `sql/init.sql`**

Open `quotemate-automation/sql/init.sql`, find the tenancy/onboarding table block (search for `create table if not exists tradie_signup_intents`), and paste the `onboarding_codes` + `code_redemptions` `create table` statements (from Step 1, without the `alter table tenants` line) immediately after it. This keeps init representative; it is not executed by the migration runner.

- [ ] **Step 5: Commit**

```bash
git add quotemate-automation/sql/migrations/112_invitation_codes.sql quotemate-automation/scripts/run-migration-112.mjs quotemate-automation/sql/init.sql
git commit -m "feat(onboard): migration 112 — invitation_codes + code_redemptions tables"
```

---

## Task 2: Invitation-code lib (generate / check / consume)

**Files:**
- Create: `quotemate-automation/lib/onboard/invitation-codes.ts`
- Test: `quotemate-automation/lib/onboard/invitation-codes.test.ts`

- [ ] **Step 1: Write failing tests for the pure helpers**

Create `quotemate-automation/lib/onboard/invitation-codes.test.ts`:

```ts
import { describe, it, expect } from 'vitest'
import {
  generateInvitationCode,
  slugifyCampaign,
  isPlatformAdmin,
  RANDOM_ALPHABET,
} from './invitation-codes'

describe('slugifyCampaign', () => {
  it('upper-cases and strips non-alphanumerics to single dashes', () => {
    expect(slugifyCampaign('June Flyers!')).toBe('JUNE-FLYERS')
    expect(slugifyCampaign('  fb__promo  ')).toBe('FB-PROMO')
  })
  it('caps length at 24 chars', () => {
    expect(slugifyCampaign('a'.repeat(40)).length).toBeLessThanOrEqual(24)
  })
})

describe('generateInvitationCode', () => {
  it('joins prefix, campaign slug, and a 4-char suffix with dashes', () => {
    const code = generateInvitationCode('JON', 'june_flyers')
    expect(code).toMatch(/^JON-JUNE-FLYERS-[23456789ABCDEFGHJKLMNPQRSTUVWXYZ]{4}$/)
  })
  it('only uses unambiguous suffix characters', () => {
    for (let i = 0; i < 50; i++) {
      const suffix = generateInvitationCode('QM', 'x').split('-').pop()!
      for (const ch of suffix) expect(RANDOM_ALPHABET).toContain(ch)
    }
  })
})

describe('isPlatformAdmin', () => {
  it('matches a uuid present in the comma-separated allowlist', () => {
    expect(isPlatformAdmin('u1', 'u1, u2 ,u3')).toBe(true)
    expect(isPlatformAdmin('u9', 'u1,u2')).toBe(false)
    expect(isPlatformAdmin('u1', undefined)).toBe(false)
    expect(isPlatformAdmin('u1', '')).toBe(false)
  })
})
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd quotemate-automation && npx vitest run lib/onboard/invitation-codes.test.ts`
Expected: FAIL — `Cannot find module './invitation-codes'`.

- [ ] **Step 3: Implement the lib module**

Create `quotemate-automation/lib/onboard/invitation-codes.ts`:

```ts
// Invitation codes — tradie onboarding allowlist + campaign attribution.
// One module reused by every entry point (web Step-0, SMS inbound,
// dashboard generate). Mirrors the helper style of intent-tokens.ts.
//
// Vocabulary:
//   check   — read-only validation (exists / active / not expired / quota left)
//   consume — single idempotent write at activate time (ledger + quota++)

import type { SupabaseClient } from '@supabase/supabase-js'
import { randomBytes } from 'node:crypto'

/** Unambiguous suffix alphabet — no 0/O/1/I. */
export const RANDOM_ALPHABET = '23456789ABCDEFGHJKLMNPQRSTUVWXYZ'

export type CodeChannel = 'web' | 'sms'

export type CheckOk = {
  ok: true
  code_id: string
  tenant_id: string | null
  remaining_quota: number
  last_slot: boolean
}
export type CheckErr = {
  ok: false
  error:
    | 'code_not_found'
    | 'code_expired'
    | 'quota_exhausted'
    | 'code_revoked'
    | 'code_paused'
  message: string
}
export type CheckResult = CheckOk | CheckErr

/** Campaign → UPPER dash-slug, alphanumerics only, capped at 24 chars. */
export function slugifyCampaign(raw: string): string {
  return raw
    .trim()
    .toUpperCase()
    .replace(/[^A-Z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 24)
    .replace(/-+$/g, '')
}

/** 4-char random suffix from the unambiguous alphabet. */
function randomSuffix(len = 4): string {
  const bytes = randomBytes(len)
  let out = ''
  for (let i = 0; i < len; i++) out += RANDOM_ALPHABET[bytes[i] % RANDOM_ALPHABET.length]
  return out
}

/** prefix-CAMPAIGN-SUFFIX, e.g. JON-JUNE-FLYERS-7K2P. Canonical UPPER-case. */
export function generateInvitationCode(prefix: string, campaign: string): string {
  const p = prefix.trim().toUpperCase().replace(/[^A-Z0-9]+/g, '').slice(0, 8) || 'QM'
  const c = slugifyCampaign(campaign || 'CODE')
  return `${p}-${c}-${randomSuffix()}`
}

/** Membership test against a comma-separated env allowlist. */
export function isPlatformAdmin(userId: string, allowlist = process.env.PLATFORM_ADMIN_USER_IDS): boolean {
  if (!allowlist) return false
  return allowlist
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean)
    .includes(userId)
}

const FRIENDLY: Record<CheckErr['error'], string> = {
  code_not_found: "We don't recognise that code. Check the spelling or ask whoever sent it.",
  code_expired: 'That code has expired. Ask whoever sent it for a new one.',
  quota_exhausted: 'That code has reached its sign-up limit. Ask for a new one.',
  code_revoked: 'That code is no longer valid.',
  code_paused: 'That code is paused right now. Try again later or ask for a new one.',
}

/**
 * Read-only validation. Trims + upper-cases, looks up by lower(code).
 * NEVER writes. Safe to call repeatedly (on blur, at Step 0).
 */
export async function checkInvitationCode(
  supabase: SupabaseClient,
  rawCode: string,
): Promise<CheckResult> {
  const code = rawCode.trim().toUpperCase()
  if (!code) return { ok: false, error: 'code_not_found', message: FRIENDLY.code_not_found }

  const { data } = await supabase
    .from('onboarding_codes')
    .select('id, tenant_id, status, expires_at, quota_total, quota_used')
    .ilike('code', code) // case-insensitive exact (no % wildcards in `code`)
    .maybeSingle()

  if (!data) return { ok: false, error: 'code_not_found', message: FRIENDLY.code_not_found }
  if (data.status === 'revoked') return { ok: false, error: 'code_revoked', message: FRIENDLY.code_revoked }
  if (data.status === 'paused') return { ok: false, error: 'code_paused', message: FRIENDLY.code_paused }
  if (data.expires_at && new Date(data.expires_at).getTime() <= Date.now()) {
    return { ok: false, error: 'code_expired', message: FRIENDLY.code_expired }
  }
  const used = data.quota_used as number
  const total = data.quota_total as number
  if (used >= total) return { ok: false, error: 'quota_exhausted', message: FRIENDLY.quota_exhausted }

  return {
    ok: true,
    code_id: data.id as string,
    tenant_id: (data.tenant_id as string | null) ?? null,
    remaining_quota: total - used,
    last_slot: used === total - 1,
  }
}

export type ConsumeResult =
  | { ok: true; alreadyRedeemed: boolean }
  | { ok: false; error: 'quota_exhausted' | 'db_error'; message: string }

/**
 * Single idempotent consume, called inside /api/onboard/activate AFTER
 * the tenant row exists. Steps:
 *   1. insert code_redemptions (unique(code_id,tenant_id) → retries no-op)
 *   2. guarded quota++ (where quota_used < quota_total) — 0 rows = exhausted
 *   3. stamp tenants.used_onboarding_code_id
 * Not a DB transaction (supabase-js has no multi-statement txn); the
 * unique ledger row + guarded update together prevent double-burn and
 * over-quota under concurrency.
 */
export async function consumeInvitationCode(
  supabase: SupabaseClient,
  args: { codeId: string; tenantId: string; channel: CodeChannel },
): Promise<ConsumeResult> {
  // 1. Ledger row — idempotency key.
  const { error: insErr } = await supabase
    .from('code_redemptions')
    .insert({ code_id: args.codeId, tenant_id: args.tenantId, channel: args.channel })

  if (insErr) {
    // 23505 = unique violation → this tenant already redeemed this code.
    if (insErr.code === '23505') {
      return { ok: true, alreadyRedeemed: true }
    }
    return { ok: false, error: 'db_error', message: insErr.message }
  }

  // 2. Guarded increment. RPC keeps the read-compare-write atomic.
  const { data: bumped, error: bumpErr } = await supabase.rpc('increment_code_quota', {
    p_code_id: args.codeId,
  })
  if (bumpErr) return { ok: false, error: 'db_error', message: bumpErr.message }
  if (bumped === false) {
    // Quota just exhausted by a concurrent signup — roll back the ledger row.
    await supabase
      .from('code_redemptions')
      .delete()
      .eq('code_id', args.codeId)
      .eq('tenant_id', args.tenantId)
    return { ok: false, error: 'quota_exhausted', message: FRIENDLY.quota_exhausted }
  }

  // 3. Convenience pointer (non-fatal).
  await supabase
    .from('tenants')
    .update({ used_onboarding_code_id: args.codeId })
    .eq('id', args.tenantId)

  return { ok: true, alreadyRedeemed: false }
}
```

- [ ] **Step 4: Add the `increment_code_quota` RPC to the migration**

The guarded increment needs an atomic SQL function. Append to `quotemate-automation/sql/migrations/112_invitation_codes.sql` (and re-run the migration — it is idempotent):

```sql
-- ── 5. Atomic guarded quota increment ───────────────────────────
-- Returns true if it incremented, false if quota was already full.
create or replace function increment_code_quota(p_code_id uuid)
returns boolean
language plpgsql
as $$
declare
  updated integer;
begin
  update onboarding_codes
     set quota_used = quota_used + 1
   where id = p_code_id
     and quota_used < quota_total;
  get diagnostics updated = row_count;
  return updated > 0;
end;
$$;
```

Re-run: `cd quotemate-automation && node --env-file=.env.local scripts/run-migration-112.mjs`
Expected: still ends `OK — migration 112 verified.`

- [ ] **Step 5: Run the pure-helper tests to verify they pass**

Run: `cd quotemate-automation && npx vitest run lib/onboard/invitation-codes.test.ts`
Expected: PASS (all `slugifyCampaign` / `generateInvitationCode` / `isPlatformAdmin` cases green).

- [ ] **Step 6: Commit**

```bash
git add quotemate-automation/lib/onboard/invitation-codes.ts quotemate-automation/lib/onboard/invitation-codes.test.ts quotemate-automation/sql/migrations/112_invitation_codes.sql
git commit -m "feat(onboard): invitation-code generate/check/consume lib + RPC"
```

---

## Task 3: `POST /api/onboard/validate-code` (check endpoint)

**Files:**
- Create: `quotemate-automation/app/api/onboard/validate-code/route.ts`

- [ ] **Step 1: Implement the endpoint**

Create `quotemate-automation/app/api/onboard/validate-code/route.ts`:

```ts
// POST /api/onboard/validate-code — read-only invitation-code check.
// Called on-blur from the /onboard Step-0 gate and from the SMS inbound
// handler. Never consumes quota (that happens at /api/onboard/activate).

import { createClient } from '@supabase/supabase-js'
import { z } from 'zod'
import { checkInvitationCode } from '@/lib/onboard/invitation-codes'

export const dynamic = 'force-dynamic'

const supabase = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!,
)

const Body = z.object({
  code: z.string().trim().min(1).max(60),
  channel: z.enum(['web', 'sms']).optional(),
})

export async function POST(req: Request) {
  let raw: unknown
  try {
    raw = await req.json()
  } catch {
    return Response.json({ ok: false, error: 'invalid_json' }, { status: 400 })
  }
  const parsed = Body.safeParse(raw)
  if (!parsed.success) {
    return Response.json({ ok: false, error: 'invalid_request' }, { status: 400 })
  }
  const result = await checkInvitationCode(supabase, parsed.data.code)
  // 200 for valid, 422 for a well-formed but invalid code so the client
  // can distinguish "bad request" (400) from "code rejected" (422).
  return Response.json(result, { status: result.ok ? 200 : 422 })
}
```

- [ ] **Step 2: Smoke-test against a seeded code**

First seed a test code (one-off, via the dashboard generate endpoint built in Task 7, OR directly):
```bash
cd quotemate-automation && node --env-file=.env.local -e "
import('pg').then(async ({ default: pg }) => {
  const c = new pg.Client({ connectionString: process.env.SUPABASE_DB_URL, ssl: { rejectUnauthorized: false } })
  await c.connect()
  await c.query(\"insert into onboarding_codes (code, quota_total, campaign, description) values ('TEST-SMOKE-AAAA', 5, 'smoke', 'plan smoke test') on conflict (code) do nothing\")
  console.log('seeded TEST-SMOKE-AAAA')
  await c.end()
})"
```
Then run the dev server (`npm run dev`) and:
```bash
curl -s -X POST http://localhost:3000/api/onboard/validate-code -H 'Content-Type: application/json' -d '{"code":"test-smoke-aaaa","channel":"web"}'
```
Expected: `{"ok":true,"code_id":"...","tenant_id":null,"remaining_quota":5,"last_slot":false}` (note lower-case input still matched).
And an invalid code:
```bash
curl -s -X POST http://localhost:3000/api/onboard/validate-code -H 'Content-Type: application/json' -d '{"code":"NOPE"}'
```
Expected: HTTP 422, `{"ok":false,"error":"code_not_found","message":"We don't recognise that code..."}`.

- [ ] **Step 3: Commit**

```bash
git add quotemate-automation/app/api/onboard/validate-code/route.ts
git commit -m "feat(onboard): POST /api/onboard/validate-code check endpoint"
```

---

## Task 4: Wire consume into activate (schema + route)

**Files:**
- Modify: `quotemate-automation/lib/onboard/schema.ts` (add `invitation_code`)
- Modify: `quotemate-automation/app/api/onboard/activate/route.ts:174-211` (consume before provisioning)

- [ ] **Step 1: Add `invitation_code` to the activate schema**

In `quotemate-automation/lib/onboard/schema.ts`, inside `OnboardActivateSchema`, directly after the `intent_token` field (line ~96, before the closing `})`), add:

```ts
  // ── Invitation code (required by the Step-0 gate) ──────────────
  // Carried from the /onboard Step-0 gate (web) or the SMS JOIN flow.
  // Consumed once at activate via consumeInvitationCode().
  invitation_code: z.string().trim().min(1, 'Invitation code required').max(60),
```

- [ ] **Step 2: Import the consume helper + checker in the activate route**

In `quotemate-automation/app/api/onboard/activate/route.ts`, add to the import block (after line 24, the `seedTenantServiceOfferings` import):

```ts
import { checkInvitationCode, consumeInvitationCode } from '@/lib/onboard/invitation-codes'
```

- [ ] **Step 3: Re-check the code BEFORE inserting the tenant**

In the same file, immediately after `const primaryTrade = form.trades[0]` (line ~52), add a pre-flight check so an exhausted/revoked code fails *before* we create a tenant row:

```ts
    // Re-validate the invitation code at the last moment. Cheap insurance
    // against a code that was revoked or exhausted between Step-0 and submit.
    const codeCheck = await checkInvitationCode(supabase, form.invitation_code)
    if (!codeCheck.ok) {
      return Response.json(
        { ok: false, error: codeCheck.error, message: codeCheck.message },
        { status: 422 },
      )
    }
```

- [ ] **Step 4: Consume the code after the tenant row is created**

In the same file, find the SMS intent block that starts with `if (form.intent_token) {` (line ~193). Insert the consume call immediately BEFORE that block (i.e. after the `seedTenantServiceOfferings` try/catch ends, ~line 189):

```ts
    // ─── Consume the invitation code (idempotent, once per tenant) ──
    // Done after the tenant row exists so the redemption ledger has a
    // valid FK. If quota was exhausted by a concurrent signup, roll the
    // tenant back and surface the friendly error.
    const consumed = await consumeInvitationCode(supabase, {
      codeId: codeCheck.code_id,
      tenantId: id,
      channel: form.intent_token ? 'sms' : 'web',
    })
    if (!consumed.ok) {
      await supabase.from('pricing_book').delete().eq('tenant_id', id)
      await supabase.from('tenants').delete().eq('id', id)
      tenantId = null
      return Response.json(
        { ok: false, error: consumed.error, message: consumed.message },
        { status: 422 },
      )
    }
```

- [ ] **Step 5: Manual end-to-end check via curl**

With the dev server running and `TEST-SMOKE-AAAA` seeded (quota 5), POST a full activate payload including the code:
```bash
curl -s -X POST http://localhost:3000/api/onboard/activate -H 'Content-Type: application/json' -d '{
  "business_name":"Plan Test Co","owner_first_name":"Plan","owner_email":"plan-test@example.com",
  "owner_mobile":"0412345678","trades":["electrical"],"state":"NSW",
  "hourly_rate":110,"call_out_minimum":150,"default_markup_pct":28,
  "invitation_code":"TEST-SMOKE-AAAA"
}'
```
Expected: `{"ok":true,"tenantId":"...", ...}`. Then verify quota incremented:
```bash
cd quotemate-automation && node --env-file=.env.local -e "
import('pg').then(async ({ default: pg }) => {
  const c = new pg.Client({ connectionString: process.env.SUPABASE_DB_URL, ssl: { rejectUnauthorized: false } })
  await c.connect()
  const { rows } = await c.query(\"select quota_used, quota_total from onboarding_codes where code='TEST-SMOKE-AAAA'\")
  console.log(rows[0]) // expect { quota_used: 1, quota_total: 5 }
  await c.end()
})"
```
Then clean up the test tenant:
```bash
cd quotemate-automation && node --env-file=.env.local -e "
import('pg').then(async ({ default: pg }) => {
  const c = new pg.Client({ connectionString: process.env.SUPABASE_DB_URL, ssl: { rejectUnauthorized: false } })
  await c.connect()
  await c.query(\"delete from tenants where owner_email='plan-test@example.com'\")
  await c.query(\"update onboarding_codes set quota_used=0 where code='TEST-SMOKE-AAAA'\")
  console.log('cleaned up'); await c.end()
})"
```

- [ ] **Step 6: Commit**

```bash
git add quotemate-automation/lib/onboard/schema.ts quotemate-automation/app/api/onboard/activate/route.ts
git commit -m "feat(onboard): require + consume invitation code at activate"
```

---

## Task 5: `/onboard` Step-0 gate UI

**Files:**
- Modify: `quotemate-automation/app/onboard/page.tsx`

The wizard currently has `step` typed `1 | 2 | 3` with `STEP_META[0..2]`. We add a Step-0 gate that must pass before the existing Step 1 renders. To keep the change small and avoid renumbering the whole wizard, we gate the wizard behind a `codeAccepted` boolean: until it's true, we render the code gate instead of the step card.

- [ ] **Step 1: Add code state + read from URL**

In `quotemate-automation/app/onboard/page.tsx`, inside `OnboardWizardInner`, after the `mobileLocked` block (line ~92), add:

```tsx
  // Invitation code. Web tradies type it here at the gate; SMS tradies
  // arrive with ?code=<code> pre-filled + locked (validated upstream).
  const codeFromUpstream = params.get('code') ?? ''
  const codeLocked = !!codeFromUpstream
  const [invitationCode, setInvitationCode] = useState(codeFromUpstream)
  const [codeAccepted, setCodeAccepted] = useState(false)
  const [codeChecking, setCodeChecking] = useState(false)
  const [codeError, setCodeError] = useState<string | null>(null)
  const [codeNote, setCodeNote] = useState<string | null>(null)
```

- [ ] **Step 2: Add the code field to the activate payload**

In the same file, in `handleActivate`, find the `payload` object (line ~208) and add `invitation_code`:

```tsx
      const payload = {
        ...form,
        trades: form.trades,
        state: form.state as 'NSW',
        intent_token: intentToken || undefined,
        invitation_code: invitationCode.trim(),
      }
```

- [ ] **Step 3: Add the gate check handler**

In the same file, after the `handleActivate` function, add:

```tsx
  async function checkCode() {
    const code = invitationCode.trim()
    if (!code) {
      setCodeError('Enter your invitation code to continue.')
      return
    }
    setCodeChecking(true)
    setCodeError(null)
    setCodeNote(null)
    try {
      const res = await fetch('/api/onboard/validate-code', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ code, channel: codeLocked ? 'sms' : 'web' }),
      })
      const data = await res.json()
      if (!data.ok) {
        setCodeError(data.message ?? 'That code was not accepted.')
        return
      }
      if (data.last_slot) setCodeNote('Heads up — this is the last sign-up slot for this code.')
      setCodeAccepted(true)
    } catch {
      setCodeError('Could not check the code just now. Try again.')
    } finally {
      setCodeChecking(false)
    }
  }

  // SMS tradies arrive pre-validated — auto-accept the locked code.
  useEffect(() => {
    if (codeLocked && !codeAccepted) setCodeAccepted(true)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [codeLocked])
```

- [ ] **Step 4: Render the gate before the step card**

In the same file, find the step-content container `<div className="mt-10 bg-ink-card border border-ink-line p-6 md:p-8">` (line ~304). Replace the line that opens that div and its `{step === 1 && (` block opener so the gate renders first. Concretely, immediately AFTER the closing `</div>` of the numbered step header (line ~301, the `</div>` that closes the `flex items-start gap-6` block) and BEFORE `{/* Step content */}`, insert:

```tsx
          {!codeAccepted && (
            <div className="mt-10 bg-ink-card border border-ink-line p-6 md:p-8">
              <Field
                label="Invitation code"
                hint={codeLocked ? 'From your text — locked' : 'The code whoever invited you gave you'}
                error={codeError ?? undefined}
              >
                <input
                  type="text"
                  value={invitationCode}
                  onChange={(e) => setInvitationCode(e.target.value.toUpperCase())}
                  placeholder="e.g. JON-JUNE-FLYERS-7K2P"
                  className={`${INPUT} ${codeLocked ? 'opacity-70 cursor-not-allowed' : ''}`}
                  readOnly={codeLocked}
                  autoCapitalize="characters"
                />
              </Field>
              {codeNote && (
                <p className="mt-3 text-sm text-amber-400 font-medium">{codeNote}</p>
              )}
              <div className="mt-6 flex justify-end">
                <PrimaryButton disabled={codeChecking} onClick={checkCode}>
                  {codeChecking ? 'Checking…' : 'Continue'}
                </PrimaryButton>
              </div>
            </div>
          )}
```

- [ ] **Step 5: Hide the step card + footer nav until the code is accepted**

In the same file, wrap the existing step-content `<div className="mt-10 bg-ink-card ...">` (line ~304) and the footer nav block (line ~338, `<div className="mt-8 flex items-center justify-between gap-3">`) so they only render when `codeAccepted`. Change `{/* Step content */}` block opener to:

```tsx
          {/* Step content — only after the invitation code passes */}
          {codeAccepted && (
          <div className="mt-10 bg-ink-card border border-ink-line p-6 md:p-8">
```

and add the matching `)}` after the footer-nav closing `</div>` (the one right before the closing `</div></div></main>` at line ~373). The progress dots + numbered header stay visible throughout.

- [ ] **Step 6: Type-check + lint**

Run: `cd quotemate-automation && npx tsc --noEmit`
Expected: no errors referencing `page.tsx`.
Run: `cd quotemate-automation && npm run lint -- app/onboard/page.tsx` (if a path-scoped lint isn't supported, run `npm run lint` and confirm no new errors in `app/onboard/page.tsx`).
Expected: clean.

- [ ] **Step 7: Manual browser check**

Start `npm run dev`, open `http://localhost:3000/onboard?business_name=Test&owner_first_name=T&owner_email=t@e.com&owner_mobile=0412345678`.
- Type `NOPE` → Continue → inline error "We don't recognise that code…".
- Type `TEST-SMOKE-AAAA` → Continue → gate disappears, Step 02 card appears.
- Reload with `&code=TEST-SMOKE-AAAA` appended → code field is pre-filled, locked, and the wizard skips straight to Step 02.

- [ ] **Step 8: Commit**

```bash
git add quotemate-automation/app/onboard/page.tsx
git commit -m "feat(onboard): invitation-code Step-0 gate in wizard"
```

---

## Task 6: SMS path — capture `JOIN <code>`

**Files:**
- Modify: `quotemate-automation/app/api/sms/inbound/route.ts` — `maybeHandleTradieRegistration(...)` branch (lines ~2569–2692).
- Modify: `quotemate-automation/lib/sms/templates.ts:174-198` — add `code?` to the two builders.
- Modify: `quotemate-automation/app/signup/page.tsx` — forward `&code=` to `/onboard`.

**Verified facts about the branch (don't re-guess):** the branch is `async function maybeHandleTradieRegistration(args: { fromNumber, toNumber, inboundBody, messageSid })`. The inbound text is `args.inboundBody`; sender `args.fromNumber`; destination `args.toNumber`. Outbound dispatch is `sendSms({ to, from, text })` inside an `after(...)`. The branch acks with `ackTwiml()`. The signup link is built at line ~2652-2653 via `buildTradieWelcomeSms({ appUrl, token })` / `buildTradieIntentStillOpenSms({ appUrl, token })` (defined in `lib/sms/templates.ts`), and points at `/signup?intent=<token>`. Branch entry is gated by `reusePriorTradieThread || isTradieIntent` (line ~2599) — a bare `JOIN <code>` would NOT classify as `tradie_registration`, so we must force entry.

- [ ] **Step 1: Import the checker**

In `quotemate-automation/app/api/sms/inbound/route.ts`, add next to the `createOrGetActiveIntent` import (line ~68):

```ts
import { checkInvitationCode } from '@/lib/onboard/invitation-codes'
```

- [ ] **Step 2: Add a code parser helper**

Near `function ackTwiml()` (line ~109), add a module-level helper:

```ts
/** Pull an invitation code from a registration text. Accepts
 *  "JOIN <code>" / "join <code>" or a bare hyphenated code token.
 *  Returns the upper-cased code or null. */
function parseJoinCode(body: string): string | null {
  const trimmed = (body ?? '').trim()
  const m = trimmed.match(/^\s*join\s+([A-Za-z0-9-]{3,60})\s*$/i)
  if (m) return m[1].toUpperCase()
  // Bare single-token code (no spaces) that looks like our format.
  if (/^[A-Za-z0-9]{2,8}(-[A-Za-z0-9]+){1,4}$/.test(trimmed)) return trimmed.toUpperCase()
  return null
}
```

- [ ] **Step 3: Force branch entry when a JOIN code is present**

In `maybeHandleTradieRegistration`, change the intent line (line ~2595-2596) so a JOIN code counts as tradie intent:

```ts
  const classification = await classifyIntent(args.inboundBody)
  const hasJoinCode = parseJoinCode(args.inboundBody) !== null
  const isTradieIntent = classification.intent === 'tradie_registration' || hasJoinCode
```

- [ ] **Step 4: Gate the branch on a valid code (after persisting the inbound message)**

Immediately AFTER step "4. Persist the inbound message." (the `await supabase.from('sms_messages').insert({...})` ending ~line 2637) and BEFORE "5. Get-or-create the active signup intent" (`const intent = await createOrGetActiveIntent(...)`, line ~2640), insert:

```ts
  // ── Invitation-code gate (SMS path) ──────────────────────────
  // Fresh registrations must include a valid code (CTA: "JOIN <code>").
  // A returning tradie re-texting an in-flight thread is already past
  // the gate, so a missing code on the reuse path is allowed through.
  const smsCode = parseJoinCode(args.inboundBody)
  if (smsCode) {
    const smsCodeCheck = await checkInvitationCode(supabase, smsCode)
    if (!smsCodeCheck.ok) {
      after(() => sendSms({ to: args.fromNumber, from: args.toNumber, text: smsCodeCheck.message }))
      return ackTwiml()
    }
  } else if (!reusePriorTradieThread) {
    after(() =>
      sendSms({
        to: args.fromNumber,
        from: args.toNumber,
        text: 'Welcome to QuoteMate! To start, reply with your invitation code, e.g. JOIN YOUR-CODE',
      }),
    )
    return ackTwiml()
  }
```

`smsCode` is now in scope for the link-builder call below.

- [ ] **Step 5: Add an optional `code` param to the two SMS builders**

In `quotemate-automation/lib/sms/templates.ts`, update `buildTradieWelcomeSms` (line ~174) and `buildTradieIntentStillOpenSms` (line ~189) to accept and append `code`:

```ts
export function buildTradieWelcomeSms(opts: {
  appUrl: string
  token: string
  code?: string
}): string {
  const link = `${opts.appUrl}/signup?intent=${opts.token}${opts.code ? `&code=${encodeURIComponent(opts.code)}` : ''}`
  const body =
    `G'day! Welcome to QuoteMate. Tap the link to set up your AI receptionist. ` +
    `Takes about 4 minutes.\n\n${link}\n\nYour mobile is already saved.\n\n- QuoteMate`
  return gsm7Safe(body)
}

export function buildTradieIntentStillOpenSms(opts: {
  appUrl: string
  token: string
  code?: string
}): string {
  const link = `${opts.appUrl}/signup?intent=${opts.token}${opts.code ? `&code=${encodeURIComponent(opts.code)}` : ''}`
  const body =
    `Still got your signup link open? Tap it here:\n\n${link}\n\n` +
    `Replies here won't progress your signup — finish on the web.\n\n- QuoteMate`
  return gsm7Safe(body)
}
```

Then update the call site in the inbound route (line ~2651-2653):

```ts
  const body = intent.reused
    ? buildTradieIntentStillOpenSms({ appUrl, token: intent.token, code: smsCode ?? undefined })
    : buildTradieWelcomeSms({ appUrl, token: intent.token, code: smsCode ?? undefined })
```

- [ ] **Step 6: Forward `&code=` from `/signup` to `/onboard`**

The SMS link lands on `/signup?intent=<token>&code=<code>`, and `/signup` forwards SMS-initiated tradies straight to `/onboard`. Find that redirect:

Run: `cd quotemate-automation && grep -n "router.push(\`/onboard\|/onboard?" app/signup/page.tsx`

At the redirect that builds the `/onboard?...` URL for the intent path, read `params.get('code')` and append it to the forwarded `URLSearchParams` (mirror how `owner_mobile`/`intent` are already forwarded):

```ts
  // Carry the SMS invitation code through so /onboard Step-0 pre-fills + locks it.
  const code = params.get('code') ?? ''
  if (code) next.set('code', code)
```
(Use the existing `URLSearchParams` variable name from that block — it may be `next`, `sp`, or similar.)

- [ ] **Step 7: Manual check (simulated inbound)**

With dev running and `TEST-SMOKE-AAAA` seeded, POST a Twilio-shaped registration text:
```bash
curl -s -X POST http://localhost:3000/api/sms/inbound \
  -H 'Content-Type: application/x-www-form-urlencoded' \
  --data-urlencode 'From=+61400000001' \
  --data-urlencode 'To=+61481613464' \
  --data-urlencode 'Body=JOIN TEST-SMOKE-AAAA' \
  --data-urlencode 'MessageSid=SMtest112a'
```
Expected: 200 ack; logs show the branch validated the code and the outbound welcome SMS link contains `&code=TEST-SMOKE-AAAA`. Repeat with `Body=JOIN NOPE` + a fresh `MessageSid` → friendly "we don't recognise that code" reply, no intent issued. Repeat with `Body=I want to sign up my business` (no code) + fresh `MessageSid` → "reply with your invitation code" prompt.

- [ ] **Step 8: Commit**

```bash
git add quotemate-automation/app/api/sms/inbound/route.ts quotemate-automation/lib/sms/templates.ts quotemate-automation/app/signup/page.tsx
git commit -m "feat(onboard): gate SMS registration path behind JOIN <code>"
```

---

## Task 7: Dashboard API — generate / list / update codes

**Files:**
- Create: `quotemate-automation/app/api/dashboard/invites/codes/route.ts`
- Create: `quotemate-automation/app/api/dashboard/invites/codes/[id]/route.ts`

- [ ] **Step 1: Implement list (GET) + generate (POST)**

Create `quotemate-automation/app/api/dashboard/invites/codes/route.ts`:

```ts
// /api/dashboard/invites/codes
//   GET  → list the caller's codes (tenant-scoped). Platform admins also
//          see platform-wide (tenant_id IS NULL) codes.
//   POST → generate a code. Tenant admins may ONLY create tenant-scoped
//          codes; platform-wide requires PLATFORM_ADMIN_USER_IDS membership.
//
// Auth: Authorization: Bearer <supabase access token> (same as /api/tenant/me).

import { createClient } from '@supabase/supabase-js'
import { z } from 'zod'
import { generateInvitationCode, isPlatformAdmin } from '@/lib/onboard/invitation-codes'

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

async function tenantForUser(userId: string) {
  const { data } = await supabase
    .from('tenants')
    .select('id, business_name')
    .eq('owner_user_id', userId)
    .maybeSingle()
  return data
}

export async function GET(req: Request) {
  const user = await userFromBearer(req)
  if (!user) return Response.json({ error: 'unauthorized' }, { status: 401 })
  const tenant = await tenantForUser(user.id)
  if (!tenant) return Response.json({ error: 'no_tenant' }, { status: 404 })

  const admin = isPlatformAdmin(user.id)
  let query = supabase
    .from('onboarding_codes')
    .select('id, code, tenant_id, campaign, description, quota_total, quota_used, status, expires_at, created_at')
    .order('created_at', { ascending: false })

  // Tenant admins: own codes only. Platform admins: own + platform-wide.
  query = admin
    ? query.or(`tenant_id.eq.${tenant.id},tenant_id.is.null`)
    : query.eq('tenant_id', tenant.id)

  const { data, error } = await query
  if (error) return Response.json({ error: error.message }, { status: 500 })
  return Response.json({ codes: data ?? [], is_platform_admin: admin })
}

const GenerateBody = z.object({
  scope: z.enum(['tenant', 'platform']).default('tenant'),
  quota_total: z.coerce.number().int().positive().max(100000),
  campaign: z.string().trim().min(1).max(40),
  description: z.string().trim().max(200).optional().or(z.literal('')),
  expires_at: z.string().datetime().optional().or(z.literal('')),
})

export async function POST(req: Request) {
  const user = await userFromBearer(req)
  if (!user) return Response.json({ error: 'unauthorized' }, { status: 401 })
  const tenant = await tenantForUser(user.id)
  if (!tenant) return Response.json({ error: 'no_tenant' }, { status: 404 })

  let raw: unknown
  try {
    raw = await req.json()
  } catch {
    return Response.json({ error: 'invalid_json' }, { status: 400 })
  }
  const parsed = GenerateBody.safeParse(raw)
  if (!parsed.success) {
    return Response.json({ error: 'invalid_request', details: parsed.error.flatten() }, { status: 400 })
  }
  const body = parsed.data

  // R2 authorization: only platform admins may mint platform-wide codes.
  if (body.scope === 'platform' && !isPlatformAdmin(user.id)) {
    return Response.json({ error: 'forbidden_scope' }, { status: 403 })
  }
  const tenantId = body.scope === 'platform' ? null : tenant.id
  const prefix = body.scope === 'platform' ? 'QM' : tenant.business_name

  // Generate with collision retry against the unique(lower(code)) index.
  let created: { id: string; code: string } | null = null
  for (let i = 0; i < 5 && !created; i++) {
    const code = generateInvitationCode(prefix, body.campaign)
    const { data, error } = await supabase
      .from('onboarding_codes')
      .insert({
        code,
        tenant_id: tenantId,
        campaign: body.campaign,
        description: body.description || null,
        quota_total: body.quota_total,
        expires_at: body.expires_at || null,
        created_by: user.id,
      })
      .select('id, code')
      .single()
    if (!error && data) {
      created = data
      break
    }
    if (error && error.code !== '23505') {
      return Response.json({ error: error.message }, { status: 500 })
    }
    // 23505 → code collision, loop and regenerate.
  }
  if (!created) {
    return Response.json({ error: 'could_not_generate_unique_code' }, { status: 500 })
  }
  return Response.json({ ok: true, ...created, tenant_id: tenantId })
}
```

- [ ] **Step 2: Implement update (PATCH)**

Create `quotemate-automation/app/api/dashboard/invites/codes/[id]/route.ts`:

```ts
// PATCH /api/dashboard/invites/codes/[id] — update status / quota / expiry.
// Quota can only be RAISED (never below quota_used). Caller must own the
// code's tenant (or be a platform admin for platform-wide codes).

import { createClient } from '@supabase/supabase-js'
import { z } from 'zod'
import { isPlatformAdmin } from '@/lib/onboard/invitation-codes'

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

const PatchBody = z.object({
  status: z.enum(['active', 'paused', 'revoked']).optional(),
  quota_total: z.coerce.number().int().positive().max(100000).optional(),
  expires_at: z.string().datetime().nullable().optional(),
})

export async function PATCH(req: Request, ctx: { params: Promise<{ id: string }> }) {
  const { id } = await ctx.params // Next 16: params is a Promise
  const user = await userFromBearer(req)
  if (!user) return Response.json({ error: 'unauthorized' }, { status: 401 })

  let raw: unknown
  try {
    raw = await req.json()
  } catch {
    return Response.json({ error: 'invalid_json' }, { status: 400 })
  }
  const parsed = PatchBody.safeParse(raw)
  if (!parsed.success) {
    return Response.json({ error: 'invalid_request', details: parsed.error.flatten() }, { status: 400 })
  }

  // Load the code + ownership context.
  const { data: code } = await supabase
    .from('onboarding_codes')
    .select('id, tenant_id, quota_used')
    .eq('id', id)
    .maybeSingle()
  if (!code) return Response.json({ error: 'not_found' }, { status: 404 })

  // Ownership: platform-wide codes need platform admin; tenant codes need
  // the caller to own that tenant.
  if (code.tenant_id === null) {
    if (!isPlatformAdmin(user.id)) return Response.json({ error: 'forbidden' }, { status: 403 })
  } else {
    const { data: tenant } = await supabase
      .from('tenants')
      .select('id')
      .eq('owner_user_id', user.id)
      .maybeSingle()
    if (!tenant || tenant.id !== code.tenant_id) {
      return Response.json({ error: 'forbidden' }, { status: 403 })
    }
  }

  const updates = parsed.data
  if (updates.quota_total !== undefined && updates.quota_total < (code.quota_used as number)) {
    return Response.json(
      { error: 'quota_below_used', message: `Quota cannot drop below ${code.quota_used} already used.` },
      { status: 422 },
    )
  }

  const patch: Record<string, unknown> = {}
  if (updates.status !== undefined) patch.status = updates.status
  if (updates.quota_total !== undefined) patch.quota_total = updates.quota_total
  if (updates.expires_at !== undefined) patch.expires_at = updates.expires_at
  if (Object.keys(patch).length === 0) return Response.json({ ok: true, noop: true })

  const { error } = await supabase.from('onboarding_codes').update(patch).eq('id', id)
  if (error) return Response.json({ error: error.message }, { status: 500 })
  return Response.json({ ok: true })
}
```

- [ ] **Step 3: Manual auth check**

Get a tradie access token (sign in on the dashboard, copy the Supabase token from devtools/localStorage), then:
```bash
TOKEN=<paste>
# Generate a tenant code:
curl -s -X POST http://localhost:3000/api/dashboard/invites/codes -H "Authorization: Bearer $TOKEN" -H 'Content-Type: application/json' -d '{"scope":"tenant","quota_total":50,"campaign":"plan_test"}'
# Expect: {"ok":true,"id":"...","code":"<BIZ>-PLAN-TEST-XXXX","tenant_id":"..."}
# Platform scope as a non-admin tradie → 403:
curl -s -o /dev/null -w '%{http_code}\n' -X POST http://localhost:3000/api/dashboard/invites/codes -H "Authorization: Bearer $TOKEN" -H 'Content-Type: application/json' -d '{"scope":"platform","quota_total":50,"campaign":"x"}'
# Expect: 403
# List:
curl -s http://localhost:3000/api/dashboard/invites/codes -H "Authorization: Bearer $TOKEN"
```

- [ ] **Step 4: Commit**

```bash
git add quotemate-automation/app/api/dashboard/invites/codes/route.ts quotemate-automation/app/api/dashboard/invites/codes/[id]/route.ts
git commit -m "feat(dashboard): invite-code generate/list/update endpoints with authz"
```

---

## Task 8: Dashboard codes UI (`/dashboard/invites`)

**Files:**
- Create: `quotemate-automation/app/dashboard/invites/page.tsx`

This is a client page that reads the Supabase session token, lists codes, and offers a generate form. Match the existing dashboard's Maintain-design tokens (`ink-card`, `ink-line`, `accent`, `text-*`). Reuse the browser Supabase client (`@/lib/supabase/client`) for the token, exactly as other dashboard pages do.

- [ ] **Step 1: Implement the page**

Create `quotemate-automation/app/dashboard/invites/page.tsx`:

```tsx
// /dashboard/invites — generate + manage invitation codes.
'use client'

import { useEffect, useState, useCallback } from 'react'
import { getBrowserSupabase } from '@/lib/supabase/client'

type Code = {
  id: string
  code: string
  tenant_id: string | null
  campaign: string | null
  description: string | null
  quota_total: number
  quota_used: number
  status: 'active' | 'paused' | 'revoked'
  expires_at: string | null
  created_at: string
}

async function authHeader(): Promise<Record<string, string>> {
  const supabase = getBrowserSupabase()
  const { data } = await supabase.auth.getSession()
  const token = data.session?.access_token ?? ''
  return { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' }
}

export default function InvitesPage() {
  const [codes, setCodes] = useState<Code[]>([])
  const [isAdmin, setIsAdmin] = useState(false)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)

  // Generate form state.
  const [campaign, setCampaign] = useState('')
  const [quota, setQuota] = useState('100')
  const [scope, setScope] = useState<'tenant' | 'platform'>('tenant')
  const [generating, setGenerating] = useState(false)
  const [justMade, setJustMade] = useState<string | null>(null)

  const load = useCallback(async () => {
    setLoading(true)
    try {
      const res = await fetch('/api/dashboard/invites/codes', { headers: await authHeader() })
      const data = await res.json()
      if (!res.ok) throw new Error(data.error ?? 'Failed to load codes')
      setCodes(data.codes ?? [])
      setIsAdmin(!!data.is_platform_admin)
    } catch (e: any) {
      setError(e?.message ?? 'Failed to load')
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => { load() }, [load])

  async function generate() {
    if (!campaign.trim()) { setError('Campaign name required'); return }
    setGenerating(true)
    setError(null)
    setJustMade(null)
    try {
      const res = await fetch('/api/dashboard/invites/codes', {
        method: 'POST',
        headers: await authHeader(),
        body: JSON.stringify({ scope, campaign: campaign.trim(), quota_total: Number(quota) }),
      })
      const data = await res.json()
      if (!res.ok) throw new Error(data.error ?? 'Generate failed')
      setJustMade(data.code)
      setCampaign('')
      await load()
    } catch (e: any) {
      setError(e?.message ?? 'Generate failed')
    } finally {
      setGenerating(false)
    }
  }

  async function patch(id: string, body: Record<string, unknown>) {
    const res = await fetch(`/api/dashboard/invites/codes/${id}`, {
      method: 'PATCH', headers: await authHeader(), body: JSON.stringify(body),
    })
    if (res.ok) load()
    else {
      const d = await res.json().catch(() => ({}))
      setError(d.message ?? d.error ?? 'Update failed')
    }
  }

  return (
    <main className="mx-auto max-w-5xl px-6 py-10">
      <h1 className="font-extrabold uppercase tracking-tight text-2xl text-text-pri">Invitation codes</h1>
      <p className="mt-2 text-text-sec">Generate codes for flyers, ads, and referrals. Each code carries a sign-up quota.</p>

      {/* Generate */}
      <div className="mt-8 bg-ink-card border border-ink-line p-6">
        <div className="grid gap-4 md:grid-cols-3">
          <label className="block">
            <span className="font-mono text-[0.7rem] uppercase tracking-[0.14em] text-text-dim">Campaign</span>
            <input value={campaign} onChange={(e) => setCampaign(e.target.value)} placeholder="june_flyers"
              className="mt-1 w-full bg-ink-deep border border-ink-line px-3 py-2.5 text-text-pri focus:border-accent focus:outline-none" />
          </label>
          <label className="block">
            <span className="font-mono text-[0.7rem] uppercase tracking-[0.14em] text-text-dim">Quota</span>
            <input type="number" min="1" value={quota} onChange={(e) => setQuota(e.target.value)}
              className="mt-1 w-full bg-ink-deep border border-ink-line px-3 py-2.5 text-text-pri focus:border-accent focus:outline-none" />
          </label>
          {isAdmin && (
            <label className="block">
              <span className="font-mono text-[0.7rem] uppercase tracking-[0.14em] text-text-dim">Scope</span>
              <select value={scope} onChange={(e) => setScope(e.target.value as 'tenant' | 'platform')}
                className="mt-1 w-full bg-ink-deep border border-ink-line px-3 py-2.5 text-text-pri focus:border-accent focus:outline-none">
                <option value="tenant" className="bg-ink-deep">My campaign</option>
                <option value="platform" className="bg-ink-deep">Platform-wide</option>
              </select>
            </label>
          )}
        </div>
        <button onClick={generate} disabled={generating}
          className="mt-4 bg-accent hover:bg-accent-press text-white font-semibold px-6 py-3 text-sm uppercase tracking-wider disabled:opacity-50">
          {generating ? 'Generating…' : 'Generate code'}
        </button>
        {justMade && (
          <p className="mt-4 text-sm text-text-pri">
            New code: <span className="font-mono text-accent">{justMade}</span>{' '}
            <button onClick={() => navigator.clipboard.writeText(justMade)} className="underline ml-2">Copy</button>
          </p>
        )}
      </div>

      {error && <p className="mt-4 text-sm text-red-400">{error}</p>}

      {/* List */}
      <div className="mt-8 bg-ink-card border border-ink-line">
        {loading ? (
          <p className="p-6 text-text-dim">Loading…</p>
        ) : codes.length === 0 ? (
          <p className="p-6 text-text-dim">No codes yet. Generate one above.</p>
        ) : (
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b border-ink-line text-left font-mono text-[0.65rem] uppercase tracking-[0.14em] text-text-dim">
                <th className="px-4 py-3">Code</th><th className="px-4 py-3">Campaign</th>
                <th className="px-4 py-3">Used</th><th className="px-4 py-3">Status</th><th className="px-4 py-3">Actions</th>
              </tr>
            </thead>
            <tbody>
              {codes.map((c) => (
                <tr key={c.id} className="border-b border-ink-line/60">
                  <td className="px-4 py-3 font-mono text-text-pri">
                    {c.code}{c.tenant_id === null && <span className="ml-2 text-[0.6rem] text-accent uppercase">platform</span>}
                  </td>
                  <td className="px-4 py-3 text-text-sec">{c.campaign ?? '—'}</td>
                  <td className="px-4 py-3 text-text-sec">{c.quota_used}/{c.quota_total}</td>
                  <td className="px-4 py-3">
                    <span className={c.status === 'active' ? 'text-emerald-400' : 'text-text-dim'}>{c.status}</span>
                  </td>
                  <td className="px-4 py-3 flex gap-3">
                    <button onClick={() => navigator.clipboard.writeText(c.code)} className="text-text-sec hover:text-text-pri underline">Copy</button>
                    {c.status === 'active' ? (
                      <button onClick={() => patch(c.id, { status: 'paused' })} className="text-text-sec hover:text-text-pri underline">Pause</button>
                    ) : c.status === 'paused' ? (
                      <button onClick={() => patch(c.id, { status: 'active' })} className="text-text-sec hover:text-text-pri underline">Resume</button>
                    ) : null}
                    {c.status !== 'revoked' && (
                      <button onClick={() => patch(c.id, { status: 'revoked' })} className="text-red-400 hover:text-red-300 underline">Revoke</button>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>
    </main>
  )
}
```

- [ ] **Step 2: Type-check**

Run: `cd quotemate-automation && npx tsc --noEmit`
Expected: no errors referencing `app/dashboard/invites/page.tsx`. (If `getBrowserSupabase` import path differs, match the path used in `app/signup/verify/page.tsx`: `@/lib/supabase/client`.)

- [ ] **Step 3: Manual browser check**

Sign in as a tradie, visit `http://localhost:3000/dashboard/invites`. Generate a code → it appears in the list with `0/<quota>` and status `active`. Pause/Resume/Revoke toggle the status. Copy puts the code on the clipboard.

- [ ] **Step 4: Add a nav entry (if the dashboard has a nav)**

If `app/dashboard` has a shared nav/sidebar component, add a link to `/dashboard/invites` labelled "Invite codes". Search: `grep -rl "dashboard/quotes\|dashboard/services" quotemate-automation/app/dashboard` to find the nav file, then mirror an existing link entry. If no shared nav exists, skip — the route is reachable directly.

- [ ] **Step 5: Commit**

```bash
git add quotemate-automation/app/dashboard/invites/page.tsx
git commit -m "feat(dashboard): invitation-codes management UI"
```

---

## Final verification

- [ ] **Run the full unit-test file for the lib:** `cd quotemate-automation && npx vitest run lib/onboard/invitation-codes.test.ts` — all green.
- [ ] **Type-check the whole app:** `cd quotemate-automation && npx tsc --noEmit` — no new errors.
- [ ] **Confirm the four spec refinements are live:** OTP still precedes the code (R1 — code is in the wizard, after `/signup/verify`); a non-admin tradie gets 403 on platform scope (R2); generated codes have a random suffix (R3); the SMS branch refuses to issue an intent token without a valid `JOIN <code>` (R4).
- [ ] **Push the branch** (only when the user asks): `git push -u origin feat/invitation-codes`.

---

## Spec coverage check

| Spec section | Task(s) |
|---|---|
| §3 capture-vs-validate, both paths | Tasks 5 (web Step-0), 6 (SMS), 4 (re-check at activate) |
| §4.1 `onboarding_codes` | Task 1 |
| §4.2 `code_redemptions` ledger | Task 1 |
| §4.3 `tenants.used_onboarding_code_id` | Task 1 |
| §4.4 RLS on + no public policy | Task 1 (Step 1) |
| §5.1 `validate-code` check | Task 3 |
| §5.2 SMS `JOIN <code>` capture | Task 6 |
| §5.3 generate-code + R2 authz | Task 7 |
| §5.4 idempotent consume-at-activate | Tasks 2 (helper + RPC), 4 (wiring) |
| §5.5 list + PATCH (quota raise-only) | Task 7 |
| §6.1/§6.2 code entry + Step-0 gate | Task 5 (consolidated — see header note) |
| §6.3 dashboard UI | Task 8 |
| §7 friendly errors / casing / last_slot | Tasks 2, 3, 5 |
| R1 allowlist framing | Inherent (OTP precedes code) |
| R2 tenant-admin authz | Task 7 |
| R3 unguessable suffix | Task 2 |
| R4 SMS gate | Task 6 |
| §10(a) staff identification | `PLATFORM_ADMIN_USER_IDS` env (Tasks 2, 7) |
| §10(b) suffix length | 4 chars (Task 2) |

**Out of scope (per spec §9):** tradie→customer QR marketing, referral-reward UI, RLS Phase 2 — no tasks, by design.
