import { describe, it, expect } from 'vitest'
import { buildSolarStatExplainers } from './explainers'
import type { SolarEstimate } from './types'

// Contract-faithful Google-path fixture (mirrors persist-helpers.test.ts).
const googleEstimate: SolarEstimate = {
  token: 'TOKEN123',
  context: { postcode: '2000', state: 'NSW', install_year: 2026, network: 'Ausgrid' },
  coverage_source: 'google',
  roof: {
    source: 'google',
    usable_area_m2: 60,
    planes: [
      { pitch_degrees: 22, azimuth_degrees: 10, area_m2: 38, orientation: 'north' },
      { pitch_degrees: 24, azimuth_degrees: 190, area_m2: 22, orientation: 'south' },
    ],
    segment_count: 2,
    primary_orientation: 'north',
    mean_pitch_degrees: 22,
    max_panels_count: 30,
    panel_capacity_watts: 400,
    panel_configs: [{ panels_count: 16, yearly_energy_dc_kwh: 9000 }],
    storeys: 1,
    polygon_geojson: null,
    imagery_quality: 'HIGH',
    imagery_date: '2025-03-01',
  },
  sizing: {
    tiers: [
      {
        tier: 'good',
        label: '4.0 kW starter system',
        system_kw_dc: 4.0,
        panels_count: 10,
        panel_type: 'standard_panels',
        source_config: { panels_count: 10, yearly_energy_dc_kwh: 5600 },
        export_limited: false,
      },
      {
        tier: 'best',
        label: '6.6 kW maximum-output system',
        system_kw_dc: 6.6,
        panels_count: 16,
        panel_type: 'standard_panels',
        source_config: { panels_count: 16, yearly_energy_dc_kwh: 9000 },
        export_limited: false,
      },
    ],
    roof_capacity_kw_dc: 12,
    export_limit_kw_ac: 5,
    routing: { decision: 'tradie_review', reason: 'Solar quote requires tradie sign-off.' },
  },
  production: [
    {
      system_kw_dc: 4.0,
      annual_kwh_ac: 5500,
      annual_kwh_low: 4400,
      annual_kwh_high: 6600,
      derate_applied: 0.81,
      degradation_pct_per_year: 0.005,
      cec_benchmark_kwh_per_kw: 1382,
      within_cec_benchmark: true,
      band: 'tight',
    },
    {
      system_kw_dc: 6.6,
      annual_kwh_ac: 9200,
      annual_kwh_low: 7360,
      annual_kwh_high: 11040,
      derate_applied: 0.81,
      degradation_pct_per_year: 0.005,
      cec_benchmark_kwh_per_kw: 1382,
      within_cec_benchmark: true,
      band: 'tight',
    },
  ],
  price: {
    tiers: [],
    effective_rate_per_kw: 1500,
    loadings_applied: [],
    routing: { decision: 'tradie_review', reason: 'Solar quote requires tradie sign-off.' },
    call_out_minimum_applied: false,
  },
  economics: {
    tiers: [],
    assumptions: {
      self_consumption_pct: 0.4,
      retail_rate_aud_per_kwh: 0.3,
      feed_in_tariff_aud_per_kwh: 0.06,
      feed_in_network: 'Ausgrid',
    },
  },
  confidence_band: 'tight',
  satellite_image_url: null,
  routing: { decision: 'tradie_review', reason: 'Solar quote requires tradie sign-off.' },
  guardrail_flags: [],
  config_version: '2026-01-01',
}

// Manual-fallback variant: declared roof, wide band, no planes.
const manualEstimate: SolarEstimate = {
  ...googleEstimate,
  coverage_source: 'manual',
  roof: {
    ...googleEstimate.roof,
    source: 'manual',
    planes: [],
    segment_count: 0,
    primary_orientation: 'south',
    mean_pitch_degrees: null,
    imagery_quality: null,
    imagery_date: null,
  },
  production: googleEstimate.production.map((p) => ({
    ...p,
    band: 'wide' as const,
    annual_kwh_low: Math.round(p.annual_kwh_ac * 0.7),
    annual_kwh_high: Math.round(p.annual_kwh_ac * 1.3),
  })),
  confidence_band: 'wide',
}

