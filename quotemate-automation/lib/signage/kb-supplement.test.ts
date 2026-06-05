// Tests for the brand-scoped Gemini file-search supplement.
// PURE builders/parsers tested directly; thin fetch wrappers use an
// injected fetch mock so no real network calls happen.

import { describe, expect, it, vi } from 'vitest'
import {
  DEFAULT_BRAND_KB_STORES,
  buildKbShotQuery,
  buildKbSystemInstruction,
  fetchShotSupplement,
  kbStoresForBrand,
  observedFromEvidence,
  parseKbSignal,
  runKbSupplement,
  supplementOverall,
  type KbSupplementResult,
} from './kb-supplement'
import type { KbConfig, KbFetch } from '../admin-loader/mt-filestore-kb'
import type { AssessmentOverall, BrandConfig, SignageRule } from './types'

const config: KbConfig = { url: 'https://kb.example.com', apiKey: 'test-key' }

const F45: BrandConfig = {
  slug: 'f45',
  name: 'F45',
  location_noun: 'studio',
  location_noun_plural: 'studios',
  hq_name: 'F45 HQ',
  vision_persona: 'F45 fitness studios',
  shots: [{ slot: 'storefront', label: 'Storefront', instruction: 'Shoot the front' }],
}

function rule(partial: Partial<SignageRule> & { rule_key: string }): SignageRule {
  return {
    rule_key: partial.rule_key,
    rule_text: partial.rule_text ?? 'Some rule',
    rule_group: partial.rule_group ?? 'storefront',
    modality: partial.modality ?? 'must',
    applicability: partial.applicability ?? 'auto_vision',
    confidence: partial.confidence ?? 'high',
    mvp_tier: partial.mvp_tier ?? 'mvp_core',
    verdict_mode: partial.verdict_mode ?? 'pass_fail',
    required_shots: partial.required_shots ?? ['storefront'],
    check_hint: partial.check_hint ?? null,
    source_citation: partial.source_citation ?? null,
  }
}

function mockSearch(answer: string, passages: unknown[] = []): KbFetch {
  // Build a FRESH Response per call — a Response body is single-use, so a
  // shared instance would fail the 2nd store's read.
  return vi.fn().mockImplementation(
    async () =>
      new Response(JSON.stringify({ answer, passages }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      }),
  ) as unknown as KbFetch
}

// ── Brand → store routing ───────────────────────────────────────────

describe('kbStoresForBrand', () => {
  it('uses the per-brand default map for F45', () => {
    expect(kbStoresForBrand(F45)).toEqual(['fileSearchStores/mtf45protocols-vvluxy2im0iu'])
  })

  it('returns BOTH stores for anytime-fitness', () => {
    expect(kbStoresForBrand({ slug: 'anytime-fitness' })).toEqual([
      'fileSearchStores/mtanytimefitnessprotocols-inpscusi5qnz',
      'fileSearchStores/mtanytimefitnessdigitalaudi-tnub48excg48',
    ])
  })

  it('prefers explicit kb_store_ids over the default map', () => {
    expect(kbStoresForBrand({ slug: 'f45', kb_store_ids: ['fileSearchStores/custom'] })).toEqual([
      'fileSearchStores/custom',
    ])
  })

  it('de-duplicates and trims explicit ids', () => {
    expect(
      kbStoresForBrand({ slug: 'f45', kb_store_ids: [' a ', 'a', 'b', ''] }),
    ).toEqual(['a', 'b'])
  })

  it('returns [] for an unknown brand with no explicit stores', () => {
    expect(kbStoresForBrand({ slug: 'mystery-brand' })).toEqual([])
  })

  it('default map exposes exactly the two live brands', () => {
    expect(Object.keys(DEFAULT_BRAND_KB_STORES).sort()).toEqual(['anytime-fitness', 'f45'])
  })
})

// ── Prompt building ─────────────────────────────────────────────────

