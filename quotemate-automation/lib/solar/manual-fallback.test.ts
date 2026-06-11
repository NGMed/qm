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

  it('synthesises a linear config ladder from 1 panel up to the roof max', () => {
    // One config per possible panel count, so sizing.nearestConfig always
    // finds an honestly-sized config for ANY clamped tier count — a single
    // max-roof config would hand every tier the full roof's energy.
    expect(facts.panel_configs.length).toBe(46)
    expect(facts.panel_configs[0].panels_count).toBe(1)
    const top = facts.panel_configs[facts.panel_configs.length - 1]
    // 46 panels × 400 W = 18.4 kW DC; 18.4 × 1400 kWh/kW/yr = 25760 kWh/yr
    expect(top.panels_count).toBe(46)
    expect(top.yearly_energy_dc_kwh).toBe(25760)
  })

  it('ladder yield is proportional to the panel count', () => {
    // 10 panels = 4 kW × 1400 = 5600 kWh/yr (hand-worked)
    const ten = facts.panel_configs.find((c) => c.panels_count === 10)!
    expect(ten.yearly_energy_dc_kwh).toBe(5600)
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
    expect(f.panel_configs.at(-1)!.yearly_energy_dc_kwh).toBe(26460)
  })

  it('config overrides manual_benchmark_kwh_per_kw', () => {
    // panels = floor(90 / 1.95) = 46, capacity = 400 W, system = 18.4 kW DC
    // benchmark = 1600 kWh/kW/yr → DC = 18.4 × 1600 = 29440 kWh/yr
    const f = buildManualRoofFacts(medNorth, {
      manual_benchmark_kwh_per_kw: 1600,
    })
    expect(f.panel_configs.at(-1)!.yearly_energy_dc_kwh).toBe(29440)
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
    expect(f.panel_configs.at(-1)!.yearly_energy_dc_kwh).toBe(25760)
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

describe('buildManualRoofFacts — volumetric grounding (state benchmark + orientation)', () => {
  const medNorth: SolarManualRoofInput = {
    orientation: 'north',
    roof_size: 'medium',
    storeys: 1,
  }

  it('state-specific benchmark wins over the flat benchmark', () => {
    // TAS 1325 vs flat 1400: 18.4 kW × 1325 = 24380 kWh/yr
    const f = buildManualRoofFacts(
      medNorth,
      {
        manual_benchmark_kwh_per_kw: 1400,
        manual_benchmark_by_state: { TAS: 1325 },
      },
      'TAS',
    )
    expect(f.panel_configs.at(-1)!.yearly_energy_dc_kwh).toBe(24380)
  })

  it('missing state entry falls back to the flat benchmark', () => {
    const f = buildManualRoofFacts(
      medNorth,
      {
        manual_benchmark_kwh_per_kw: 1400,
        manual_benchmark_by_state: { TAS: 1325 },
      },
      'QLD',
    )
    expect(f.panel_configs.at(-1)!.yearly_energy_dc_kwh).toBe(25760)
  })

  it('no state argument behaves exactly like the pre-volumetric path', () => {
    const f = buildManualRoofFacts(medNorth, {
      manual_benchmark_kwh_per_kw: 1400,
      manual_benchmark_by_state: { NSW: 1621 },
    })
    expect(f.panel_configs.at(-1)!.yearly_energy_dc_kwh).toBe(25760)
  })

  it('corrupt state benchmark (0) degrades to the flat benchmark, not zero', () => {
    const f = buildManualRoofFacts(
      medNorth,
      {
        manual_benchmark_kwh_per_kw: 1400,
        manual_benchmark_by_state: { NSW: 0 },
      },
      'NSW',
    )
    expect(f.panel_configs.at(-1)!.yearly_energy_dc_kwh).toBe(25760)
  })

  it('declared south orientation derates the yield by the configured factor', () => {
    // 18.4 kW × 1400 × 0.80 = 20608 kWh/yr
    const f = buildManualRoofFacts({ ...medNorth, orientation: 'south' }, {
      manual_benchmark_kwh_per_kw: 1400,
      manual_orientation_yield_factors: { south: 0.8 },
    })
    expect(f.panel_configs.at(-1)!.yearly_energy_dc_kwh).toBe(20608)
  })

  it('north keeps factor 1.0 and an absent factor table means no adjustment', () => {
    const withTable = buildManualRoofFacts(medNorth, {
      manual_benchmark_kwh_per_kw: 1400,
      manual_orientation_yield_factors: { north: 1.0, south: 0.8 },
    })
    const withoutTable = buildManualRoofFacts(medNorth, {
      manual_benchmark_kwh_per_kw: 1400,
    })
    expect(withTable.panel_configs.at(-1)!.yearly_energy_dc_kwh).toBe(25760)
    expect(withoutTable.panel_configs.at(-1)!.yearly_energy_dc_kwh).toBe(25760)
  })

  it('invalid orientation factors (0, negative, >1.2, NaN) mean no adjustment', () => {
    for (const bad of [0, -0.5, 1.5, NaN]) {
      const f = buildManualRoofFacts({ ...medNorth, orientation: 'south' }, {
        manual_benchmark_kwh_per_kw: 1400,
        manual_orientation_yield_factors: { south: bad },
      })
      expect(f.panel_configs.at(-1)!.yearly_energy_dc_kwh).toBe(25760)
    }
  })

  it('DEFAULT_SOLAR_CONFIG manual yields stay inside the CEC ±35% band for every state × orientation', async () => {
    // The whole point of the per-state benchmarks: implied AC/kW =
    // benchmark × derate × factor must sit within [0.65, 1.35] × CEC(state)
    // for every declared orientation, or guardrails would block publish.
    const { DEFAULT_SOLAR_CONFIG } = await import('./config')
    const { __test_only__: prodInternals } = await import('./production')
    const cecByState = prodInternals.CEC_BENCHMARK_BY_STATE as Record<string, number>
    const derate = DEFAULT_SOLAR_CONFIG.derate_factor
    const states = Object.keys(cecByState) as Array<keyof typeof cecByState>
    const factors = DEFAULT_SOLAR_CONFIG.manual_orientation_yield_factors!
    for (const state of states) {
      const benchmark =
        DEFAULT_SOLAR_CONFIG.manual_benchmark_by_state![state as 'NSW'] ??
        DEFAULT_SOLAR_CONFIG.manual_benchmark_kwh_per_kw!
      for (const factor of Object.values(factors)) {
        const impliedAcPerKw = benchmark * derate * factor!
        const cec = cecByState[state]
        expect(impliedAcPerKw).toBeGreaterThanOrEqual(cec * 0.65)
        expect(impliedAcPerKw).toBeLessThanOrEqual(cec * 1.35)
      }
    }
  })
})
