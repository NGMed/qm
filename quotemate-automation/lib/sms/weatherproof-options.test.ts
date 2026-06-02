// WP9 product selection + advisory under the outdoor/weatherproof rule.

import { describe, expect, it } from 'vitest'
import { selectProductOptions, weatherproofAdvisory } from './product-options'
import type { TenantMaterial } from '@/lib/estimate/catalogue'

function mat(o: Partial<TenantMaterial>): TenantMaterial {
  return { active: true, trade: 'electrical', category: 'gpo', ...o } as TenantMaterial
}

const indoor = mat({ id: 'i1', name: 'Clipsal 15Amp', unit_price_ex_gst: 44, properties: { amperage: '15A' } })
const weatherproofGpo = mat({ id: 'w1', name: 'Clipsal 15A Weatherproof', unit_price_ex_gst: 60, properties: { amperage: '15A', weatherproof: true } })

const externalSpecs = { amperage: '15A', location: 'exterior_wall', use_case: 'caravan' }
const opts = { trade: 'electrical' as const }

describe('selectProductOptions — outdoor prefers a weatherproof product', () => {
  it('an external 15A job picks the weatherproof 15A over the indoor 15A', () => {
    const out = selectProductOptions([indoor, weatherproofGpo], 'gpo', { ...opts, requestedSpecs: externalSpecs })
    expect(out).not.toBeNull()
    // indoor reconciles as a mismatch for an outdoor job, so only the
    // weatherproof one matches → it's the single offered option.
    expect(out!.every((o) => o.catalogue_id === 'w1')).toBe(true)
  })

  it('still offers the indoor product when it is the only one (fallback), but flags it', () => {
    const out = selectProductOptions([indoor], 'gpo', { ...opts, requestedSpecs: externalSpecs })
    expect(out).not.toBeNull()
    expect(out![0].catalogue_id).toBe('i1') // customer still gets an option
    const adv = weatherproofAdvisory([indoor], 'gpo', externalSpecs, 'electrical')
    expect(adv).toEqual({ required: true, available: false })
  })

  it('an indoor job is unaffected (no weatherproof requirement)', () => {
    const adv = weatherproofAdvisory([indoor], 'gpo', { amperage: '15A', location: 'kitchen' }, 'electrical')
    expect(adv.required).toBe(false)
  })
})

describe('weatherproofAdvisory', () => {
  it('available when the catalogue has a weatherproof product', () => {
    expect(weatherproofAdvisory([indoor, weatherproofGpo], 'gpo', externalSpecs, 'electrical')).toEqual({
      required: true,
      available: true,
    })
  })
  it('not required for plumbing/roofing trades', () => {
    expect(weatherproofAdvisory([indoor], 'gpo', externalSpecs, 'plumbing').required).toBe(false)
  })
})