describe('buildKbSystemInstruction', () => {
  it('frames the brand and forbids SKUs/measurements', () => {
    const s = buildKbSystemInstruction(F45)
    expect(s).toContain('SYSTEM INSTRUCTION')
    expect(s).toContain('F45')
    expect(s.toLowerCase()).toContain('only from the')
    expect(s.toLowerCase()).toContain('never an exact')
    expect(s).toContain('NOT IN GUIDELINES')
  })
})

describe('buildKbShotQuery', () => {
  it('embeds the system instruction, shot label, observed text and rules', () => {
    const q = buildKbShotQuery({
      brand: F45,
      shotLabel: 'Storefront',
      observed: 'Purple window graphics, logo present.',
      rules: [rule({ rule_key: 'logo-present', rule_text: 'Logo must be visible' })],
    })
    expect(q).toContain('SYSTEM INSTRUCTION') // instruction folded into the query
    expect(q).toContain('Storefront')
    expect(q).toContain('Purple window graphics')
    expect(q).toContain('[logo-present]')
    expect(q).toContain('PASS or FAIL')
  })

  it('handles an empty rule set and empty observed gracefully', () => {
    const q = buildKbShotQuery({ brand: F45, shotLabel: 'Storefront', observed: '', rules: [] })
    expect(q).toContain('no structured rules in scope')
    expect(q).toContain('(no description available)')
  })
})

describe('observedFromEvidence', () => {
  it('joins, trims, de-dupes and drops blanks', () => {
    expect(
      observedFromEvidence(['Logo visible.', '  Logo visible.  ', '', null, 'Door clear.']),
    ).toBe('Logo visible. Door clear.')
  })

  it('caps very long output', () => {
    const long = observedFromEvidence([Array.from({ length: 400 }, () => 'word').join(' ')])
    expect(long.length).toBeLessThanOrEqual(1200)
  })
})

// ── Answer interpretation ───────────────────────────────────────────

describe('parseKbSignal', () => {
  it('flags an explicit violation', () => {
    expect(parseKbSignal('This is NON-COMPLIANT: the logo is missing.')).toBe('violation_flagged')
  })

  it('reads a clean compliant answer', () => {
    expect(parseKbSignal('The storefront is compliant and meets the standard.')).toBe('looks_compliant')
  })

  it('does NOT flag "no violations found" as a violation', () => {
    expect(parseKbSignal('Compliant. No violations found.')).toBe('looks_compliant')
  })

  it('treats "NOT IN GUIDELINES" as unclear, never a violation', () => {
    expect(parseKbSignal('NOT IN GUIDELINES')).toBe('unclear')
  })

  it('violation wins when both signals are present', () => {
    expect(parseKbSignal('Mostly compliant but the colour is off-brand.')).toBe('violation_flagged')
  })

  it('empty/blank answer is unclear', () => {
    expect(parseKbSignal('')).toBe('unclear')
    expect(parseKbSignal(undefined)).toBe('unclear')
  })
})

// ── Thin fetch wrapper ──────────────────────────────────────────────

describe('fetchShotSupplement', () => {
  it('queries every store and parses the signal', async () => {
    const f = mockSearch('NON-COMPLIANT: logo missing.', [{ text: 'p.3', page: 3 }])
    const out = await fetchShotSupplement(config, {
      stores: ['fileSearchStores/a', 'fileSearchStores/b'],
      shot: 'storefront',
      query: 'q',
      fetchImpl: f,
    })
    expect(out).toHaveLength(2)
    expect(out.every((s) => s.ok)).toBe(true)
    expect(out[0].signal).toBe('violation_flagged')
    expect(out[0].passages[0].page).toBe(3)
    expect(f).toHaveBeenCalledTimes(2)
  })

  it('never throws — a store error becomes ok:false / unclear', async () => {
    const f = vi.fn().mockResolvedValue(new Response('boom', { status: 500 })) as unknown as KbFetch
    const out = await fetchShotSupplement(config, {
      stores: ['fileSearchStores/a'],
      shot: 'storefront',
      query: 'q',
      fetchImpl: f,
    })
    expect(out).toHaveLength(1)
    expect(out[0].ok).toBe(false)
    expect(out[0].signal).toBe('unclear')
    expect(out[0].error).toBeTruthy()
  })
})