describe('buildSolarStatExplainers — google path', () => {
  const explainers = buildSolarStatExplainers(googleEstimate)
  const byKey = Object.fromEntries(explainers.map((e) => [e.key, e]))

  it('returns the four explainers in hero display order', () => {
    expect(explainers.map((e) => e.key)).toEqual([
      'system_size',
      'panels',
      'orientation',
      'yearly_output',
    ])
  })

  it('system size: stat value matches the headline (largest) tier', () => {
    expect(byKey.system_size.statValue).toBe('6.6 kW')
    expect(byKey.system_size.question).toBe('Why 6.6 kW?')
  })

  it('system size: facts carry roof capacity and export limit from sizing', () => {
    const labels = byKey.system_size.facts.map((f) => f.label)
    expect(labels).toContain('Roof capacity')
    expect(labels).toContain('Export limit')
    const cap = byKey.system_size.facts.find((f) => f.label === 'Roof capacity')!
    expect(cap.value).toBe('12.0 kW DC')
    const exp = byKey.system_size.facts.find((f) => f.label === 'Export limit')!
    expect(exp.value).toBe('5.0 kW AC')
    expect(exp.note).toContain('Ausgrid')
  })

  it('system size: steps trace measurement → capacity → export limit → selection', () => {
    const steps = byKey.system_size.steps
    expect(steps.length).toBeGreaterThanOrEqual(4)
    expect(steps[0]).toContain('60 m²')
    expect(steps[1]).toContain('30 × 400 W')
    expect(steps[2]).toContain('Ausgrid')
  })

  it('panels: counts come from roof facts and headline tier', () => {
    expect(byKey.panels.statValue).toBe('16')
    const max = byKey.panels.facts.find((f) => f.label === 'Maximum panels that fit')!
    expect(max.value).toBe('30')
    const area = byKey.panels.facts.find((f) => f.label === 'Usable roof area')!
    expect(area.value).toBe('60 m²')
    expect(area.note).toContain('satellite')
  })

  it('panels: area-per-panel is usable area ÷ max panels', () => {
    const f = byKey.panels.facts.find((x) => x.label === 'Roof area per panel')!
    expect(f.value).toContain('2.0 m²') // 60 / 30
  })

  it('orientation: lists planes largest-first with pitch and azimuth', () => {
    expect(byKey.orientation.statValue).toBe('North')
    const p1 = byKey.orientation.facts.find((f) => f.label === 'Roof plane 1')!
    expect(p1.value).toBe('North')
    expect(p1.note).toContain('38 m²')
    expect(p1.note).toContain('22°')
    const p2 = byKey.orientation.facts.find((f) => f.label === 'Roof plane 2')!
    expect(p2.value).toBe('South')
  })

  it('orientation: north-facing roof gets the well-oriented note', () => {
    expect(byKey.orientation.answer).toContain('well oriented')
  })

  it('yearly output: value, band, derate, CEC check all from production', () => {
    expect(byKey.yearly_output.statValue).toBe('9,200 kWh')
    const range = byKey.yearly_output.facts.find((f) => f.label === 'Likely range')!
    expect(range.value).toBe('7,360–11,040 kWh')
    expect(range.note).toContain('±20%')
    const derate = byKey.yearly_output.facts.find(
      (f) => f.label === 'Inverter & wiring losses',
    )!
    expect(derate.value).toBe('× 0.81')
    const cec = byKey.yearly_output.facts.find((f) => f.label === 'Industry cross-check')!
    expect(cec.value).toBe('Passed')
    expect(cec.note).toContain('NSW')
  })

  it('yearly output: derivation steps end at the displayed band', () => {
    const last = byKey.yearly_output.steps[byKey.yearly_output.steps.length - 1]
    expect(last).toContain('±20%')
    expect(last).toContain('7,360–11,040 kWh')
  })
})

