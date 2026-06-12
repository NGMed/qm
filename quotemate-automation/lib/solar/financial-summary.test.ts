import { describe, it, expect } from 'vitest'
import {
  buildSolarFinancialSummary,
  buildSolarEnvironmentalImpact,
  npv,
  solveIrr,
  SUMMARY_HORIZON_YEARS,
  CHART_HORIZON_YEARS,
} from './financial-summary'
import type { SolarEconomicsTier, SolarPriceTier } from './types'

function makeEcon(savings: number): SolarEconomicsTier {
  return {
    tier: 'better',
    self_consumed_kwh: 3600,
    exported_kwh: 5400,
    bill_savings_aud: savings * 0.74,
    export_earnings_aud: savings * 0.26,
    annual_savings_aud: savings,
    payback_years_low: 4.2,
    payback_years_high: 7.9,
  }
}

function makePrice(net: number): SolarPriceTier {
  return {
    tier: 'better',
    label: '6.6 kW system',
    system_kw_dc: 6.6,
    gross_ex_gst: net + 2000,
    gross_inc_gst: (net + 2000) * 1.1,
    stc: {
      system_kw: 6.6,
      zone_rating: 1.382,
      deeming_years: 5,
      certificates: 45,
      stc_price_aud: 38,
      rebate_aud: 2000,
    },
    net_ex_gst: net,
    net_inc_gst: net * 1.1,
    scope: 'Standard install',
  }
}

const CONFIG = {
  price_escalation_pct_per_year: 0.03,
  discount_rate_pct: 0.05,
  degradation_pct_per_year: 0.005,
}

describe('npv', () => {
  it('discounts cashflows by year index', () => {
    // −100 now + 110 in one year @10% → exactly 0.
    expect(npv(0.1, [-100, 110])).toBeCloseTo(0, 10)
  })
  it('zero rate sums the flows', () => {
    expect(npv(0, [-100, 60, 60])).toBeCloseTo(20, 10)
  })
})

describe('solveIrr', () => {
  it('recovers a known IRR', () => {
    // −100 then 110 → IRR 10%.
    expect(solveIrr([-100, 110])!).toBeCloseTo(0.1, 6)
  })
  it('finds the (negative) root when savings never repay the cost', () => {
    // The raw solver is honest: a deeply negative IRR exists here. The
    // summary layer suppresses non-positive IRRs for display.
    const irr = solveIrr([-100, 1, 1])
    expect(irr).not.toBeNull()
    expect(irr!).toBeLessThan(0)
  })
  it('null on all-positive cashflows', () => {
    expect(solveIrr([100, 100])).toBeNull()
  })
})

