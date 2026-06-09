import { describe, it, expect } from 'vitest'
import { parseGeocodeResponse, geocodeAddress } from './geocode'
import type { LatLng } from './types'

// A trimmed Google Geocoding API success body.
const OK_BODY = {
  status: 'OK',
  results: [
    {
      geometry: { location: { lat: -33.8688, lng: 151.2093 } },
      formatted_address: '1 Test St, Sydney NSW 2000, Australia',
    },
  ],
}

describe('parseGeocodeResponse', () => {
  it('returns ok + LatLng from a Google OK body', () => {
    const r = parseGeocodeResponse(OK_BODY)
    expect(r.ok).toBe(true)
    if (r.ok) {
      const loc: LatLng = r.location
      expect(loc.lat).toBeCloseTo(-33.8688, 4)
      expect(loc.lng).toBeCloseTo(151.2093, 4)
    }
  })

  it('returns not-ok on ZERO_RESULTS', () => {
    const r = parseGeocodeResponse({ status: 'ZERO_RESULTS', results: [] })
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.code).toBe('not_found')
  })

  it('returns not-ok on a non-object body', () => {
    const r = parseGeocodeResponse(null)
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.code).toBe('provider_error')
  })

  it('returns not-ok when results lack a finite location', () => {
    const r = parseGeocodeResponse({
      status: 'OK',
      results: [{ geometry: { location: { lat: 'x', lng: 2 } } }],
    })
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.code).toBe('provider_error')
  })
})

describe('geocodeAddress', () => {
  it('calls the geocoding endpoint and returns the parsed LatLng', async () => {
    let calledUrl = ''
    const fetchImpl = async (u: RequestInfo | URL) => {
      calledUrl = String(u)
      return new Response(JSON.stringify(OK_BODY), { status: 200 })
    }
    const r = await geocodeAddress('1 Test St, Sydney NSW 2000', {
      apiKey: 'KEY',
      fetchImpl,
    })
    expect(calledUrl).toContain('address=1')
    expect(calledUrl).toContain('key=KEY')
    expect(r.ok).toBe(true)
    if (r.ok) expect(r.location.lat).toBeCloseTo(-33.8688, 4)
  })

  it('fails closed without an apiKey, without calling fetch', async () => {
    let called = false
    const fetchImpl = async () => {
      called = true
      return new Response('{}', { status: 200 })
    }
    const r = await geocodeAddress('x', { apiKey: '', fetchImpl })
    expect(called).toBe(false)
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.code).toBe('config_missing')
  })

  it('surfaces a network error as not-ok', async () => {
    const fetchImpl = async () => {
      throw new Error('boom')
    }
    const r = await geocodeAddress('x', { apiKey: 'KEY', fetchImpl })
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.code).toBe('network_error')
  })
})
