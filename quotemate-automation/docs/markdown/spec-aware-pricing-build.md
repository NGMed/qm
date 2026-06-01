# Spec-aware pricing — build spec (Phase 0 + Phase 1)

> Source-of-truth for the Ralph build loop. Fixes the "agreed-spec → wrong-material lock" class
> (the 15A-sauna bug: receptionist agreed a 15A GPO, quote locked a 10A GPO). This file scopes
> ONLY Phase 0 + Phase 1 — the no-migration, no-money-path foundation. Later phases listed at the
> bottom for context but are NOT in scope for this loop.

## Why (root causes — already verified)
- **RC1 capture loses the spec:** `lib/sms/extract-slots.ts` `circuit_required` enum is `['10A','20A','three-phase','unknown']` — no `15A`; "15 amp" coerces to `20A` in live data. No general "requested specs" structure exists.
- **RC2 selection is spec-blind:** `lib/sms/product-options.ts` `selectProductOptions()` picks by category + price only.
- **RC3 no reconciliation:** `applyChosenProduct()` forces the chosen product; the grounding validator checks price + coarse category only — nothing compares a material's spec to the agreed spec.

Phase 0 builds the pure reconciliation primitives; Phase 1 makes capture faithful on BOTH channels.
Neither phase touches the money path (no changes to validate.ts, applyChosenProduct, selectProductOptions, routing).

---

## PHASE 0 — pure modules + unit tests (code only, no pipeline wiring)

### NEW `lib/estimate/spec-registry.ts`
Pure, dependency-free (mirror the style of `lib/estimate/price-bands.ts`).

```
export type SpecDef = { key: string; hard?: boolean }

// Normalise a spec value to a canonical token, or null when it cannot be confidently parsed.
// canonicalise-miss (null) is treated as UNKNOWN by callers — NEVER as a mismatch.
export function canonicalise(key: string, value: string | number | null | undefined): string | null

// Which spec keys matter for a (trade, category). Code-seeded. Returns [] for unknown combos (degrade).
export function getSpecDefs(trade: string | null | undefined, category: string | null | undefined): SpecDef[]
```

**canonicalise rules (per key, case-insensitive, trimmed):**
- `amperage`: parse a number immediately before `a`/`amp`/`amps` → `"15A"`, `"20A"`, `"10A"`, `"32A"`. `"15 amp"`,`"15amp"`,`"15A"` → `"15A"`. If no amp number found → `null`. (Three-phase is NOT an amperage — returns null here.)
- `phase`: `"single"`/`"1 phase"`/`"single phase"` → `"single-phase"`; `"three"`/`"3 phase"`/`"3-phase"`/`"3φ"`/`"three-phase"` → `"three-phase"`; else null.
- `ip_rating`: extract `/ip\s?(\d{2})/i` → `"IP" + digits` (`"ip 56"`,`"ip56"`,`"IP56"` → `"IP56"`); else null. (Bare "weatherproof" → null/unknown for now.)
- `energy_source`: `"gas"`→`"gas"`; `"electric"`/`"electrical"`→`"electric"`; `"heat pump"`/`"heatpump"`/`"heat-pump"`→`"heat-pump"`; `"solar"`→`"solar"`; else null.
- `litres`: parse leading digits, strip `L`/`litre`/`litres` → `"250"` (`"250L"`,`"250 litre"`,`"250"` → `"250"`); else null.
- `poles`: `"single"`/`"1"`→`"single"`; `"double"`/`"2"`→`"double"`; else null.
- default (unknown key): `String(value).trim().toLowerCase()` passthrough (so unrecognised keys still compare deterministically).

**getSpecDefs seed (category vocabulary = the WP9 categories from product-options.ts JOB_TYPE_CATEGORY):**
- `electrical` + `gpo` → `[{key:'amperage'}]`
- `electrical` + `outdoor_light` → `[{key:'ip_rating'}]`
- `plumbing` + `hot_water` → `[{key:'energy_source'}, {key:'litres'}]`
- everything else → `[]`
(More can be added later; keep it small + obviously correct now.)

