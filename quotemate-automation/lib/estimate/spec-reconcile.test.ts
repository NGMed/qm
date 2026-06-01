// Unit tests for the spec-reconcile pure module (reconcileSpecs).

import { describe, expect, it } from 'vitest'
import { reconcileSpecs } from './spec-reconcile'

describe('reconcileSpecs — positive contradiction → mismatch', () => {
  it('15A requested vs 10A product (electrical/gpo)', () => {
    const r = reconcileSpecs({ amperage: '15A' }, { amperage: '10A' }, 'electrical', 'gpo')
    expect(r.verdict).toBe('mismatch')
    expect(r.conflicts).toEqual([{ key: 'amperage', requested: '15A', product: '10A' }])
  })

  it('matches across sloppy phrasings (15A vs "15 amp")', () => {
    const r = reconcileSpecs({ amperage: '15A' }, { amperage: '15 amp' }, 'electrical', 'gpo')
    expect(r.verdict).toBe('match')
    expect(r.conflicts).toHaveLength(0)
  })

  it('IP56 requested vs IP20 product (electrical/outdoor_light)', () => {
    const r = reconcileSpecs(
      { ip_rating: 'IP56' },
      { ip_rating: 'IP20' },
      'electrical',
      'outdoor_light',
    )
    expect(r.verdict).toBe('mismatch')
  })

  it('gas requested vs electric product (plumbing/hot_water)', () => {
    const r = reconcileSpecs(
      { energy_source: 'gas' },
      { energy_source: 'electric', litres: '250' },
      'plumbing',
      'hot_water',
    )
    expect(r.verdict).toBe('mismatch')
    expect(r.conflicts.map((c) => c.key)).toEqual(['energy_source'])
  })
})

describe('reconcileSpecs — degrade-never-block', () => {
  it('empty / null requested → vacuous match', () => {
    expect(reconcileSpecs({}, { amperage: '10A' }, 'electrical', 'gpo').verdict).toBe('match')
    expect(reconcileSpecs(null, { amperage: '10A' }, 'electrical', 'gpo').verdict).toBe('match')
    expect(reconcileSpecs(undefined, null, 'electrical', 'gpo').verdict).toBe('match')
  })

  it('requested spec but product has no such property → unknown', () => {
    const r = reconcileSpecs({ amperage: '15A' }, {}, 'electrical', 'gpo')
    expect(r.verdict).toBe('unknown')
    expect(r.conflicts).toHaveLength(0)
  })

  it('sloppy product NAME (no structured amperage prop) does NOT false-mismatch', () => {
    // The product is named "Clipsal 2000 GPO 10A/15A combo" but its structured
    // properties carry no amperage key — reconcile reads props, not the name.
    const r = reconcileSpecs(
      { amperage: '15A' },
      { brand: 'Clipsal', range: '2000' },
      'electrical',
      'gpo',
    )
    expect(r.verdict).toBe('unknown')
    expect(r.conflicts).toHaveLength(0)
  })

  it('unparseable requested value → unknown, never mismatch', () => {
    const r = reconcileSpecs({ amperage: 'fifteenish' }, { amperage: '10A' }, 'electrical', 'gpo')
    expect(r.verdict).toBe('unknown')
    expect(r.conflicts).toHaveLength(0)
  })

  it('unparseable product value → unknown, never mismatch', () => {
    const r = reconcileSpecs({ amperage: '15A' }, { amperage: 'big one' }, 'electrical', 'gpo')
    expect(r.verdict).toBe('unknown')
  })
})

describe('reconcileSpecs — key scoping', () => {
  it('only reconciles keys the registry cares about for the category', () => {
    // colour is not a gpo spec → ignored → vacuous match (no false unknown).
    const r = reconcileSpecs({ colour: 'red' }, { amperage: '10A' }, 'electrical', 'gpo')
    expect(r.verdict).toBe('match')
  })

  it('unseeded category falls back to raw key compare (still catches contradiction)', () => {
    // electrical/fan has no SpecDefs → compare the requested key directly.
    const r = reconcileSpecs({ amperage: '15A' }, { amperage: '10A' }, 'electrical', 'fan')
    expect(r.verdict).toBe('mismatch')
  })

  it('mismatch on one key wins even when another matches', () => {
    const r = reconcileSpecs(
      { energy_source: 'gas', litres: '250' },
      { energy_source: 'electric', litres: '250' },
      'plumbing',
      'hot_water',
    )
    expect(r.verdict).toBe('mismatch')
    expect(r.conflicts.map((c) => c.key)).toEqual(['energy_source'])
  })
})
