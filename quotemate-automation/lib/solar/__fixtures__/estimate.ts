// Shared test fixture: a complete google-path SolarEstimate shaped
// exactly as intake.ts persists it (incl. the premium-quote fields from
// spec 2026-06-12 §4.1). Tests override fields per scenario.

import type { SolarEstimate, SolarPanelPlacement } from '../types'

export const FIXTURE_CENTER = { lat: -33.8688, lng: 151.2093 }

export function makeFixturePanels(n: number, segment = 0): SolarPanelPlacement[] {
  return Array.from({ length: n }, (_, i) => ({
    center: {
      lat: FIXTURE_CENTER.lat + Math.floor(i / 8) * 0.00003,
      lng: FIXTURE_CENTER.lng + (i % 8) * 0.00002,
    },
    orientation: 'PORTRAIT' as const,
    segment_index: segment,
    yearly_energy_dc_kwh: 550,
  }))
}

export function makeFixtureEstimate(
  overrides: Partial<SolarEstimate> = {},
): SolarEstimate {
  return {
    token: 'tok_premium_test',
    context: {
      postcode: '2570',
      state: 'NSW',
      install_year: 2026,
      network: 'Endeavour',
      location: FIXTURE_CENTER,
      quarterly_bill_aud: 480,
    },
    coverage_source: 'google',
    roof: {
      source: 'google',
      usable_area_m2: 120,
      planes: [
        {
          pitch_degrees: 22,
          azimuth_degrees: 10,
          area_m2: 120,
          orientation: 'north',
          panels_count: 25,
        },
      ],
      segment_count: 1,
      primary_orientation: 'north',
      mean_pitch_degrees: 22,
      max_panels_count: 25,
      panel_capacity_watts: 400,
      panel_configs: [
        { panels_count: 16, yearly_energy_dc_kwh: 8200 },
        { panels_count: 25, yearly_energy_dc_kwh: 12500 },
      ],
      storeys: 1,
      polygon_geojson: null,
      imagery_quality: 'HIGH',
      imagery_date: '2025-03-14',
      panels: makeFixturePanels(25),
      panel_size_m: { height_m: 1.879, width_m: 1.045 },
      carbon_offset_factor_kg_per_mwh: 790,
      whole_roof_area_m2: 130,
    },
    sizing: {
      tiers: [
        {
          tier: 'good',
          label: '6.4 kW system',
          system_kw_dc: 6.4,
          panels_count: 16,
          panel_type: 'standard_panels',
          source_config: { panels_count: 16, yearly_energy_dc_kwh: 8200 },
          export_limited: false,
        },
        {
          tier: 'better',
          label: '10 kW system',
          system_kw_dc: 10,
          panels_count: 25,
          panel_type: 'standard_panels',
          source_config: { panels_count: 25, yearly_energy_dc_kwh: 12500 },
          export_limited: false,
        },
      ],
      roof_capacity_kw_dc: 10,
      export_limit_kw_ac: 5,
      routing: { decision: 'tradie_review', reason: 'review' },
    },
    production: [
      {
        system_kw_dc: 6.4,
        annual_kwh_ac: 6642,
        annual_kwh_low: 5314,
        annual_kwh_high: 7970,
        derate_applied: 0.81,
        degradation_pct_per_year: 0.005,
        cec_benchmark_kwh_per_kw: 1460,
        within_cec_benchmark: true,
        band: 'tight',
      },
      {
        system_kw_dc: 10,
        annual_kwh_ac: 10125,
        annual_kwh_low: 8100,
        annual_kwh_high: 12150,
        derate_applied: 0.81,
        degradation_pct_per_year: 0.005,
        cec_benchmark_kwh_per_kw: 1460,
        within_cec_benchmark: true,
        band: 'tight',
      },
    ],
    price: {
      tiers: [
        {
          tier: 'good',
          label: '6.4 kW system',
          system_kw_dc: 6.4,
          gross_ex_gst: 7040,
          gross_inc_gst: 7744,
          stc: {
            system_kw: 6.4,
            zone_rating: 1.382,
            deeming_years: 5,
            certificates: 44,
            stc_price_aud: 38,
            rebate_aud: 1672,
          },
          net_ex_gst: 5368,
          net_inc_gst: 5904.8,
          scope: 'Standard install',
        },
        {
          tier: 'better',
          label: '10 kW system',
          system_kw_dc: 10,
          gross_ex_gst: 11000,
          gross_inc_gst: 12100,
          stc: {
            system_kw: 10,
            zone_rating: 1.382,
            deeming_years: 5,
            certificates: 69,
            stc_price_aud: 38,
            rebate_aud: 2622,
          },
          net_ex_gst: 8378,
          net_inc_gst: 9215.8,
          scope: 'Standard install',
        },
      ],
      effective_rate_per_kw: 1100,
      loadings_applied: [],
      routing: { decision: 'tradie_review', reason: 'review' },
      call_out_minimum_applied: false,
    },
    economics: {
      tiers: [
        {
          tier: 'good',
          self_consumed_kwh: 2657,
          exported_kwh: 3985,
          bill_savings_aud: 850.24,
          export_earnings_aud: 298.88,
          annual_savings_aud: 1149.12,
          payback_years_low: 3.9,
          payback_years_high: 6.7,
        },
        {
          tier: 'better',
          self_consumed_kwh: 4050,
          exported_kwh: 6075,
          bill_savings_aud: 1296,
          export_earnings_aud: 455.63,
          annual_savings_aud: 1751.63,
          payback_years_low: 4.0,
          payback_years_high: 6.8,
        },
      ],
      assumptions: {
        self_consumption_pct: 0.4,
        retail_rate_aud_per_kwh: 0.32,
        feed_in_tariff_aud_per_kwh: 0.075,
        feed_in_network: 'Endeavour',
      },
    },
    confidence_band: 'tight',
    satellite_image_url: null,
    data_layers: null,
    routing: { decision: 'tradie_review', reason: 'review' },
    guardrail_flags: [],
    config_version: 'solar-config-2026-06-08',
    ...overrides,
  }
}
