import { describe, it, expect } from 'vitest'
import { finaliseSolarEstimate } from './intake'
import type { SolarEstimate } from './types'

function cleanEstimate(): SolarEstimate {
  return {
    token: 'tok_final_123456',
    context: { postcode: '2000', state: 'NSW', install_year: 2026, network: 'Ausgrid' },
    coverage_source: 'google',
    roof: {
      source: 'google',
      usable_area_m2: 60,
      planes: [],
      segment_count: 2,
      primary_orientation: 'north',
      mean_pitch_degrees: 22,
      max_panels_count: 18,
      panel_capacity_watts: 400,
      panel_configs: [],
      storeys: 1,
      polygon_geojson: null,
      imagery_quality: 'HIGH',
      imagery_date: '2025-11-01',
    },
    sizing: {
      tiers: [],
      roof_capacity_kw_dc: 7.2,
      export_limit_kw_ac: 5,
      routing: { decision: 'tradie_review', reason: 'auto-calculated' },
    },
    production: [
      {
        system_kw_dc: 6.6,
        annual_kwh_ac: 9200,
        annual_kwh_low: 7360,
        annual_kwh_high: 11040,
        derate_applied: 0.81,
        degradation_pct_per_year: 0.005,
        cec_benchmark_kwh_per_kw: 1400,
        within_cec_benchmark: true,
        band: 'tight',
      },
    ],
    price: {
      tiers: [
        {
          tier: 'better',
          label: 'Full-size system',
          system_kw_dc: 6.6,
          gross_ex_gst: 8000,
          gross_inc_gst: 8800,
          stc: {
            system_kw: 6.6,
            zone_rating: 1.382,
            deeming_years: 5,
            certificates: 45,
            stc_price_aud: 38,
            rebate_aud: 1710,
          },
          net_ex_gst: 6290,
          net_inc_gst: 6919,
          scope: '6.6 kW solar install with standard panels.',
        },
      ],
      effective_rate_per_kw: 1212,
      loadings_applied: [],
      routing: { decision: 'tradie_review', reason: 'auto-calculated' },
      call_out_minimum_applied: false,
    },
    economics: {
      tiers: [
        {
          tier: 'better',
          self_consumed_kwh: 3600,
          exported_kwh: 5400,
          bill_savings_aud: 1080,
          export_earnings_aud: 270,
          annual_savings_aud: 1350,
          payback_years_low: 4.2,
          payback_years_high: 6.8,
        },
      ],
      assumptions: {
        self_consumption_pct: 0.4,
        retail_rate_aud_per_kwh: 0.3,
        feed_in_tariff_aud_per_kwh: 0.05,
        feed_in_network: 'Ausgrid',
      },
    },
    confidence_band: 'tight',
    satellite_image_url: null,
    routing: { decision: 'auto_quote', reason: 'within bounds' },
    guardrail_flags: [],
    config_version: '2026-06-01',
  }
}

describe('finaliseSolarEstimate', () => {
  it('leaves a clean estimate flag-free and tradie-reviewed', () => {
    const out = finaliseSolarEstimate(cleanEstimate())
    expect(out.guardrail_flags).toEqual([])
    expect(out.routing.decision).toBe('tradie_review')
  })

  it('stamps guardrail_flags and forces tradie_review when a tier breaches bounds', () => {
    const e = cleanEstimate()
    e.price.tiers[0].net_ex_gst = 1 // breaks net = gross − STC
    const out = finaliseSolarEstimate(e)
    expect(out.guardrail_flags.length).toBeGreaterThan(0)
    expect(out.routing.decision).toBe('tradie_review')
    expect(out.routing.reason).toMatch(/checks/i)
  })
})
