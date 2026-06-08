import { describe, it, expect } from 'vitest'
import { normaliseSolarRoofFacts } from './roof'
import { COVERED_INSIGHT, COVERED_RAW_BODY } from './__fixtures__/building-insights'
import type { SolarCoverageResult } from './types'

const COVERAGE = {
  covered: true,
  location: { lat: -33.8688, lng: 151.2093 },
  imagery_quality: 'HIGH',
  imagery_date: '2024-03-12',
} satisfies Extract<SolarCoverageResult, { covered: true }>

describe('normaliseSolarRoofFacts', () => {
  const facts = normaliseSolarRoofFacts(
    { ...COVERED_INSIGHT, raw: COVERED_RAW_BODY },
    COVERAGE,
  )

  it('tags the source as google', () => {
    expect(facts.source).toBe('google')
  })

  it('carries usable area = sum of segment areas (120 m²)', () => {
    expect(facts.usable_area_m2).toBe(120)
  })

  it('reports the segment count and planes', () => {
    expect(facts.segment_count).toBe(2)
    expect(facts.planes.length).toBe(2)
  })

  it('picks the largest plane as the primary orientation (north)', () => {
    expect(facts.primary_orientation).toBe('north')
  })

  it('computes the area-weighted mean pitch (20°)', () => {
    expect(facts.mean_pitch_degrees).toBe(20)
  })

  it('reads maxArrayPanelsCount + panelCapacityWatts from the raw body', () => {
    expect(facts.max_panels_count).toBe(30)
    expect(facts.panel_capacity_watts).toBe(400)
  })

  it('reads the three precomputed panel configs', () => {
    expect(facts.panel_configs).toEqual([
      { panels_count: 16, yearly_energy_dc_kwh: 9600 },
      { panels_count: 24, yearly_energy_dc_kwh: 14400 },
      { panels_count: 30, yearly_energy_dc_kwh: 18000 },
    ])
  })

  it('carries imagery metadata through from coverage', () => {
    expect(facts.imagery_quality).toBe('HIGH')
    expect(facts.imagery_date).toBe('2024-03-12')
  })

  it('maps azimuth 0 → north and 180 → south on the planes', () => {
    const norths = facts.planes.filter((p) => p.orientation === 'north')
    const souths = facts.planes.filter((p) => p.orientation === 'south')
    expect(norths.length).toBe(1)
    expect(souths.length).toBe(1)
  })

  it('defaults panel capacity to 400W when the raw body omits it', () => {
    const noCap = normaliseSolarRoofFacts(
      { ...COVERED_INSIGHT, raw: { solarPotential: {} } },
      COVERAGE,
    )
    expect(noCap.panel_capacity_watts).toBe(400)
  })
})
