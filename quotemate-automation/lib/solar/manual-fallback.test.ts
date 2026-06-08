import { describe, it, expect } from 'vitest'
import { buildManualRoofFacts, MANUAL_AREA_M2 } from './manual-fallback'
import type { SolarManualRoofInput } from './types'

describe('buildManualRoofFacts', () => {
  const medNorth: SolarManualRoofInput = {
    orientation: 'north',
    roof_size: 'medium',
    storeys: 1,
  }
  const facts = buildManualRoofFacts(medNorth)

  it('tags the source as manual', () => {
    expect(facts.source).toBe('manual')
  })

  it('maps roof_size=medium to its declared usable area', () => {
    expect(facts.usable_area_m2).toBe(MANUAL_AREA_M2.medium)
  })

  it('carries the declared orientation as the primary orientation', () => {
    expect(facts.primary_orientation).toBe('north')
  })

  it('synthesises max_panels_count from usable area (1.95 m² per panel)', () => {
    // 90 m² / 1.95 ≈ 46.1 → floor 46
    expect(facts.max_panels_count).toBe(Math.floor(MANUAL_AREA_M2.medium / 1.95))
  })

  it('defaults panel capacity to 400 W', () => {
    expect(facts.panel_capacity_watts).toBe(400)
  })

  it('synthesises one panel config at the roof max with a benchmark DC yield', () => {
    expect(facts.panel_configs.length).toBe(1)
    const cfg = facts.panel_configs[0]
    expect(cfg.panels_count).toBe(facts.max_panels_count)
    // kW = panels × 400 / 1000; DC = kW × 1400 kWh/kW/yr benchmark
    const kw = (cfg.panels_count * 400) / 1000
    expect(cfg.yearly_energy_dc_kwh).toBe(Math.round(kw * 1400 * 10) / 10)
  })

  it('carries the declared storeys and has no polygon / imagery', () => {
    expect(facts.storeys).toBe(1)
    expect(facts.polygon_geojson).toBeNull()
    expect(facts.imagery_quality).toBeNull()
    expect(facts.imagery_date).toBeNull()
  })

  it('has no real planes (synthetic manual path)', () => {
    expect(facts.planes).toEqual([])
    expect(facts.segment_count).toBe(0)
    expect(facts.mean_pitch_degrees).toBeNull()
  })

  it('scales area with the size bucket (small < medium < large)', () => {
    const small = buildManualRoofFacts({ ...medNorth, roof_size: 'small' })
    const large = buildManualRoofFacts({ ...medNorth, roof_size: 'large' })
    expect(small.usable_area_m2).toBeLessThan(facts.usable_area_m2)
    expect(large.usable_area_m2).toBeGreaterThan(facts.usable_area_m2)
  })
})
