import { describe, it, expect } from 'vitest'
import { deriveSolarUtilityCosts, utilityCostsCaption } from './utility-costs'
import type {
  SolarEconomicsResult,
  SolarEstimateContext,
  SolarProductionResult,
} from './types'

function makeContext(bill: number | null): SolarEstimateContext {
  return {
    postcode: '2570',
    state: 'NSW',
    install_year: 2026,
    network: 'Endeavour',
    quarterly_bill_aud: bill,
  }
}

function makeEconomics(): SolarEconomicsResult {
  return {
    tiers: [
      {
        tier: 'good',
        self_consumed_kwh: 0,
        exported_kwh: 0,
        bill_savings_aud: 0,
        export_earnings_aud: 0,
        annual_savings_aud: 0,
        payback_years_low: null,
        payback_years_high: null,
      },
    ],
    assumptions: {
      self_consumption_pct: 0.4,
      retail_rate_aud_per_kwh: 0.32,
      feed_in_tariff_aud_per_kwh: 0.075,
      feed_in_network: 'Endeavour',
    },
  }
}

function makeProduction(annualKwhAc: number): SolarProductionResult[] {
  return [
    {
      system_kw_dc: 6.6,
      annual_kwh_ac: annualKwhAc,
      annual_kwh_low: annualKwhAc * 0.8,
      annual_kwh_high: annualKwhAc * 1.2,
      derate_applied: 0.81,
      degradation_pct_per_year: 0.005,
      cec_benchmark_kwh_per_kw: 1460,
      within_cec_benchmark: true,
      band: 'tight',
    },
  ]
}

const config = { typical_household_kwh_per_year: 6000 }

describe('deriveSolarUtilityCosts', () => {
  it('personal path: household kWh = bill × 4 ÷ retail', () => {
    const out = deriveSolarUtilityCosts({
      context: makeContext(480),
      economics: makeEconomics(),
      production: makeProduction(9000),
      config,
    })
    expect(out.source).toBe('personal')
    // 480 × 4 ÷ 0.32 = 6000 kWh
    expect(out.household_annual_kwh).toBe(6000)
    expect(out.annual_bill_before_aud).toBeCloseTo(1920, 2)
    expect(out.quarterly_bill_before_aud).toBeCloseTo(480, 2)
  })

  it('modelled path: no bill → config typical household, labelled modelled', () => {
    const out = deriveSolarUtilityCosts({
      context: makeContext(null),
      economics: makeEconomics(),
      production: makeProduction(9000),
      config,
    })
    expect(out.source).toBe('modelled')
    expect(out.household_annual_kwh).toBe(6000)
    expect(out.annual_bill_before_aud).toBeCloseTo(1920, 2)
  })

  it('with-solar bill = grid import × retail − export credit', () => {
    const out = deriveSolarUtilityCosts({
      context: makeContext(480),
      economics: makeEconomics(),
      production: makeProduction(9000),
      config,
    })
    const t = out.tiers[0]
    // self-consumed = min(9000 × 0.4, 6000) = 3600
    expect(t.self_consumed_kwh).toBe(3600)
    expect(t.grid_import_kwh).toBe(2400)
    expect(t.exported_kwh).toBe(5400)
    // 2400 × 0.32 − 5400 × 0.075 = 768 − 405 = 363
    expect(t.annual_bill_with_solar_aud).toBeCloseTo(363, 2)
    // offset = (1920 − 363) / 1920 ≈ 0.811
    expect(t.bill_offset_pct).toBeCloseTo(0.811, 3)
  })

  it('caps self-consumption at household usage on a tiny bill', () => {
    const out = deriveSolarUtilityCosts({
      context: makeContext(80), // 80 × 4 ÷ 0.32 = 1000 kWh household
      economics: makeEconomics(),
      production: makeProduction(9000),
      config,
    })
    const t = out.tiers[0]
    // engine's 0.4 × 9000 = 3600, but household only uses 1000
    expect(t.self_consumed_kwh).toBe(1000)
    expect(t.grid_import_kwh).toBe(0)
    expect(t.exported_kwh).toBe(8000)
    // 0 × 0.32 − 8000 × 0.075 = −600 (net credit)
    expect(t.annual_bill_with_solar_aud).toBeCloseTo(-600, 2)
    // offset clamps at 1
    expect(t.bill_offset_pct).toBe(1)
  })

  it('ignores non-finite / non-positive bills (degrades to modelled)', () => {
    for (const bad of [0, -50, Number.NaN, Number.POSITIVE_INFINITY]) {
      const out = deriveSolarUtilityCosts({
        context: makeContext(bad),
        economics: makeEconomics(),
        production: makeProduction(9000),
        config,
      })
      expect(out.source).toBe('modelled')
    }
  })

  it('falls back to the 6000 kWh default when config omits the typical figure', () => {
    const out = deriveSolarUtilityCosts({
      context: makeContext(null),
      economics: makeEconomics(),
      production: makeProduction(9000),
      config: {},
    })
    expect(out.household_annual_kwh).toBe(6000)
  })

  it('empty economics tiers (inspection path) → empty tiers, no throw', () => {
    const econ = makeEconomics()
    econ.tiers = []
    const out = deriveSolarUtilityCosts({
      context: makeContext(480),
      economics: econ,
      production: [],
      config,
    })
    expect(out.tiers).toEqual([])
    expect(out.annual_bill_before_aud).toBeGreaterThan(0)
  })
})

describe('utilityCostsCaption', () => {
  it('labels each source per the degradation matrix', () => {
    expect(utilityCostsCaption('personal')).toMatch(/quarterly bill you provided/i)
    expect(utilityCostsCaption('modelled')).toMatch(/modelled on typical usage/i)
  })
})
