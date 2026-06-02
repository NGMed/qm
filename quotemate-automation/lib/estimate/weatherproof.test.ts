// Weatherproof / outdoor spec rule + its integration into reconcileProductSpecs.

import { describe, expect, it } from 'vitest'
import {
  productIsWeatherproof,
  requiresWeatherproof,
  weatherproofConflict,
} from './weatherproof'
import { reconcileProductSpecs } from './spec-guard'

describe('requiresWeatherproof', () => {
  it('triggers on an outdoor/external location', () => {
    expect(requiresWeatherproof({ location: 'exterior_wall' })).toBe(true)
    expect(requiresWeatherproof({ location: 'outdoor patio' })).toBe(true)
    expect(requiresWeatherproof({ location: 'carport' })).toBe(true)
  })
  it('does NOT trigger on use_case alone (unreliable) — the location drives it', () => {
    expect(requiresWeatherproof({ use_case: 'caravan' })).toBe(false)
    expect(requiresWeatherproof({ location: 'exterior_wall', use_case: 'caravan' })).toBe(true)
  })
  it('triggers on an explicit weatherproof flag or an IP44+ rating', () => {
    expect(requiresWeatherproof({ weatherproof: 'yes' })).toBe(true)
    expect(requiresWeatherproof({ ip_rating: 'IP54' })).toBe(true)
  })
  it('does NOT trigger for indoor jobs, indoor qualifiers, low IP, or empty specs', () => {
    expect(requiresWeatherproof({ location: 'kitchen', amperage: '15A' })).toBe(false)
    expect(requiresWeatherproof({ use_case: 'sauna' })).toBe(false)
    // indoor qualifier overrides an exposure word
    expect(requiresWeatherproof({ location: 'enclosed patio' })).toBe(false)
    expect(requiresWeatherproof({ location: 'patio doors inside the lounge' })).toBe(false)
    // a low/indoor IP code must not flip the requirement on
    expect(requiresWeatherproof({ ip_rating: 'IP20' })).toBe(false)
    // high-collision indoor-common words are not triggers
    expect(requiresWeatherproof({ use_case: 'pool pump' })).toBe(false)
    expect(requiresWeatherproof({ location: 'garden room' })).toBe(false)
    expect(requiresWeatherproof({})).toBe(false)
    expect(requiresWeatherproof(null)).toBe(false)
  })
})

describe('productIsWeatherproof', () => {
  it('true on a weatherproof/outdoor flag', () => {
    expect(productIsWeatherproof({ weatherproof: true })).toBe(true)
    expect(productIsWeatherproof({ outdoor: 'yes' })).toBe(true)
  })
  it('true on IP44+ rating, false below', () => {
    expect(productIsWeatherproof({ ip_rating: 'IP56' })).toBe(true)
    expect(productIsWeatherproof({ ip_rating: 'IP44' })).toBe(true)
    expect(productIsWeatherproof({ ip_rating: 'IP20' })).toBe(false)
  })
  it('true when the NAME says weatherproof / outdoor / IPxx', () => {
    expect(productIsWeatherproof(null, 'Weatherproof outdoor GPO')).toBe(true)
    expect(productIsWeatherproof(null, 'Clipsal IP66 GPO')).toBe(true)
  })
  it('false for a plain indoor product', () => {
    expect(productIsWeatherproof({ amperage: '15A' }, 'Clipsal 15Amp')).toBe(false)
    expect(productIsWeatherproof(null, 'Clipsal Iconic GPO')).toBe(false)
  })
  it('does NOT treat a bare "exterior"/"outdoor" name word as weatherproof (indoor-product trap)', () => {
    expect(productIsWeatherproof({ amperage: '15A' }, 'Indoor exterior-trim GPO')).toBe(false)
    expect(productIsWeatherproof(null, 'Clipsal exterior-grade indoor switch')).toBe(false)
  })
})

describe('weatherproofConflict', () => {
  it('flags an indoor product on an external job', () => {
    const c = weatherproofConflict({ location: 'exterior_wall' }, { amperage: '15A' }, 'Clipsal 15Amp')
    expect(c).not.toBeNull()
    expect(c?.key).toBe('weatherproof')
  })
  it('no conflict when the product IS weatherproof', () => {
    expect(weatherproofConflict({ location: 'exterior_wall' }, { weatherproof: true }, 'WP GPO')).toBeNull()
  })
  it('no conflict for an indoor job', () => {
    expect(weatherproofConflict({ location: 'kitchen' }, { amperage: '15A' }, 'Clipsal 15Amp')).toBeNull()
  })
})

describe('reconcileProductSpecs — outdoor rule integration', () => {
  it('the exact Jon case: 15A caravan GPO on an exterior wall + an indoor 15A product → mismatch', () => {
    const r = reconcileProductSpecs({
      requested: { amperage: '15A', location: 'exterior_wall', use_case: 'caravan' },
      properties: { amperage: '15A' },
      name: 'Clipsal 15Amp',
      trade: 'electrical',
      category: 'gpo',
    })
    expect(r.verdict).toBe('mismatch')
    expect(r.conflicts.some((c) => c.key === 'weatherproof')).toBe(true)
  })
  it('a weatherproof 15A product on the same job → match', () => {
    const r = reconcileProductSpecs({
      requested: { amperage: '15A', location: 'exterior_wall' },
      properties: { amperage: '15A', weatherproof: true },
      name: 'Clipsal 15A Weatherproof GPO',
      trade: 'electrical',
      category: 'gpo',
    })
    expect(r.verdict).toBe('match')
  })
  it('does not apply the weatherproof rule to plumbing', () => {
    const r = reconcileProductSpecs({
      requested: { location: 'exterior_wall', energy_source: 'gas' },
      properties: { energy_source: 'gas' },
      name: 'Rinnai gas HWS',
      trade: 'plumbing',
      category: 'hot_water',
    })
    expect(r.verdict).not.toBe('mismatch')
  })
})