describe('buildSolarStatExplainers — manual path', () => {
  const explainers = buildSolarStatExplainers(manualEstimate)
  const byKey = Object.fromEntries(explainers.map((e) => [e.key, e]))

  it('roof measurement step references declared details, not satellite', () => {
    expect(byKey.system_size.steps[0]).toContain('You told us')
    expect(byKey.system_size.steps[0]).not.toContain('Satellite')
  })

  it('panels: usable area note references provided details', () => {
    const area = byKey.panels.facts.find((f) => f.label === 'Usable roof area')!
    expect(area.note).toContain('you provided')
  })

  it('orientation: declared direction with no plane rows', () => {
    expect(byKey.orientation.statValue).toBe('South')
    expect(byKey.orientation.facts.some((f) => f.label.startsWith('Roof plane'))).toBe(false)
    expect(byKey.orientation.answer).toContain('you told us')
  })

  it('yearly output: wide band wording and ±30% range', () => {
    const range = byKey.yearly_output.facts.find((f) => f.label === 'Likely range')!
    expect(range.note).toContain('±30%')
    const last = byKey.yearly_output.steps[byKey.yearly_output.steps.length - 1]
    expect(last).toContain('details you provided')
  })
})

describe('buildSolarStatExplainers — degraded inputs', () => {
  it('empty tiers + empty production → To confirm copy, no throw', () => {
    const empty: SolarEstimate = {
      ...googleEstimate,
      sizing: {
        ...googleEstimate.sizing,
        tiers: [],
        routing: {
          decision: 'inspection_required',
          reason: 'No usable roof area for panels was detected.',
        },
      },
      production: [],
      routing: {
        decision: 'inspection_required',
        reason: 'No usable roof area for panels was detected.',
      },
    }
    const explainers = buildSolarStatExplainers(empty)
    const byKey = Object.fromEntries(explainers.map((e) => [e.key, e]))
    expect(byKey.system_size.statValue).toBe('To confirm')
    expect(byKey.panels.statValue).toBe('To confirm')
    expect(byKey.yearly_output.statValue).toBe('To confirm')
    expect(byKey.system_size.answer).toContain('No usable roof area')
  })

  it('null pitch / null azimuth planes render without NaN', () => {
    const odd: SolarEstimate = {
      ...googleEstimate,
      roof: {
        ...googleEstimate.roof,
        planes: [{ pitch_degrees: 0, azimuth_degrees: null, area_m2: 12, orientation: 'flat' }],
        mean_pitch_degrees: null,
        primary_orientation: 'flat',
      },
    }
    const explainers = buildSolarStatExplainers(odd)
    const orientation = explainers.find((e) => e.key === 'orientation')!
    expect(orientation.statValue).toBe('Flat')
    const p1 = orientation.facts.find((f) => f.label === 'Roof plane 1')!
    expect(p1.note).not.toContain('NaN')
    expect(p1.note).not.toContain('azimuth')
    expect(orientation.facts.some((f) => f.label === 'Average roof pitch')).toBe(false)
  })

  it('zero max panels → no division blowups in panels facts', () => {
    const zero: SolarEstimate = {
      ...googleEstimate,
      roof: { ...googleEstimate.roof, max_panels_count: 0, panel_configs: [] },
      sizing: {
        ...googleEstimate.sizing,
        tiers: [],
        routing: { decision: 'inspection_required', reason: 'No usable roof.' },
      },
      production: [],
    }
    const explainers = buildSolarStatExplainers(zero)
    const panels = explainers.find((e) => e.key === 'panels')!
    expect(panels.facts.some((f) => f.label === 'Roof area per panel')).toBe(false)
    expect(JSON.stringify(panels)).not.toContain('NaN')
  })
})
