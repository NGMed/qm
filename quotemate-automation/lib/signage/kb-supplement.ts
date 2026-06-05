// ════════════════════════════════════════════════════════════════════
// Signage Compliance — Gemini file-search SUPPLEMENT (brand-scoped).
//
// After the Claude vision pass + the deterministic Supabase backstop have
// produced the authoritative per-rule verdicts, this layer asks the
// brand's Gemini File Search store(s) — via the existing mt-filestore-kb
// client — what the brand-standards documents say about each shot, and
// folds the result in as a SUPPLEMENT.
//
// Design rules (mirror the rest of the signage pipeline):
//   • Supabase `signage_rules` + the grounding backstop stay the PRIMARY
//     source of truth. The KB can only RAISE caution (flip an otherwise-
//     clean `pass` to `needs_review`); it can NEVER certify a pass, nor
//     downgrade a `fix_needed`/`needs_review` away from review.
//   • Brand routing is strict — a brand's stores come from its config /
//     the per-brand default map. We never query another brand's store.
//   • Every network call is best-effort + never-throws. A KB outage
//     degrades to "no supplement", leaving the Supabase verdict untouched.
//   • The Gemini /v1/search API takes only a `query`, so the strict
//     SYSTEM INSTRUCTION is folded into the query text itself.
//
// PURE builders + parser are exported and unit-tested directly; the thin
// fetch wrappers inject `fetch` so tests never hit the network.
// ════════════════════════════════════════════════════════════════════

import {
  kbSearch,
  type KbConfig,
  type KbFetch,
  type KbGroundingPassage,
} from '../admin-loader/mt-filestore-kb'
import type { AssessmentOverall, BrandConfig, ShotSlot, SignageRule } from './types'

// ── Brand → Gemini file-search store routing ────────────────────────

export type KbStoreRef = string // "fileSearchStores/..."

/** Per-brand default store map. Used when a brand row carries no explicit
 *  `kb_store_ids` (the column is the data-driven override; this is the
 *  known-good fallback so the feature works before that migration lands).
 *  Slugs match the `brands.slug` values. */
export const DEFAULT_BRAND_KB_STORES: Readonly<Record<string, readonly KbStoreRef[]>> = {
  f45: ['fileSearchStores/mtf45protocols-vvluxy2im0iu'],
  'anytime-fitness': [
    'fileSearchStores/mtanytimefitnessprotocols-inpscusi5qnz',
    'fileSearchStores/mtanytimefitnessdigitalaudi-tnub48excg48',
  ],
}

function dedupeStrings(xs: readonly string[]): string[] {
  const seen = new Set<string>()
  const out: string[] = []
  for (const x of xs) {
    const v = typeof x === 'string' ? x.trim() : ''
    if (!v || seen.has(v)) continue
    seen.add(v)
    out.push(v)
  }
  return out
}

/** PURE — resolve the Gemini store(s) for a brand. Prefers the brand's
 *  explicit `kb_store_ids` (data-driven), else the per-brand default map,
 *  else []. Never throws; unknown brands simply get no supplement. */
export function kbStoresForBrand(
  brand: Pick<BrandConfig, 'slug'> & { kb_store_ids?: readonly string[] | null },
): KbStoreRef[] {
  const explicit = Array.isArray(brand?.kb_store_ids) ? dedupeStrings(brand.kb_store_ids) : []
  if (explicit.length) return explicit
  const fallback = DEFAULT_BRAND_KB_STORES[brand?.slug ?? '']
  return fallback ? dedupeStrings(fallback) : []
}

// ── Prompt building (PURE) ──────────────────────────────────────────

/** PURE — the strict SYSTEM INSTRUCTION prepended to every store query.
 *  Keeps the reference model grounded ONLY in the brand's documents and
 *  forbids the same things the vision pass forbids (exact SKUs, absolute
 *  measurements, inventing rules). */
export function buildKbSystemInstruction(brand: Pick<BrandConfig, 'name' | 'vision_persona' | 'hq_name'>): string {
  return [
    `SYSTEM INSTRUCTION:`,
    `You are a brand-compliance REFERENCE assistant for ${brand.name} (${brand.vision_persona}).`,
    `Answer ONLY from the ${brand.name} brand-standards documents indexed in this store.`,
    `Quote the specific standard/rule and cite its page or section.`,
    `If the documents do not cover the question, reply exactly: NOT IN GUIDELINES.`,
    `Do not invent rules. Judge colour by FAMILY only — never an exact paint/SKU code.`,
    `Do not estimate absolute measurements. Be concise and factual.`,
    `State clearly whether the observed scene COMPLIES or is NON-COMPLIANT, and list any violations.`,
  ].join('\n')
}

