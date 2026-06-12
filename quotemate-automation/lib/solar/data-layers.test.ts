import { describe, it, expect } from 'vitest'
import {
  fetchSolarDataLayers,
  fetchSolarDataLayersWithUrls,
  parseDataLayersResponse,
  parseDataLayersUrls,
} from './data-layers'

const META = { radius: 50, pixelSize: 0.5, view: 'FULL_LAYERS' }

// A trimmed Google Solar dataLayers:get success body.
const OK_BODY = {
  imageryDate: { year: 2024, month: 3, day: 7 },
  imageryProcessedDate: { year: 2024, month: 4, day: 1 },
  dsmUrl: 'https://solar.googleapis.com/v1/geoTiff:get?id=dsm',
  rgbUrl: 'https://solar.googleapis.com/v1/geoTiff:get?id=rgb',
  maskUrl: 'https://solar.googleapis.com/v1/geoTiff:get?id=mask',
  annualFluxUrl: 'https://solar.googleapis.com/v1/geoTiff:get?id=annual',
  monthlyFluxUrl: 'https://solar.googleapis.com/v1/geoTiff:get?id=monthly',
  hourlyShadeUrls: Array.from({ length: 12 }, (_, i) => `https://x/${i}`),
  imageryQuality: 'HIGH',
}

describe('parseDataLayersResponse', () => {
  it('maps a full body onto an available summary (no GeoTIFF URLs persisted)', () => {
    const s = parseDataLayersResponse(OK_BODY, META)
    expect(s.status).toBe('available')
    expect(s.imagery_quality).toBe('HIGH')
    expect(s.imagery_date).toBe('2024-03-07')
    expect(s.imagery_processed_date).toBe('2024-04-01')
    expect(s.layers).toEqual({
      dsm: true,
      rgb: true,
      mask: true,
      annual_flux: true,
      monthly_flux: true,
      hourly_shade_months: 12,
    })
    expect(s.radius_meters).toBe(50)
    expect(s.pixel_size_meters).toBe(0.5)
    expect(s.view).toBe('FULL_LAYERS')
    // The summary must not leak any signed GeoTIFF URLs.
    expect(JSON.stringify(s)).not.toContain('geoTiff')
  })

  it('records absent layers as false and missing dates as null', () => {
    const s = parseDataLayersResponse({ imageryQuality: 'MEDIUM' }, META)
    expect(s.status).toBe('available')
    expect(s.imagery_quality).toBe('MEDIUM')
    expect(s.imagery_date).toBeNull()
    expect(s.layers.dsm).toBe(false)
    expect(s.layers.hourly_shade_months).toBe(0)
  })

  it('returns unavailable on a non-object body', () => {
    const s = parseDataLayersResponse(null, META)
    expect(s.status).toBe('unavailable')
    expect(s.detail).toBeTruthy()
  })
})

describe('fetchSolarDataLayers', () => {
  it('skips (no fetch) when the key is missing', async () => {
    let called = false
    const fetchImpl = async () => {
      called = true
      return new Response('{}', { status: 200 })
    }
    const s = await fetchSolarDataLayers(
      { lat: -33.8, lng: 151.2 },
      { apiKey: undefined, fetchImpl },
    )
    expect(called).toBe(false)
    expect(s.status).toBe('skipped')
  })

  it('fetches and parses an available summary', async () => {
    let calledUrl = ''
    const fetchImpl = async (u: RequestInfo | URL) => {
      calledUrl = String(u)
      return new Response(JSON.stringify(OK_BODY), { status: 200 })
    }
    const s = await fetchSolarDataLayers(
      { lat: -33.8688, lng: 151.2093 },
      { apiKey: 'KEY', fetchImpl },
    )
    expect(calledUrl).toContain('location.latitude=-33.8688')
    expect(calledUrl).toContain('radiusMeters=50')
    expect(calledUrl).toContain('key=KEY')
    expect(s.status).toBe('available')
    expect(s.imagery_quality).toBe('HIGH')
  })

  it('returns unavailable on a non-2xx response', async () => {
    const fetchImpl = async () => new Response('nope', { status: 500 })
    const s = await fetchSolarDataLayers(
      { lat: 1, lng: 2 },
      { apiKey: 'KEY', fetchImpl },
    )
    expect(s.status).toBe('unavailable')
    expect(s.detail).toContain('500')
  })

  it('returns unavailable on a network error (never throws)', async () => {
    const fetchImpl = async () => {
      throw new Error('boom')
    }
    const s = await fetchSolarDataLayers(
      { lat: 1, lng: 2 },
      { apiKey: 'KEY', fetchImpl },
    )
    expect(s.status).toBe('unavailable')
  })
})

describe('parseDataLayersUrls', () => {
  it('extracts every GeoTIFF URL from a full body', () => {
    const u = parseDataLayersUrls(OK_BODY)
    expect(u.dsm).toContain('id=dsm')
    expect(u.rgb).toContain('id=rgb')
    expect(u.mask).toContain('id=mask')
    expect(u.annual_flux).toContain('id=annual')
    expect(u.monthly_flux).toContain('id=monthly')
    expect(u.hourly_shade.length).toBe(12)
  })

  it('nulls missing layers and tolerates junk', () => {
    const u = parseDataLayersUrls({ maskUrl: '', hourlyShadeUrls: [1, null, 'https://ok'] })
    expect(u.mask).toBeNull()
    expect(u.dsm).toBeNull()
    expect(u.hourly_shade).toEqual(['https://ok'])
    expect(parseDataLayersUrls(null).annual_flux).toBeNull()
  })
})

describe('fetchSolarDataLayersWithUrls', () => {
  it('returns the summary AND the in-memory URLs on success', async () => {
    const fetchImpl = async () => new Response(JSON.stringify(OK_BODY), { status: 200 })
    const { summary, urls } = await fetchSolarDataLayersWithUrls(
      { lat: -33.8688, lng: 151.2093 },
      { apiKey: 'KEY', fetchImpl },
    )
    expect(summary.status).toBe('available')
    expect(urls?.annual_flux).toContain('id=annual')
    // The PERSISTED summary still never carries the signed URLs.
    expect(JSON.stringify(summary)).not.toContain('geoTiff')
  })

  it('returns null URLs on skip / failure', async () => {
    const noKey = await fetchSolarDataLayersWithUrls(
      { lat: 1, lng: 2 },
      { apiKey: undefined },
    )
    expect(noKey.summary.status).toBe('skipped')
    expect(noKey.urls).toBeNull()

    const failed = await fetchSolarDataLayersWithUrls(
      { lat: 1, lng: 2 },
      { apiKey: 'KEY', fetchImpl: async () => new Response('x', { status: 500 }) },
    )
    expect(failed.summary.status).toBe('unavailable')
    expect(failed.urls).toBeNull()
  })
})
