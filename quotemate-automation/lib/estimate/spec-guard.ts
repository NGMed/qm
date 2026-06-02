// Spec guard — the deterministic decision layer that sits at the WP9
// chosen-product LOCK POINT (lib/estimate/run.ts). It asks one question:
// does the product about to be locked into the quote CONTRADICT the spec the
// customer agreed to? If so, in ENFORCE mode it blocks the lock (the quote
// keeps its conventional grounded Good/Better/Best instead of a wrong-spec
// product); in SHADOW mode it only logs (so the over-block rate can be
// observed on real traffic before it ever touches the money path).
//
// Three guarantees (all proven in spec-guard.test.ts):
//   • DEFAULT MODE = 'shadow' — no behaviour change until SPEC_GUARD_MODE is
//     flipped to 'enforce'.
//   • DEGRADE-NEVER-BLOCK — only a positive same-key contradiction blocks;
//     unknown / missing / unparseable never does.
//   • NAME FALLBACK — when a product carries no structured spec for a
//     requested key, we parse it from the product NAME via the one
//     canonicaliser, so today's "…GPO 10A" rows are still caught while
//     `properties` is being back-filled.
//
// Pure + dependency-free except the registry/reconciler. Not wired anywhere
// it can throw the pipeline (the caller wraps it best-effort too).

import { canonicalise, getSpecDefs } from './spec-registry'
import {
  reconcileSpecs,
  type RequestedSpecs,
  type ProductProperties,
  type ReconcileVerdict,
  type SpecConflict,
} from './spec-reconcile'
import { weatherproofConflict } from './weatherproof'

export type SpecGuardMode = 'off' | 'shadow' | 'enforce'

/** Resolve the guard mode from the environment. DEFAULT 'shadow' — log-only,
 *  no behaviour change. Only an explicit 'off' or 'enforce' departs from it. */
export function specGuardMode(
  env: Record<string, string | undefined> = process.env,
): SpecGuardMode {
  const v = (env.SPEC_GUARD_MODE ?? '').trim().toLowerCase()
  if (v === 'off' || v === 'enforce' || v === 'shadow') return v
  return 'shadow'
}

function isBlank(v: unknown): boolean {
  return v === null || v === undefined || String(v).trim() === ''
}

/**
 * Build the product's "effective" spec map: its structured `properties`, plus
 * — for any requested key the properties don't carry — a best-effort value
 * parsed from the product NAME through the canonicaliser. This is what lets
 * the guard catch a "Clipsal 2000 series double GPO 10A" row whose
 * `properties` are still empty. Never invents a value the name doesn't
 * contain (canonicalise-miss → the key stays absent → unknown downstream).
 */
export function effectiveProductProps(
  properties: ProductProperties,
  name: string | null | undefined,
  keys: string[],
): Record<string, string | number | boolean | null> {
  const out: Record<string, string | number | boolean | null> =
    properties && typeof properties === 'object' ? { ...properties } : {}
  const nm = (name ?? '').trim()
  if (!nm) return out
  for (const key of keys) {
    if (!isBlank(out[key])) continue
    const parsed = canonicalise(key, nm)
    if (parsed !== null) out[key] = parsed
  }
  return out
}

/**
 * Reconcile a product against the customer's requested specs WITH the
 * name-parse fallback — the shared core used by both the guard (run.ts lock
 * point) and spec-aware selection (product-options.ts). Scopes the compared
 * keys to the (trade, category) registry when it has an opinion, else falls
 * back to the raw requested keys. Pure.
 */
export function reconcileProductSpecs(args: {
  requested: RequestedSpecs
  properties: ProductProperties
  name?: string | null
  trade?: string | null
  category?: string | null
}): { verdict: ReconcileVerdict; conflicts: SpecConflict[] } {
  const requested = args.requested
  const reqKeys =
    requested && typeof requested === 'object'
      ? Object.keys(requested).filter((k) => !isBlank(requested[k]))
      : []
  const defKeys = new Set(
    getSpecDefs(args.trade, args.category).map((d) => d.key.toLowerCase()),
  )
  const checkKeys =
    defKeys.size > 0 ? reqKeys.filter((k) => defKeys.has(k.toLowerCase())) : reqKeys
  const effective = effectiveProductProps(args.properties, args.name, checkKeys)
  const base = reconcileSpecs(requested, effective, args.trade, args.category)

  // Cross-cutting outdoor rule: an external/weather-exposed install needs a
  // weatherproof fitting. A non-weatherproof product is a positive mismatch
  // (so spec-aware selection won't prefer it and the guard flags it). Applies
  // to electrical fittings; skipped for plumbing/roofing where it's not a spec.
  const trade = (args.trade ?? '').toLowerCase()
  if (trade !== 'plumbing' && trade !== 'roofing') {
    const wp = weatherproofConflict(args.requested, args.properties, args.name)
    if (wp) return { verdict: 'mismatch', conflicts: [...base.conflicts, wp] }
  }
  return base
}

/** A catalogue row, narrowed to what the coverage-gap rule reads. */
export interface CategoryRow {
  properties?: ProductProperties
  name?: string | null
}

