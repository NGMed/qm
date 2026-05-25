// P-1 (2026-05-25) — coverage for the after_hours_multiplier acceptance
// branches in validateQuoteGrounding.
//
// Pre-P-1, the validator accepted labour at hourly_rate / apprentice_rate /
// senior_rate, and callouts at call_out_minimum. After-hours surcharges
// emitted by Opus would fail grounding (because the price didn't match any
// candidate), dumping otherwise correct emergency quotes to the $99
// inspection. The hardcoded × 1.5 in prompt-context.ts was meanwhile
// ignoring the tradie's configured multiplier entirely.
//
// Post-P-1: when after_hours_multiplier is set, the validator ALSO accepts
//   - labour at hourly_rate × multiplier (when line.source/description marks after-hours)
//   - callout at call_out_minimum × multiplier (same condition)
// Standard-hours lines at the inflated rate still fail — the line MUST be
// explicitly tagged as after-hours via source ("after_hours" / "emergency")
// or description prefix ("After-hours — …" / "Emergency …").

import { describe, expect, it } from 'vitest'
import {
  validateQuoteGrounding,
  buildCandidatePrices,
  type PricingBookForValidation,
} from './validate'

const baseBook: PricingBookForValidation = {
  hourly_rate: 118,
  apprentice_rate: 86,
  call_out_minimum: 160,
  default_markup_pct: 36,
  min_labour_hours: 3,
  after_hours_multiplier: 2,
}

// Empty catalogue — these tests only exercise the labour + callout paths,
// not material grounding. (Materials still need their own candidate rows.)
const noCandidates = buildCandidatePrices([], [], baseBook)

function tier(lines: any[]) {
  return {
    needs_inspection: false,
    good: { line_items: lines },
    better: null,
    best: null,
  }
}

