import { describe, expect, it } from 'vitest'
import {
  measurePaintableArea,
  resolveFloorArea,
  __test_only__,
} from './area'
import type { PaintUserInputs, PropertyFacts } from './types'

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
    scopes: ['walls', 'ceilings'],
    coats: 2,
    condition: 'sound',
    ceiling_height: 'standard',
    colour_change: false,
    ...overrides,
  }
}

describe('resolveFloorArea', () => {
  it('prefers a hand-entered floor area and pins confidence high', () => {
    const r = resolveFloorArea(baseFacts(), baseInputs({ manual_floor_area_m2: 220 }))
    expect(r?.floor_area_m2).toBe(220)
    expect(r?.source).toBe('manual')
    expect(r?.confidence).toBe('high')
  })

  it('uses a listing building size at high confidence', () => {
    const r = resolveFloorArea(baseFacts(), baseInputs())
    expect(r?.floor_area_m2).toBe(150)
    expect(r?.source).toBe('listing')
    expect(r?.confidence).toBe('high')
  })

  it('falls back to footprint × storeys × eaves correction at medium confidence', () => {
    const r = resolveFloorArea(
      baseFacts({ floor_area_m2: null, footprint_m2: 160, storeys: 2 }),
      baseInputs(),
    )
    // 160 × 2 × 0.9 = 288
    expect(r?.floor_area_m2).toBe(288)
    expect(r?.source).toBe('footprint')
    expect(r?.confidence).toBe('medium')
  })

  it('falls back to a bedroom estimate at low confidence', () => {
    const r = resolveFloorArea(
      baseFacts({ floor_area_m2: null, footprint_m2: null, bedrooms: 3 }),
      baseInputs(),
    )
    expect(r?.floor_area_m2).toBe(3 * __test_only__.FLOOR_AREA_PER_BEDROOM)
    expect(r?.source).toBe('beds_estimate')
    expect(r?.confidence).toBe('low')
  })

  it('returns null when nothing usable is available', () => {
    const r = resolveFloorArea(
      baseFacts({ floor_area_m2: null, footprint_m2: null, bedrooms: null }),
      baseInputs(),
    )
    expect(r).toBeNull()
  })
})

describe('measurePaintableArea', () => {
  it('derives walls = floor × 2.8 and ceilings = floor at 2.4 m', () => {
    const m = measurePaintableArea(baseFacts(), baseInputs({ scopes: ['walls', 'ceilings'] }))
    expect(m).not.toBeNull()
    const walls = m!.surfaces.find((s) => s.scope === 'walls')
    const ceilings = m!.surfaces.find((s) => s.scope === 'ceilings')
    expect(walls?.quantity).toBe(420) // 150 × 2.8
    expect(walls?.unit).toBe('m2')
    expect(ceilings?.quantity).toBe(150) // 150 × 1.0
  })

  it('applies the high-confidence ±12% band to each quantity', () => {
    const m = measurePaintableArea(baseFacts(), baseInputs({ scopes: ['walls'] }))
    const walls = m!.surfaces.find((s) => s.scope === 'walls')!
    expect(walls.quantity_low).toBeCloseTo(420 * 0.88, 1) // 369.6
    expect(walls.quantity_high).toBeCloseTo(420 * 1.12, 1) // 470.4
    expect(m!.confidence).toBe('high')
  })

  it('uses the taller 3.2 multiplier for high ceilings', () => {
    const m = measurePaintableArea(baseFacts(), baseInputs({ scopes: ['walls'], ceiling_height: 'high' }))
    const walls = m!.surfaces.find((s) => s.scope === 'walls')!
    expect(walls.quantity).toBe(480) // 150 × 3.2
    expect(m!.ceiling_height_m).toBe(2.7)
  })

  it('emits trim as linear metres, not m²', () => {
    const m = measurePaintableArea(baseFacts(), baseInputs({ scopes: ['trim'] }))
    const trim = m!.surfaces.find((s) => s.scope === 'trim')!
    expect(trim.unit).toBe('lm')
    expect(trim.quantity).toBeGreaterThan(0)
  })

  it('derives a positive exterior façade and scales with storeys', () => {
    const single = measurePaintableArea(baseFacts({ storeys: 1 }), baseInputs({ scopes: ['exterior'] }))
    const double = measurePaintableArea(baseFacts({ storeys: 2 }), baseInputs({ scopes: ['exterior'] }))
    const facadeSingle = single!.surfaces.find((s) => s.scope === 'exterior')!.quantity
    const facadeDouble = double!.surfaces.find((s) => s.scope === 'exterior')!.quantity
    expect(facadeSingle).toBeGreaterThan(0)
    expect(facadeDouble).toBeGreaterThan(facadeSingle)
  })

  it('returns null when there is no usable floor area', () => {
    const m = measurePaintableArea(
      baseFacts({ floor_area_m2: null, footprint_m2: null, bedrooms: null }),
      baseInputs(),
    )
    expect(m).toBeNull()
  })
})
