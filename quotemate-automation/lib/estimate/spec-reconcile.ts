// Spec reconciliation — the deterministic guard primitive. Compares the
// customer's REQUESTED specs against a catalogue product's stored properties,
// key by key, through the one canonicaliser (spec-registry.ts), and returns a
// verdict: 'match' | 'mismatch' | 'unknown'.
//
// The two load-bearing invariants (both proven in spec-reconcile.test.ts):
//   • DEGRADE-NEVER-BLOCK: a missing/unparseable spec is UNKNOWN, never a
//     mismatch. Inspection (the eventual consumer) fires only on a positive
//     same-key contradiction — never on absence of data.
//   • Empty requested specs → vacuous 'match' (most jobs state no spec).
//
// Pure + dependency-free except for the registry. NOT wired into the live
// pipeline in Phase 0 — this is the primitive a later phase calls at the
// applyChosenProduct lock point and as a validator backstop.

import { canonicalise, getSpecDefs } from './spec-registry'

export type RequestedSpecs = Record<string, string> | null | undefined
export type ProductProperties =
  | Record<string, string | number | boolean | null>
  | null
  | undefined
export type SpecConflict = { key: string; requested: string; product: string }
export type ReconcileVerdict = 'match' | 'mismatch' | 'unknown'
export type ReconcileResult = { verdict: ReconcileVerdict; conflicts: SpecConflict[] }

function isBlank(v: unknown): boolean {
  return v === null || v === undefined || String(v).trim() === ''
}

/**
 * Reconcile requested specs against a product's properties for a (trade,
 * category). Iterates only the requested keys (intersected with the registry's
 * SpecDefs when the registry has an opinion; raw-compare fallback otherwise so
 * an unseeded category still catches an obvious contradiction).
 */
export function reconcileSpecs(
  requested: RequestedSpecs,
  productProps: ProductProperties,
  trade: string | null | undefined,
  category: string | null | undefined,
): ReconcileResult {
  const conflicts: SpecConflict[] = []
  if (!requested || typeof requested !== 'object') {
    return { verdict: 'match', conflicts }
  }

  const requestedKeys = Object.keys(requested).filter((k) => !isBlank(requested[k]))
  if (requestedKeys.length === 0) return { verdict: 'match', conflicts }

  const defKeys = new Set(getSpecDefs(trade, category).map((d) => d.key.toLowerCase()))
  const keys =
    defKeys.size > 0
      ? requestedKeys.filter((k) => defKeys.has(k.toLowerCase()))
      : requestedKeys
  if (keys.length === 0) return { verdict: 'match', conflicts }

  let sawUnknown = false
  const props = (productProps ?? null) as Record<string, unknown> | null

  for (const key of keys) {
    const reqC = canonicalise(key, requested[key])
    if (reqC === null) {
      // Can't understand the customer's request → unknown, never a mismatch.
      sawUnknown = true
      continue
    }
    const prodRaw = props ? props[key] : undefined
    if (isBlank(prodRaw)) {
      // Product carries no value for this spec → unknown (the "populated on
      // other rows" gap rule is a LATER phase; here, absence is never a block).
      sawUnknown = true
      continue
    }
    const prodC = canonicalise(key, String(prodRaw))
    if (prodC === null) {
      sawUnknown = true
      continue
    }
    if (prodC === reqC) continue
    conflicts.push({ key, requested: reqC, product: prodC })
  }

  if (conflicts.length > 0) return { verdict: 'mismatch', conflicts }
  if (sawUnknown) return { verdict: 'unknown', conflicts }
  return { verdict: 'match', conflicts }
}