describe('buildSolarFinancialSummary', () => {
  it('hand-computed projection: year-2 savings apply degradation × escalation', () => {
    const out = buildSolarFinancialSummary({
      econ: makeEcon(1000),
      price: makePrice(8000),
      config: CONFIG,
    })!
    expect(out.years[0].savings_aud).toBeCloseTo(1000, 2)
    // year 2 = 1000 × 0.995 × 1.03 = 1024.85
    expect(out.years[1].savings_aud).toBeCloseTo(1024.85, 2)
    expect(out.years[1].cumulative_aud).toBeCloseTo(2024.85, 2)
  })

  it(`produces a ${CHART_HORIZON_YEARS}-year series and 20-year aggregates`, () => {
    const out = buildSolarFinancialSummary({
      econ: makeEcon(1000),
      price: makePrice(8000),
      config: CONFIG,
    })!
    expect(out.years).toHaveLength(CHART_HORIZON_YEARS)
    // 20-yr total: sum of 1000 × (0.995 × 1.03)^(y−1), y=1..20.
    const g = 0.995 * 1.03
    const expected = (1000 * (g ** SUMMARY_HORIZON_YEARS - 1)) / (g - 1)
    expect(out.total_savings_20yr_aud).toBeCloseTo(expected, 0)
    expect(out.total_roi_pct).toBeCloseTo((expected / 8000) * 100, 0)
  })

  it('NPV is positive for a clearly good system and IRR brackets', () => {
    const out = buildSolarFinancialSummary({
      econ: makeEcon(1500),
      price: makePrice(7000),
      config: CONFIG,
    })!
    expect(out.npv_aud).toBeGreaterThan(0)
    expect(out.irr_pct).not.toBeNull()
    expect(out.irr_pct!).toBeGreaterThan(15) // ~year-1 yield 21%, rising
  })

  it('IRR is null when the system never pays back inside 20 years', () => {
    const out = buildSolarFinancialSummary({
      econ: makeEcon(10),
      price: makePrice(50000),
      config: CONFIG,
    })!
    expect(out.irr_pct).toBeNull()
    expect(out.npv_aud).toBeLessThan(0)
  })

  it('passes the engine payback band through untouched', () => {
    const out = buildSolarFinancialSummary({
      econ: makeEcon(1000),
      price: makePrice(8000),
      config: CONFIG,
    })!
    expect(out.payback_years_low).toBe(4.2)
    expect(out.payback_years_high).toBe(7.9)
  })

  it('null for zero savings or zero net price (inspection/degenerate)', () => {
    expect(
      buildSolarFinancialSummary({ econ: makeEcon(0), price: makePrice(8000), config: CONFIG }),
    ).toBeNull()
    expect(
      buildSolarFinancialSummary({ econ: makeEcon(1000), price: makePrice(0), config: CONFIG }),
    ).toBeNull()
  })

  it('guards bad config rates to the documented defaults', () => {
    const out = buildSolarFinancialSummary({
      econ: makeEcon(1000),
      price: makePrice(8000),
      config: {
        price_escalation_pct_per_year: Number.NaN,
        discount_rate_pct: -1,
        degradation_pct_per_year: 2,
      },
    })!
    expect(out.assumptions.escalation_pct_per_year).toBe(0.03)
    expect(out.assumptions.discount_rate_pct).toBe(0.05)
    expect(out.assumptions.degradation_pct_per_year).toBe(0.005)
  })
})

describe('buildSolarEnvironmentalImpact', () => {
  const config = {
    co2_equiv_trees_per_tonne: 15,
    co2_equiv_km_driven_per_tonne: 4000,
    degradation_pct_per_year: 0.005,
  }

  it('hand-computed: 9000 kWh × 790 kg/MWh = 7.11 tonnes/yr', () => {
    const out = buildSolarEnvironmentalImpact({
      annual_kwh_ac: 9000,
      carbon_offset_factor_kg_per_mwh: 790,
      config,
    })!
    expect(out.tonnes_co2_per_year).toBeCloseTo(7.11, 2)
    expect(out.trees_equiv_per_year).toBe(Math.round(7.11 * 15))
    expect(out.km_driven_equiv_per_year).toBe(Math.round(7.11 * 4000))
    // 20-year total with 0.5%/yr degradation < 20 × yearly but > 19 ×.
    expect(out.tonnes_co2_20yr).toBeLessThan(7.11 * 20)
    expect(out.tonnes_co2_20yr).toBeGreaterThan(7.11 * 19)
  })

  it('null when the carbon factor is absent (manual fallback §4.6)', () => {
    expect(
      buildSolarEnvironmentalImpact({
        annual_kwh_ac: 9000,
        carbon_offset_factor_kg_per_mwh: null,
        config,
      }),
    ).toBeNull()
    expect(
      buildSolarEnvironmentalImpact({
        annual_kwh_ac: 9000,
        carbon_offset_factor_kg_per_mwh: undefined,
        config,
      }),
    ).toBeNull()
  })

  it('null on non-positive production', () => {
    expect(
      buildSolarEnvironmentalImpact({
        annual_kwh_ac: 0,
        carbon_offset_factor_kg_per_mwh: 790,
        config,
      }),
    ).toBeNull()
  })
})