describe('P-1: validateQuoteGrounding after_hours_multiplier', () => {
  describe('labour at after-hours rate', () => {
    it('ACCEPTS labour at hourly × multiplier when tagged via source=after_hours', () => {
      const r = validateQuoteGrounding(
        tier([
          { description: 'Call-out', quantity: 1, unit: 'each', unit_price_ex_gst: 160, source: 'callout' },
          { description: 'After-hours — diagnostic', quantity: 3, unit: 'hr', unit_price_ex_gst: 236, source: 'after_hours' },
        ]),
        baseBook,
        noCandidates,
      )
      expect(r.valid).toBe(true)
    })

    it('C-2 REGRESSION: REJECTS labour at hourly × multiplier when only description marks after-hours', () => {
      // Pre-C-2, this passed via a description-side regex match. That
      // was a false-positive leak — Opus could pass an inflated rate
      // by writing "After-hours" into ANY line description. Source-only
      // detection is now the source of truth.
      const r = validateQuoteGrounding(
        tier([
          { description: 'Call-out', quantity: 1, unit: 'each', unit_price_ex_gst: 160, source: 'callout' },
          { description: 'After-hours emergency repair labour', quantity: 3, unit: 'hr', unit_price_ex_gst: 236, source: 'labour' },
        ]),
        baseBook,
        noCandidates,
      )
      expect(r.valid).toBe(false)
    })

    it('C-2 REGRESSION: REJECTS inflated rate on a non-after-hours line that mentions "emergency" in passing', () => {
      // E.g. Opus writes "Emergency-capable wiring" for a standard
      // daytime job. Source is plain labour, description contains
      // "emergency" — pre-C-2 the regex matched and the inflated rate
      // passed. Post-C-2 source-only detection rejects it.
      const r = validateQuoteGrounding(
        tier([
          { description: 'Call-out', quantity: 1, unit: 'each', unit_price_ex_gst: 160, source: 'callout' },
          { description: 'Emergency-capable wiring upgrade', quantity: 3, unit: 'hr', unit_price_ex_gst: 236, source: 'labour' },
        ]),
        baseBook,
        noCandidates,
      )
      expect(r.valid).toBe(false)
    })

    it('still accepts when source IS after-hours, even if description is plain', () => {
      const r = validateQuoteGrounding(
        tier([
          { description: 'Call-out', quantity: 1, unit: 'each', unit_price_ex_gst: 160, source: 'callout' },
          // No "after-hours" in description; source tag is the truth.
          { description: 'Diagnostic time', quantity: 3, unit: 'hr', unit_price_ex_gst: 236, source: 'after_hours' },
        ]),
        baseBook,
        noCandidates,
      )
      expect(r.valid).toBe(true)
    })

    it('REJECTS labour at after-hours rate when the line is NOT tagged after-hours', () => {
      const r = validateQuoteGrounding(
        tier([
          { description: 'Call-out', quantity: 1, unit: 'each', unit_price_ex_gst: 160, source: 'callout' },
          // $236 = $118 × 2, but the line is a plain labour line — must fail.
          { description: 'Install labour', quantity: 3, unit: 'hr', unit_price_ex_gst: 236, source: 'labour' },
        ]),
        baseBook,
        noCandidates,
      )
      expect(r.valid).toBe(false)
    })

    it('REJECTS after-hours rate when multiplier is unset (back-compat with pre-P-1 tenants)', () => {
      const r = validateQuoteGrounding(
        tier([
          { description: 'Call-out', quantity: 1, unit: 'each', unit_price_ex_gst: 160, source: 'callout' },
          { description: 'After-hours labour', quantity: 3, unit: 'hr', unit_price_ex_gst: 236, source: 'after_hours' },
        ]),
        { ...baseBook, after_hours_multiplier: null },
        noCandidates,
      )
      expect(r.valid).toBe(false)
    })
  })

  describe('callout at after-hours rate', () => {
    it('ACCEPTS call-out at call_out_minimum × multiplier when source tags after-hours', () => {
      // C-2 (2026-05-25) — the after-hours call-out line must carry an
      // explicit after-hours source tag, NOT just a description hint.
      // Prompts now teach Opus to use `source: "after_hours_callout"`.
      const r = validateQuoteGrounding(
        tier([
          // $320 = $160 × 2
          { description: 'After-hours emergency call-out', quantity: 1, unit: 'each', unit_price_ex_gst: 320, source: 'after_hours_callout' },
          { description: 'After-hours labour', quantity: 3, unit: 'hr', unit_price_ex_gst: 236, source: 'after_hours' },
        ]),
        baseBook,
        noCandidates,
      )
      expect(r.valid).toBe(true)
    })

    it('ACCEPTS with alternate after-hours source tag "emergency_callout"', () => {
      const r = validateQuoteGrounding(
        tier([
          { description: 'Emergency call-out', quantity: 1, unit: 'each', unit_price_ex_gst: 320, source: 'emergency_callout' },
          { description: 'After-hours labour', quantity: 3, unit: 'hr', unit_price_ex_gst: 236, source: 'after_hours' },
        ]),
        baseBook,
        noCandidates,
      )
      expect(r.valid).toBe(true)
    })

    it('REJECTS the inflated call-out when source is plain "callout" (C-2 regression)', () => {
      // Pre-C-2 this PASSED via description regex match. Post-C-2 the
      // source must explicitly be one of the after-hours variants.
      const r = validateQuoteGrounding(
        tier([
          { description: 'After-hours emergency call-out', quantity: 1, unit: 'each', unit_price_ex_gst: 320, source: 'callout' },
          { description: 'After-hours labour', quantity: 3, unit: 'hr', unit_price_ex_gst: 236, source: 'after_hours' },
        ]),
        baseBook,
        noCandidates,
      )
      expect(r.valid).toBe(false)
    })

    it('REJECTS the inflated call-out when the line is NOT tagged after-hours at all', () => {
      const r = validateQuoteGrounding(
        tier([
          { description: 'Call-out', quantity: 1, unit: 'each', unit_price_ex_gst: 320, source: 'callout' },
          { description: 'Install labour', quantity: 3, unit: 'hr', unit_price_ex_gst: 118 },
        ]),
        baseBook,
        noCandidates,
      )
      expect(r.valid).toBe(false)
    })
  })

  describe('standard rates still work', () => {
    it('still accepts labour at the plain hourly_rate when after-hours is configured', () => {
      const r = validateQuoteGrounding(
        tier([
          { description: 'Call-out', quantity: 1, unit: 'each', unit_price_ex_gst: 160, source: 'callout' },
          { description: 'Install labour', quantity: 3, unit: 'hr', unit_price_ex_gst: 118 },
        ]),
        baseBook,
        noCandidates,
      )
      expect(r.valid).toBe(true)
    })

    it('still accepts labour at the apprentice_rate', () => {
      const r = validateQuoteGrounding(
        tier([
          { description: 'Call-out', quantity: 1, unit: 'each', unit_price_ex_gst: 160, source: 'callout' },
          { description: 'Apprentice labour', quantity: 2, unit: 'hr', unit_price_ex_gst: 86 },
          { description: 'Install labour', quantity: 1, unit: 'hr', unit_price_ex_gst: 118 },
        ]),
        baseBook,
        noCandidates,
      )
      expect(r.valid).toBe(true)
    })
  })
})

describe('P-2: validateQuoteGrounding senior_rate (regression — already in place)', () => {
  const bookWithSenior: PricingBookForValidation = { ...baseBook, senior_rate: 200 }

  it('accepts labour at the configured senior_rate', () => {
    const r = validateQuoteGrounding(
      tier([
        { description: 'Call-out', quantity: 1, unit: 'each', unit_price_ex_gst: 160, source: 'callout' },
        { description: 'Senior tradie labour', quantity: 3, unit: 'hr', unit_price_ex_gst: 200 },
      ]),
      bookWithSenior,
      noCandidates,
    )
    expect(r.valid).toBe(true)
  })

  it('rejects senior-rate when senior_rate is not configured (regression — pre-P-2 behaviour preserved)', () => {
    const r = validateQuoteGrounding(
      tier([
        { description: 'Call-out', quantity: 1, unit: 'each', unit_price_ex_gst: 160, source: 'callout' },
        { description: 'Premium labour', quantity: 3, unit: 'hr', unit_price_ex_gst: 200 },
      ]),
      baseBook,
      noCandidates,
    )
    expect(r.valid).toBe(false)
  })
})
