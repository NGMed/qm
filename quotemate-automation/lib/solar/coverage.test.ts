import { describe, it, expect } from 'vitest'
import { checkSolarCoverage } from './coverage'
import { resolveSolarOpts } from '../roofing/solar-api'
import { COVERED_RAW_BODY } from './__fixtures__/building-insights'
import type { SolarAddressInput, LatLng } from './types'

const ADDRESS: SolarAddressInput = {
  address: '1 Test St, Sydney',
  postcode: '2000',
  state: 'NSW',
}
const LOC: LatLng = { lat: -33.8688, lng: 151.2093 }

function fakeFetch(status: number, body: unknown) {
  return async () =>
    new Response(typeof body === 'string' ? body : JSON.stringify(body), {
      status,
      headers: { 'content-type': 'application/json' },
    })
}

describe('checkSolarCoverage', () => {
  it('returns covered with HIGH imagery + date when findClosest succeeds', async () => {
    const opts = resolveSolarOpts({ apiKey: 'k', fetchImpl: fakeFetch(200, COVERED_RAW_BODY) })
    const r = await checkSolarCoverage(ADDRESS, LOC, opts)
    expect(r.covered).toBe(true)
    if (r.covered) {
      expect(r.location).toEqual(LOC)
      expect(r.imagery_quality).toBe('HIGH')
      expect(r.imagery_date).toBe('2024-03-12')
    }
  })

  it('returns uncovered/no_building_at_address on a 404', async () => {
    const opts = resolveSolarOpts({ apiKey: 'k', fetchImpl: fakeFetch(404, { error: {} }) })
    const r = await checkSolarCoverage(ADDRESS, LOC, opts)
    expect(r.covered).toBe(false)
    if (!r.covered) expect(r.code).toBe('no_building_at_address')
  })

  it('returns uncovered/imagery_below_floor when quality is LOW', async () => {
    const lowBody = { ...COVERED_RAW_BODY, imageryQuality: 'LOW' }
    const opts = resolveSolarOpts({ apiKey: 'k', fetchImpl: fakeFetch(200, lowBody) })
    const r = await checkSolarCoverage(ADDRESS, LOC, opts)
    expect(r.covered).toBe(false)
    if (!r.covered) expect(r.code).toBe('imagery_below_floor')
  })

  it('returns uncovered/provider_unavailable on a network error', async () => {
    const opts = resolveSolarOpts({
      apiKey: 'k',
      fetchImpl: async () => {
        throw new Error('ECONNRESET')
      },
    })
    const r = await checkSolarCoverage(ADDRESS, LOC, opts)
    expect(r.covered).toBe(false)
    if (!r.covered) expect(r.code).toBe('provider_unavailable')
  })

  it('returns uncovered/provider_unavailable when the api key is missing', async () => {
    const opts = resolveSolarOpts({ apiKey: undefined, fetchImpl: fakeFetch(200, COVERED_RAW_BODY) })
    const r = await checkSolarCoverage(ADDRESS, LOC, opts)
    expect(r.covered).toBe(false)
    if (!r.covered) expect(r.code).toBe('provider_unavailable')
  })
})
