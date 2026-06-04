// ════════════════════════════════════════════════════════════════════
// Signage Compliance — guided photo shots (brand-agnostic).
//
// PURE. Shot lists are per-brand DATA now (brands.shots), not F45
// constants. These helpers operate on a brand's ShotDef[] / slot strings.
// ════════════════════════════════════════════════════════════════════

import type { ShotDef, ShotSlot, SignageRule } from './types'

/** Coerce an arbitrary value (a request body or a DB text[]) to a clean,
 *  de-duplicated ShotSlot[]. If `valid` is given (a brand's slot list),
 *  unknown slots are dropped. */
export function coerceShots(v: unknown, valid?: readonly ShotSlot[]): ShotSlot[] {
  if (!Array.isArray(v)) return []
  const allow = valid ? new Set(valid) : null
  const seen = new Set<ShotSlot>()
  const out: ShotSlot[] = []
  for (const x of v) {
    if (typeof x !== 'string' || x === '') continue
    if (allow && !allow.has(x)) continue
    if (seen.has(x)) continue
    seen.add(x)
    out.push(x)
  }
  return out
}

/** Just the slot ids from a brand's shot defs. */
export function shotSlots(shots: ShotDef[]): ShotSlot[] {
  return shots.map((s) => s.slot)
}

/** A shot's human label, looked up in the brand's shot defs. */
export function shotLabel(slot: ShotSlot, shots: ShotDef[]): string {
  return shots.find((s) => s.slot === slot)?.label ?? slot
}

function slugifySlot(s: string): string {
  return s
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '')
}

/** Sanitise shots-editor input into clean ShotDef[]: snake_case slot,
 *  trimmed label/instruction, de-duplicated by slot, dropping entries with
 *  no slot or no label. Used by the brand shots-editor PATCH route. */
export function normalizeShots(input: unknown): ShotDef[] {
  if (!Array.isArray(input)) return []
  const out: ShotDef[] = []
  const seen = new Set<string>()
  for (const raw of input) {
    if (!raw || typeof raw !== 'object') continue
    const o = raw as Record<string, unknown>
    const slot = slugifySlot(typeof o.slot === 'string' ? o.slot : '')
    const label = typeof o.label === 'string' ? o.label.trim() : ''
    if (!slot || !label || seen.has(slot)) continue
    seen.add(slot)
    out.push({ slot, label, instruction: typeof o.instruction === 'string' ? o.instruction.trim() : '' })
  }
  return out
}

/** The rules the AI actually scores for a given shot — those it may at
 *  least FLAG (verdict_mode pass_fail or detect_only) whose `required_shots`
 *  include this slot. needs_reference + review rules are never sent to the
 *  model; the backstop materialises them as review. */
export function autoRulesForShot(rules: SignageRule[], slot: ShotSlot): SignageRule[] {
  return rules.filter(
    (r) =>
      (r.verdict_mode === 'pass_fail' || r.verdict_mode === 'detect_only') &&
      r.required_shots.includes(slot),
  )
}