export const COVERAGE_MIN_FRACTION = 0.8
export const COVERAGE_MIN_ROWS = 3

/**
 * Coverage-gated catalogue-gap rule (the fake-lock killer). When a requested
 * spec key is canonicalisably present on a strong majority of the tenant's
 * rows in this category — i.e. the spec is clearly KNOWABLE here — but the
 * CHOSEN product does not carry it (or carries a different value), that's a
 * gap: the chosen product is silently missing a spec the catalogue otherwise
 * tracks, so it should NOT be fake-locked. Returns the offending conflicts.
 *
 * Conservative by construction: needs >= minRows rows AND >= minFraction
 * coverage before it fires. With today's empty `properties` it never fires
 * (coverage ~0) — it only activates as the data is populated. Pure.
 */
export function coverageGapConflicts(args: {
  requested: RequestedSpecs
  chosenProperties: ProductProperties
  chosenName?: string | null
  categoryRows: CategoryRow[]
  trade?: string | null
  category?: string | null
  minFraction?: number
  minRows?: number
}): SpecConflict[] {
  const minFraction = args.minFraction ?? COVERAGE_MIN_FRACTION
  const minRows = args.minRows ?? COVERAGE_MIN_ROWS
  const rows = args.categoryRows ?? []
  if (rows.length < minRows) return []

  const requested = args.requested
  const reqKeys =
    requested && typeof requested === 'object'
      ? Object.keys(requested).filter((k) => !isBlank(requested[k]))
      : []
  const defKeys = new Set(
    getSpecDefs(args.trade, args.category).map((d) => d.key.toLowerCase()),
  )
  const checkKeys =
    defKeys.size > 0 ? reqKeys.filter((k) => defKeys.has(k.toLowerCase())) : reqKeys
  if (checkKeys.length === 0) return []

  const chosenEff = effectiveProductProps(args.chosenProperties, args.chosenName, checkKeys)
  const out: SpecConflict[] = []
  for (const key of checkKeys) {
    const reqVal = canonicalise(key, requested![key])
    if (reqVal === null) continue
    const chosenVal = canonicalise(key, chosenEff[key])
    if (chosenVal === reqVal) continue // chosen product actually matches → no gap

    // How many rows in the category carry a canonicalisable value for this key?
    let present = 0
    for (const row of rows) {
      const eff = effectiveProductProps(row.properties ?? null, row.name, [key])
      if (canonicalise(key, eff[key]) !== null) present++
    }
    if (present / rows.length >= minFraction) {
      out.push({ key, requested: reqVal, product: chosenVal ?? 'absent' })
    }
  }
  return out
}

export interface SpecGuardDecision {
  verdict: ReconcileVerdict
  conflicts: SpecConflict[]
  /** true ONLY when mode==='enforce' AND a positive same-key contradiction
   *  was found. The caller skips the chosen-product lock when true. */
  block: boolean
  /** Human-readable reason on a mismatch (for logs + quote notes). */
  reason: string | null
}

/**
 * Evaluate the guard for a single chosen product. Pure.
 *   requested   — intake.scope.specs.requested_specs (the agreed specs)
 *   properties  — the chosen product's structured properties (may be empty)
 *   name        — the chosen product's name (for the canonicalise fallback)
 *   trade/category — which (trade, category) SpecDefs apply
 *   mode        — 'off' returns a no-op match; 'shadow'/'enforce' reconcile
 */
export function evaluateSpecGuard(args: {
  requested: RequestedSpecs
  properties: ProductProperties
  name?: string | null
  trade?: string | null
  category?: string | null
  mode?: SpecGuardMode
  /** All active rows in the chosen product's (tenant, category) — enables the
   *  coverage-gated catalogue-gap rule (enforce only). Omit to disable it. */
  categoryRows?: CategoryRow[]
  minFraction?: number
  minRows?: number
}): SpecGuardDecision {
  const mode = args.mode ?? 'shadow'
  if (mode === 'off') return { verdict: 'match', conflicts: [], block: false, reason: null }

  let { verdict, conflicts } = reconcileProductSpecs(args)

  // Coverage-gated catalogue-gap (enforce only): escalate an UNKNOWN to a
  // mismatch when the chosen product silently lacks a spec the category
  // clearly tracks. Never downgrades a match; never fires in shadow.
  if (mode === 'enforce' && verdict === 'unknown' && args.categoryRows?.length) {
    const gap = coverageGapConflicts({
      requested: args.requested,
      chosenProperties: args.properties,
      chosenName: args.name,
      categoryRows: args.categoryRows,
      trade: args.trade,
      category: args.category,
      minFraction: args.minFraction,
      minRows: args.minRows,
    })
    if (gap.length > 0) {
      verdict = 'mismatch'
      conflicts = gap
    }
  }

  const block = mode === 'enforce' && verdict === 'mismatch'
  const reason =
    verdict === 'mismatch'
      ? conflicts
          .map((c) => `${c.key}: requested ${c.requested} but product is ${c.product}`)
          .join('; ')
      : null
  return { verdict, conflicts, block, reason }
}