### NEW `lib/estimate/spec-reconcile.ts`
```
export type RequestedSpecs = Record<string, string> | null | undefined
export type ProductProperties = Record<string, string | number | boolean> | null | undefined
export type SpecConflict = { key: string; requested: string; product: string }
export type ReconcileResult = { verdict: 'match' | 'mismatch' | 'unknown'; conflicts: SpecConflict[] }

export function reconcileSpecs(
  requested: RequestedSpecs,
  productProps: ProductProperties,
  trade: string | null | undefined,
  category: string | null | undefined,
): ReconcileResult
```
**Algorithm:**
1. If `requested` is null/empty → return `{verdict:'match', conflicts:[]}` (vacuous — degrade-never-block).
2. `defs = getSpecDefs(trade, category)`. Build the key set: if `defs.length > 0`, use `requestedKeys ∩ defs.keys`; else (registry miss) use all `requestedKeys` (raw-compare fallback so we still catch obvious contradictions).
3. For each key K:
   - `reqC = canonicalise(K, requested[K])`. If `reqC === null` → key is **unknown** (can't understand request).
   - `prodRaw = productProps?.[K]`. If `prodRaw == null` → **unknown** (product spec absent; Phase-3 gap-rule handles "populated elsewhere" later — NOT here).
   - `prodC = canonicalise(K, String(prodRaw))`. If `prodC === null` → **unknown**.
   - else `prodC === reqC` → **match**; otherwise → **mismatch** (push `{key:K, requested:reqC, product:prodC}`).
4. `verdict = 'mismatch'` if any mismatch; else `'unknown'` if any unknown; else `'match'`.

### Tests (vitest) — `lib/estimate/spec-registry.test.ts` + `lib/estimate/spec-reconcile.test.ts`
Must cover at minimum:
- amperage: `"15 amp"`→`"15A"`, `"15A"`→`"15A"`, `"three phase"` (key amperage)→null.
- reconcile **mismatch**: requested `{amperage:"15A"}` vs product `{amperage:"10A"}`, electrical/gpo → `verdict:'mismatch'` with one conflict.
- reconcile **mismatch**: requested `{ip_rating:"IP56"}` vs `{ip_rating:"IP20"}`, electrical/outdoor_light.
- reconcile **mismatch**: requested `{energy_source:"gas"}` vs `{energy_source:"electric"}`, plumbing/hot_water.
- reconcile **match**: requested `{amperage:"15A"}` vs `{amperage:"15 amp"}` (canonical equality across sloppy forms).
- **vacuous match**: empty/null requested → `match`.
- **unknown on missing property**: requested `{amperage:"15A"}` vs product `{}` → `unknown`.
- **sloppy free-text must NOT false-mismatch:** a product whose *name* is "Clipsal 2000 GPO 10A/15A combo" but whose structured `properties` has no `amperage` key → `unknown`, never `mismatch` (reconcile reads structured props, not the name).
- canonicalise-miss path: requested `{amperage:"fifteenish"}` → `unknown`, not mismatch.

**Phase-0 modules MUST NOT be imported by any live pipeline file yet.**

---

## PHASE 1 — faithful capture on both channels (alongside circuit_required)

Do **NOT** remove or alter `circuit_required` or its 15A-reject test (`extract-slots.test.ts`). The recipe engine keeps using it. We ADD a parallel open bag.

### `lib/sms/extract-slots.ts`
- Add to the Zod slots schema: `requested_specs: z.record(z.string()).nullable().optional()`.
- Update the extractor prompt: instruct it to record ANY spec the customer states, verbatim-but-keyed, e.g. `{amperage:"15A"}`, `{ip_rating:"IP56"}`, `{energy_source:"gas", litres:"250"}`. Keep filling `circuit_required` as before (unchanged).
- Ensure `requested_specs` survives the slot merge/persist path into `conversation_state.slots` and is projected into `intake.scope.specs.requested_specs` wherever specs are assembled.

### `lib/intake/structure.ts` (voice — live channel)
- Add the same `requested_specs` open-map field to the intake structurer schema + prompt so a Vapi caller who SAYS "15 amp" also populates `intake.scope.specs.requested_specs`.

### Tests
- Extend `extract-slots.test.ts`: a "15 amp" / "15A" message now yields `requested_specs.amperage` ≈ `"15A"` (verbatim-ish; canonicalisation happens later in Phase 0 modules, not in capture) AND `circuit_required` enum test still passes unchanged.
- Add/extend a structurer test for the voice path capturing `requested_specs`.

---

## CONSTRAINTS
- Read `quotemate-automation/AGENTS.md` and the relevant `node_modules/next/dist/docs/` guide before writing any Next.js code. This is Next.js 16 — not training-data Next.
- Money-path files MUST NOT change in Phase 0/1: `lib/estimate/validate.ts`, `applyChosenProduct` in `lib/estimate/catalogue.ts`, `lib/sms/product-options.ts` selection, `lib/routing/*`.
- AU/NZ formatting + conventions. Pure modules stay pure (no I/O).

## COMPLETION GATE — "All tests pass" means ALL of:
1. `npx vitest run` — the entire suite green (currently ~853+ lib tests), including the new Phase-0 tests and the unchanged `circuit_required` 15A-reject test.
2. `npx next build` (or the repo's build script) succeeds with zero new errors.
3. No money-path file changed.
Only then emit the promise.

---

## PHASE 2 — surface `properties` + `trade` (code + migration FILE only; no prod apply)
- `lib/estimate/catalogue.ts` `TenantMaterial`: add `properties?: Record<string, string | number | boolean | null> | null` and `trade?: string | null`. Add `properties` to `ChosenProductInput`.
- WP9 catalogue read `app/api/sms/inbound/route.ts:~1784`: add `properties, trade` to `.select(...)`.
- `lib/sms/product-options.ts`: add `properties` to `ProductOption` + `ChosenProduct` (carry through `selectProductOptions`/`chosenProductFromChoice`), and `trade` onto `ProductChoiceState` so the chosen product reaches the estimator with its specs.
- Migration FILE `sql/migrations/082_catalogue_properties_index.sql` + `scripts/run-migration-082.mjs`: GIN index on `tenant_material_catalogue.properties` (column already exists, mig 028). Additive. DO NOT apply to prod in the loop — leave for confirm-first.
- NOTE: `next build` + tests only verify code; the migration is inert until applied.

## PHASE 3 — reconcile guard at the lock point (code; SHADOW default)
- NEW pure `lib/estimate/spec-guard.ts`: `specGuardMode(env): 'off'|'shadow'|'enforce'` (reads `SPEC_GUARD_MODE`, DEFAULT `'shadow'`); `effectiveProductProps(properties, name, keys)` (start from structured `properties`; for any requested key missing, fall back to `canonicalise(key, name)` so today's named-but-unspec'd "…GPO 10A" is still caught); `evaluateSpecGuard({requested, properties, name, trade, category, mode})` → `{verdict, conflicts, block, reason}` where `block = mode==='enforce' && verdict==='mismatch'`. Pure + fully unit-tested.
- Wire into `lib/estimate/run.ts` WP9 block (~497): compute the decision from `intake.scope.specs.requested_specs` + the live catalogue row's `properties` + `chosen.name`, trade = `intake.trade`, category = `chosen.category ?? categoryForJobType(job_type)`. ALWAYS `cacheLog` the verdict (shadow data). If `decision.block`, SKIP `applyChosenProduct` (keep the conventional grounded Good/Better/Best — never lock a contradicting product) and log loudly. Shadow (default) = no behaviour change.
- DEGRADE-NEVER-BLOCK: empty requested → match; unknown → never blocks.

## PHASE 4 — spec-aware selection (code)
- `lib/sms/product-options.ts` `selectProductOptions(rows, category, opts?)`: optional `opts.requestedSpecs` + `opts.trade`. Partition `usable` via `reconcileSpecs` into match / unknown / conflict. DROP conflicts; build Good/Better from `[...match, ...unknown]` (match ranked first), price-sorted within. When NO product matches and specs were requested, FALL BACK to today's price-only behaviour over all `usable` (never empty-offer). Spec-match outranks `tier_hint`/`is_preferred`.
- `app/api/sms/inbound/route.ts` WP9 offer (~1788): pass `requestedSpecs` (from `conversationState.slots.requested_specs`) + `trade`.
- Tests for partition + fallback + degrade.

## PHASE 5 — enforce + coverage-gated catalogue-gap (code + config; default stays shadow)
- Enforce already implemented via `SPEC_GUARD_MODE=enforce` in Phase 3.
- Add to `spec-guard.ts` a pure coverage-gap check: given the FULL set of the tenant's active rows in the (trade, category) and the chosen row, for each requested key — if the key is canonicalisably present on `>= COVERAGE_MIN_FRACTION` (default 0.8) of those rows AND `>= COVERAGE_MIN_ROWS` (default 3) but ABSENT/!= on the chosen row → treat as mismatch. Below threshold → unknown (never block). Canonicalise at READ time. Wired into the guard, only consulted in enforce mode. Fully unit-tested with the threshold edge cases.
- `run.ts` passes the tenant's category rows (from `catalogueRefs`) to the guard.

## PHASE 6 — data freshness (migration FILES + backfill + registry fallback; UI minimal)
- Migration FILE `083_trade_spec_defs.sql` + runner: additive `trade_spec_defs(trade, category, spec_key, ...)`; and widen `tenant_material_catalogue.trade` CHECK to drop the 2-trade restriction (or reference a trades list) so v9 trades can insert. Additive; confirm-first for prod.
- `spec-registry.ts`: `getSpecDefs` reads injected table rows FIRST, falls back to the code seed on miss; the code seed ALWAYS wins canonical-grammar (canonicalise stays code-only). Keep it pure (table rows injected, not fetched here).
- Backfill SCRIPT `scripts/backfill-catalogue-properties.mjs` (dry-run default; `--apply`): for each catalogue row with an empty/absent spec key that the registry cares about, parse from `name` via the canonicaliser and SET `properties[key]` — NEVER overwrite a tradie-set value. Report counts. DO NOT auto-apply.
- Forward-fill (so the data doesn't rot): add optional spec columns to the CSV supplier importer column-map (canonicalised on import) as the minimal write path. Pricing-wizard + services-editor spec editors are a follow-up (note in the report), not blocking.

## COMPLETION GATE (unchanged): entire vitest suite green + `next build` succeeds + no UNINTENDED money-path behaviour change (guard ships SHADOW by default). Prod migrations/backfill are written but NOT applied (confirm-first).