/** PURE — distil the vision pass's per-rule evidence for one shot into a
 *  short "observed scene" description to ground the store query. */
export function observedFromEvidence(evidence: readonly (string | null | undefined)[]): string {
  const cleaned = dedupeStrings(
    evidence.map((e) => (typeof e === 'string' ? e.trim() : '')).filter((e) => e.length > 0),
  )
  return cleaned.join(' ').slice(0, 1200)
}

/** PURE — build the full query (SYSTEM INSTRUCTION + question) sent to a
 *  store for one shot. The instruction is folded into the query because
 *  the /v1/search API accepts only `query`. */
export function buildKbShotQuery(args: {
  brand: Pick<BrandConfig, 'name' | 'vision_persona' | 'hq_name' | 'location_noun'>
  shotLabel: string
  observed: string
  rules: readonly Pick<SignageRule, 'rule_key' | 'rule_text'>[]
}): string {
  const ruleLines = args.rules.length
    ? args.rules.map((r, i) => `  ${i + 1}. [${r.rule_key}] ${r.rule_text}`).join('\n')
    : '  (no structured rules in scope for this shot)'
  const observed = args.observed.trim() || '(no description available)'
  return [
    buildKbSystemInstruction(args.brand),
    ``,
    `QUESTION:`,
    `For the "${args.shotLabel}" of a ${args.brand.name} ${args.brand.location_noun}, the audit photo shows:`,
    `"${observed}"`,
    ``,
    `Against the ${args.brand.name} brand standards, does this PASS or FAIL? Consider these rules in scope:`,
    ruleLines,
    ``,
    `Answer with a clear COMPLIANT / NON-COMPLIANT judgement, the violated standard(s), and page citations.`,
  ].join('\n')
}

// ── Answer interpretation (PURE) ────────────────────────────────────

export type KbSignal = 'violation_flagged' | 'looks_compliant' | 'unclear'

// Phrases that are POSITIVE despite containing a violation word — stripped
// before scanning so "no violations found" doesn't read as a violation.
const NEGATED_POSITIVES = [
  'no violations',
  'no violation',
  'without violation',
  'without violations',
  'no non-compliance',
  'no non compliance',
  'no breaches',
  'no breach',
  'no issues',
  'no issue',
  'no concerns',
  'does meet',
]

const VIOLATION_MARKERS = [
  'non-compliant',
  'non compliant',
  'not compliant',
  'noncompliant',
  'violation',
  'violates',
  'does not meet',
  "doesn't meet",
  'fails to',
  'fail',
  'breach',
  'incorrect',
  'wrong colour',
  'wrong color',
  'off-brand',
  'off brand',
  'missing',
]

const COMPLIANT_MARKERS = [
  'compliant',
  'complies',
  'meets the standard',
  'meets the requirement',
  'meets brand',
  'conforms',
  'passes',
  'is correct',
  'within standard',
]

const NOT_COVERED_MARKERS = ['not in guidelines', 'not covered', 'no information', 'cannot find', 'not found in']

/** PURE — conservative interpretation of a store answer into a coarse
 *  signal. Order matters: a flagged violation always wins (the safe
 *  direction — the KB may only ADD caution). "not in guidelines" and
 *  ambiguous answers collapse to `unclear` (no effect). */
export function parseKbSignal(answer: string | null | undefined): KbSignal {
  const raw = (answer ?? '').toLowerCase()
  if (!raw.trim()) return 'unclear'

  // A doc-miss is never a violation.
  if (NOT_COVERED_MARKERS.some((m) => raw.includes(m))) return 'unclear'

  // Strip negated-positive phrases so they don't trip the violation scan.
  let scan = raw
  for (const p of NEGATED_POSITIVES) scan = scan.split(p).join(' ')

  if (VIOLATION_MARKERS.some((m) => scan.includes(m))) return 'violation_flagged'
  if (COMPLIANT_MARKERS.some((m) => raw.includes(m))) return 'looks_compliant'
  return 'unclear'
}

// ── Result shapes ───────────────────────────────────────────────────

export type KbShotSupplement = {
  shot: ShotSlot
  store: KbStoreRef
  ok: boolean
  signal: KbSignal
  answer: string
  passages: KbGroundingPassage[]
  query: string
  error?: string
}