// ── Orchestrator ────────────────────────────────────────────────────

describe('runKbSupplement', () => {
  it('returns empty shots for a brand with no stores', async () => {
    const f = mockSearch('compliant')
    const res = await runKbSupplement(config, {
      brand: { ...F45, slug: 'mystery', kb_store_ids: [] },
      shots: [{ slot: 'storefront', label: 'Storefront', observed: 'x' }],
      scopedRules: [rule({ rule_key: 'r1' })],
      fetchImpl: f,
    })
    expect(res.stores).toEqual([])
    expect(res.shots).toEqual([])
    expect(f).not.toHaveBeenCalled()
  })

  it('queries the brand stores per shot and scopes rules by required_shots', async () => {
    const f = mockSearch('Compliant. Meets the standard.')
    const res = await runKbSupplement(config, {
      brand: F45,
      shots: [{ slot: 'storefront', label: 'Storefront', observed: 'logo visible' }],
      scopedRules: [
        rule({ rule_key: 'sf', required_shots: ['storefront'] }),
        rule({ rule_key: 'other', required_shots: ['logo_wall'] }),
      ],
      fetchImpl: f,
    })
    expect(res.stores).toEqual(['fileSearchStores/mtf45protocols-vvluxy2im0iu'])
    expect(res.shots).toHaveLength(1)
    expect(res.shots[0].signal).toBe('looks_compliant')
    // the query should only carry the in-scope rule for this shot
    expect(res.shots[0].query).toContain('[sf]')
    expect(res.shots[0].query).not.toContain('[other]')
  })
})

// ── Merge into the authoritative overall ────────────────────────────

function resultWith(signal: 'violation_flagged' | 'looks_compliant' | 'unclear'): KbSupplementResult {
  return {
    brandSlug: 'f45',
    stores: ['fileSearchStores/a'],
    shots: [
      {
        shot: 'storefront',
        store: 'fileSearchStores/a',
        ok: true,
        signal,
        answer: signal === 'violation_flagged' ? 'NON-COMPLIANT: off-brand colour.' : 'compliant',
        passages: [],
        query: 'q',
      },
    ],
  }
}

describe('supplementOverall', () => {
  it('flips a clean pass to needs_review when the KB flags a violation', () => {
    const out = supplementOverall('pass', resultWith('violation_flagged'))
    expect(out.overall).toBe('needs_review')
    expect(out.concerns).toHaveLength(1)
    expect(out.concerns[0].shot).toBe('storefront')
  })

  it('leaves a clean pass alone when the KB is compliant/unclear', () => {
    expect(supplementOverall('pass', resultWith('looks_compliant')).overall).toBe('pass')
    expect(supplementOverall('pass', resultWith('unclear')).overall).toBe('pass')
    expect(supplementOverall('pass', resultWith('unclear')).concerns).toEqual([])
  })

  it('never upgrades fix_needed or needs_review, even with KB concerns', () => {
    const cases: AssessmentOverall[] = ['fix_needed', 'needs_review']
    for (const base of cases) {
      const out = supplementOverall(base, resultWith('violation_flagged'))
      expect(out.overall).toBe(base) // KB can never make it a pass
      expect(out.concerns).toHaveLength(1) // concern still recorded
    }
  })

  it('ignores failed (ok:false) store supplements', () => {
    const res: KbSupplementResult = {
      brandSlug: 'f45',
      stores: ['fileSearchStores/a'],
      shots: [
        { shot: 'storefront', store: 'fileSearchStores/a', ok: false, signal: 'unclear', answer: '', passages: [], query: 'q' },
      ],
    }
    expect(supplementOverall('pass', res).overall).toBe('pass')
  })
})
