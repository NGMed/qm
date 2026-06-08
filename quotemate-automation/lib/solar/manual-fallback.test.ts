import { describe, it, expect } from 'vitest'
import { buildManualRoofFacts, MANUAL_AREA_M2, __test_only__ } from './manual-fallback'
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
    // 90 m² / 1.95 = 46.15… → floor = 46 (hand-worked, not recomputed from the module constant)
    expect(facts.max_panels_count).toBe(46)
  })

  it('defaults panel capacity to 400 W', () => {
    expect(facts.panel_capacity_watts).toBe(400)
  })

  it('synthesises one panel config at the roof max with a benchmark DC yield', () => {
    expect(facts.panel_configs.length).toBe(1)
    const cfg = facts.panel_configs[0]
    // 46 panels × 400 W = 18.4 kW DC; 18.4 × 1400 kWh/kW/yr = 25760 kWh/yr
    expect(cfg.panels_count).toBe(46)
    expect(cfg.yearly_energy_dc_kwh).toBe(25760)
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

describe('buildManualRoofFacts — config overrides (new)', () => {
  const medNorth: SolarManualRoofInput = {
    orientation: 'north',
    roof_size: 'medium',
    storeys: 1,
  }

  it('config overrides both area_per_panel_m2 and default_panel_capacity_watts', () => {
    // area_per_panel_m2 = 2.0 → floor(90 / 2.0) = 45 panels
    // panel_capacity_watts = 420 W → system = 45 × 420 / 1000 = 18.9 kW DC
    // benchmark = 1400 kWh/kW/yr → DC = 18.9 × 1400 = 26460 kWh/yr
    const f = buildManualRoofFacts(medNorth, {
      area_per_panel_m2: 2.0,
      default_panel_capacity_watts: 420,
      manual_benchmark_kwh_per_kw: 1400,
    })
    expect(f.max_panels_count).toBe(45)
    expect(f.panel_capacity_watts).toBe(420)
    expect(f.panel_configs[0].yearly_energy_dc_kwh).toBe(26460)
  })

  it('config overrides manual_benchmark_kwh_per_kw', () => {
    // panels = floor(90 / 1.95) = 46, capacity = 400 W, system = 18.4 kW DC
    // benchmark = 1600 kWh/kW/yr → DC = 18.4 × 1600 = 29440 kWh/yr
    const f = buildManualRoofFacts(medNorth, {
      manual_benchmark_kwh_per_kw: 1600,
    })
    expect(f.panel_configs[0].yearly_energy_dc_kwh).toBe(29440)
  })

  it('config.default_panel_capacity_watts = 0 falls back to module default 400 W', () => {
    const f = buildManualRoofFacts(medNorth, { default_panel_capacity_watts: 0 })
    expect(f.panel_capacity_watts).toBe(400)
  })

  it('config.default_panel_capacity_watts = NaN falls back to module default 400 W', () => {
    const f = buildManualRoofFacts(medNorth, { default_panel_capacity_watts: NaN })
    expect(f.panel_capacity_watts).toBe(400)
  })

  it('config.manual_benchmark_kwh_per_kw = 0 falls back to module default 1400', () => {
    // With default benchmark: 46 panels × 400 W = 18.4 kW × 1400 = 25760 kWh/yr
    const f = buildManualRoofFacts(medNorth, { manual_benchmark_kwh_per_kw: 0 })
    expect(f.panel_configs[0].yearly_energy_dc_kwh).toBe(25760)
  })

  it('config.area_per_panel_m2 = 0 falls back to module default 1.95', () => {
    // Falls back to 1.95 → floor(90 / 1.95) = 46
    const f = buildManualRoofFacts(medNorth, { area_per_panel_m2: 0 })
    expect(f.max_panels_count).toBe(46)
  })

  it('config.area_per_panel_m2 negative falls back to module default 1.95', () => {
    const f = buildManualRoofFacts(medNorth, { area_per_panel_m2: -1 })
    expect(f.max_panels_count).toBe(46)
  })
})