export type KbConcern = {
  shot: ShotSlot
  store: KbStoreRef
  note: string
  passages: KbGroundingPassage[]
}

export type KbSupplementResult = {
  brandSlug: string
  stores: KbStoreRef[]
  shots: KbShotSupplement[]
}

// ── Thin, never-throw I/O ───────────────────────────────────────────

/** Query EVERY brand store for one shot. Returns one supplement per
 *  store. Never throws — a store error becomes an `ok:false` supplement
 *  with `signal:'unclear'`. */
export async function fetchShotSupplement(
  config: KbConfig,
  args: {
    stores: readonly KbStoreRef[]
    shot: ShotSlot
    query: string
    model?: string
    fetchImpl?: KbFetch
  },
): Promise<KbShotSupplement[]> {
  const out: KbShotSupplement[] = []
  for (const store of args.stores) {
    try {
      const res = await kbSearch(
        config,
        { store, query: args.query, ...(args.model ? { model: args.model } : {}) },
        args.fetchImpl,
      )
      out.push({
        shot: args.shot,
        store,
        ok: true,
        signal: parseKbSignal(res.answer),
        answer: res.answer ?? '',
        passages: res.passages ?? [],
        query: args.query,
      })
    } catch (e) {
      out.push({
        shot: args.shot,
        store,
        ok: false,
        signal: 'unclear',
        answer: '',
        passages: [],
        query: args.query,
        error: e instanceof Error ? e.message : String(e),
      })
    }
  }
  return out
}

export type RunKbSupplementArgs = {
  brand: Pick<BrandConfig, 'slug' | 'name' | 'vision_persona' | 'hq_name' | 'location_noun'> & {
    kb_store_ids?: readonly string[] | null
  }
  /** Shots actually submitted in this assessment. */
  shots: readonly { slot: ShotSlot; label: string; observed: string }[]
  /** The full scoped rule set (filtered per shot by required_shots). */
  scopedRules: readonly SignageRule[]
  model?: string
  fetchImpl?: KbFetch
}

/** Orchestrate the brand-scoped supplement across all submitted shots.
 *  Never throws; returns an empty `shots` array when the brand has no
 *  stores. */
export async function runKbSupplement(
  config: KbConfig,
  args: RunKbSupplementArgs,
): Promise<KbSupplementResult> {
  const stores = kbStoresForBrand(args.brand)
  if (stores.length === 0) {
    return { brandSlug: args.brand.slug, stores: [], shots: [] }
  }

  const shots: KbShotSupplement[] = []
  for (const shot of args.shots) {
    const rulesForShot = args.scopedRules.filter((r) => r.required_shots.includes(shot.slot))
    const query = buildKbShotQuery({
      brand: args.brand,
      shotLabel: shot.label,
      observed: shot.observed,
      rules: rulesForShot,
    })
    const supplements = await fetchShotSupplement(config, {
      stores,
      shot: shot.slot,
      query,
      ...(args.model ? { model: args.model } : {}),
      ...(args.fetchImpl ? { fetchImpl: args.fetchImpl } : {}),
    })
    shots.push(...supplements)
  }

  return { brandSlug: args.brand.slug, stores, shots }
}

// ── Merge into the authoritative verdict (PURE) ─────────────────────

export type SupplementedOverall = {
  overall: AssessmentOverall
  concerns: KbConcern[]
}

/** PURE — fold the supplement into the Supabase/backstop overall.
 *
 *  The KB may only RAISE caution: if the structured verdict is a clean
 *  `pass` but a store flagged a violation, the overall becomes
 *  `needs_review` so a human looks. `fix_needed` and `needs_review` are
 *  left unchanged (already non-pass). The KB never produces a `pass`. */
export function supplementOverall(
  base: AssessmentOverall,
  result: KbSupplementResult,
): SupplementedOverall {
  const concerns: KbConcern[] = result.shots
    .filter((s) => s.ok && s.signal === 'violation_flagged')
    .map((s) => ({
      shot: s.shot,
      store: s.store,
      note: firstSentence(s.answer) || 'Brand-standards reference flagged a possible violation.',
      passages: s.passages,
    }))

  const overall: AssessmentOverall = base === 'pass' && concerns.length > 0 ? 'needs_review' : base
  return { overall, concerns }
}

function firstSentence(text: string): string {
  const t = (text ?? '').trim()
  if (!t) return ''
  const m = t.match(/^.*?[.!?](\s|$)/)
  return (m ? m[0] : t).trim().slice(0, 240)
}
