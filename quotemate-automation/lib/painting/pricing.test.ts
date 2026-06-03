import { describe, expect, it } from 'vitest'
import {
  DEFAULT_PAINTING_RATE_CARD,
  applicableLoadings,
  calculatePaintingPrice,
  jobMultiplier,
  requiresInspection,
} from './pricing'
import { measurePaintableArea } from './area'
import type { PaintMeasurement, PaintUserInputs, PropertyFacts } from './types'

function baseFacts(overrides: Partial<PropertyFacts> = {}): PropertyFacts {
  return {
    floor_area_m2: 150,
    floor_area_source: 'listing',
    footprint_m2: 160,
    storeys: 1,
    bedrooms: 3,
    bathrooms: 2,
    year_built: 2005,
    property_type: 'House',
    land_size_m2: 450,
    has_floor_plan: true,
    source: 'mock',
    capture_note: null,
    ...overrides,
  }
}

function baseInputs(overrides: Partial<PaintUserInputs> = {}): PaintUserInputs {
  return {
    scopes: ['walls'],
    coats: 2,
    condition: 'sound',
    ceiling_height: 'standard',
    colour_change: false,
    ...overrides,
  }
}

function measure(
  factsO: Partial<PropertyFacts> = {},
  inputsO: Partial<PaintUserInputs> = {},
): PaintMeasurement {
  const m = measurePaintableArea(baseFacts(factsO), baseInputs(inputsO))
  if (!m) throw new Error('expected a measurement for the test fixture')
  return m
}

describe('requiresInspection', () => {
  it('returns null for a happy walls-only single-storey modern repaint', () => {
    expect(
      requiresInspection({ facts: baseFacts(), inputs: baseInputs(), measurement: measure() }),
    ).toBeNull()
  })

  it('forces inspection when there is no measurement', () => {
    const r = requiresInspection({ facts: baseFacts(), inputs: baseInputs(), measurement: null })
    expect(r?.decision).toBe('inspection_required')
  })

  it('forces inspection on poor substrate condition', () => {
    const r = requiresInspection({
      facts: baseFacts(),
      inputs: baseInputs({ condition: 'poor' }),
      measurement: measure({}, { condition: 'poor' }),
    })
    expect(r?.decision).toBe('inspection_required')
  })

  it('forces inspection on raked ceilings', () => {
    const r = requiresInspection({
      facts: baseFacts(),
      inputs: baseInputs({ ceiling_height: 'raked' }),
      measurement: measure({}, { ceiling_height: 'raked' }),
    })
    expect(r?.decision).toBe('inspection_required')
  })

  it('forces inspection on a pre-1970 exterior job (lead/asbestos)', () => {
    const r = requiresInspection({
      facts: baseFacts({ year_built: 1955 }),
      inputs: baseInputs({ scopes: ['exterior'] }),
      measurement: measure({ year_built: 1955 }, { scopes: ['exterior'] }),
    })
    expect(r?.decision).toBe('inspection_required')
  })

  it('forces inspection at 3+ storeys', () => {
    const r = requiresInspection({
      facts: baseFacts({ storeys: 3 }),
      inputs: baseInputs(),
      measurement: measure({ storeys: 3 }),
    })
    expect(r?.decision).toBe('inspection_required')
  })

  it('routes a low-confidence (beds-only) estimate to inspection', () => {
    const r = requiresInspection({
      facts: baseFacts({ floor_area_m2: null, footprint_m2: null, bedrooms: 3 }),
      inputs: baseInputs(),
      measurement: measure({ floor_area_m2: null, footprint_m2: null, bedrooms: 3 }),
    })
    expect(r?.decision).toBe('inspection_required')
  })
})

describe('jobMultiplier', () => {
  it('is 1.0 for the 2-coat / sound / no-colour-change baseline', () => {
    expect(jobMultiplier(baseInputs(), DEFAULT_PAINTING_RATE_CARD)).toBe(1.0)
  })

  it('compounds coats, condition and colour change', () => {
    const m = jobMultiplier(
      baseInputs({ coats: 3, condition: 'bare', colour_change: true }),
      DEFAULT_PAINTING_RATE_CARD,
    )
    // 1.35 (3 coats) × 1.4 (bare) × 1.1 (colour) = 2.079
    expect(m).toBeCloseTo(1.35 * 1.4 * 1.1, 5)
  })
})

describe('calculatePaintingPrice', () => {
  it('computes three ordered tiers with a low/high band', () => {
    const price = calculatePaintingPrice({
      facts: baseFacts(),
      inputs: baseInputs(),
      measurement: measure(),
    })
    expect(price.tiers).toHaveLength(3)
    expect(price.tiers[0].tier).toBe('good')
    expect(price.tiers[1].tier).toBe('better')
    expect(price.tiers[2].tier).toBe('best')
    expect(price.tiers[1].ex_gst).toBeGreaterThan(price.tiers[0].ex_gst)
    expect(price.tiers[2].ex_gst).toBeGreaterThan(price.tiers[1].ex_gst)
    // Range, not a point.
    expect(price.tiers[1].inc_gst_low).toBeLessThan(price.tiers[1].inc_gst)
    expect(price.tiers[1].inc_gst_high).toBeGreaterThan(price.tiers[1].inc_gst)
  })

  it('prices the Better tier as walls m² × rate × multipliers', () => {
    const price = calculatePaintingPrice({
      facts: baseFacts(),
      inputs: baseInputs(),
      measurement: measure(),
    })
    // 420 m² × $28 × 1.0 (2-coat sound) = $11,760 ex GST
    expect(price.tiers[1].ex_gst).toBe(11760)
    expect(price.tiers[1].inc_gst).toBe(12936) // × 1.10 GST
  })

  it('marks tradie_review for a happy auto-quotable job', () => {
    const price = calculatePaintingPrice({
      facts: baseFacts(),
      inputs: baseInputs(),
      measurement: measure(),
    })
    expect(price.routing.decision).toBe('tradie_review')
  })

  it('applies the call-out minimum on a tiny job', () => {
    // A 6 m² floor → ~16.8 m² of wall whose 1-coat Good tier (~$339) falls
    // below the $450 minimum, so the floor binds.
    const price = calculatePaintingPrice({
      facts: baseFacts({ floor_area_m2: 6 }),
      inputs: baseInputs(),
      measurement: measure({ floor_area_m2: 6 }),
    })
    expect(price.call_out_minimum_applied).toBe(true)
    expect(price.tiers[0].ex_gst).toBeGreaterThanOrEqual(450)
  })
})

describe('applicableLoadings', () => {
  it('adds a double-storey exterior loading on a 2-storey exterior job', () => {
    const loadings = applicableLoadings(
      measure({ storeys: 2 }, { scopes: ['exterior'] }),
      baseInputs({ scopes: ['exterior'] }),
      DEFAULT_PAINTING_RATE_CARD,
    )
    expect(loadings.some((l) => l.code === 'double_storey')).toBe(true)
  })

  it('adds a colour-change loading when the colour changes', () => {
    const loadings = applicableLoadings(
      measure({}, { colour_change: true }),
      baseInputs({ colour_change: true }),
      DEFAULT_PAINTING_RATE_CARD,
    )
    expect(loadings.some((l) => l.code === 'colour_change')).toBe(true)
  })
})
