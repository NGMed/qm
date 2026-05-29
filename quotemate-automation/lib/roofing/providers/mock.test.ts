import { describe, expect, it } from 'vitest'
import { MockRoofingProvider, hash, synthesisePolygon } from './mock'
import { polygonAreaM2 } from './geoscape'

describe('MockRoofingProvider', () => {
  const p = new MockRoofingProvider()

  it('returns ok metrics for any valid address', async () => {
    const r = await p.measure({ address: '1 Test St', postcode: '2000', state: 'NSW' })
    expect(r.ok).toBe(true)
    if (r.ok) {
      expect(r.provider).toBe('mock')
      expect(r.metrics.footprint_m2).toBeGreaterThan(0)
      expect(r.metrics.sloped_area_m2).toBeGreaterThan(r.metrics.footprint_m2)
      expect(['gable', 'hip', 'gable_hip']).toContain(r.metrics.form)
    }
  })

  it('is deterministic — same input → same metrics', async () => {
    const a = await p.measure({ address: '7 Smith St', postcode: '2750', state: 'NSW' })
    const b = await p.measure({ address: '7 Smith St', postcode: '2750', state: 'NSW' })
    expect(a).toEqual(b)
  })

  it('throws on empty address (programmer error)', async () => {
    await expect(
      p.measure({ address: '', postcode: '2000', state: 'NSW' }),
    ).rejects.toThrow(/address is required/)
  })
})

describe('synthesisePolygon', () => {
  it('returns a Polygon with 5 vertices (closed ring)', () => {
    const p = synthesisePolygon(12345, 200)
    expect(p.type).toBe('Polygon')
    expect(p.coordinates[0]).toHaveLength(5)
  })

  it('approximates the declared footprint within 10%', () => {
    const p = synthesisePolygon(12345, 200)
    const area = polygonAreaM2(p)
    expect(area).toBeGreaterThan(180)
    expect(area).toBeLessThan(220)
  })

  it('places different seeds at different positions', () => {
    const a = synthesisePolygon(1, 200)
    const b = synthesisePolygon(99999, 200)
    expect(a.coordinates[0][0]).not.toEqual(b.coordinates[0][0])
  })

  it('stays within ~1km of central Sydney', () => {
    const p = synthesisePolygon(99999, 200)
    const [lng, lat] = p.coordinates[0][0]
    expect(Math.abs(lng - 151.2093)).toBeLessThan(0.015)
    expect(Math.abs(lat - -33.8688)).toBeLessThan(0.015)
  })
})

describe('MockRoofingProvider — polygon', () => {
  const p = new MockRoofingProvider()
  it('includes a polygon_geojson on every measurement', async () => {
    const r = await p.measure({ address: '7 Smith St', postcode: '2750', state: 'NSW' })
    expect(r.ok).toBe(true)
    if (r.ok) {
      expect(r.metrics.polygon_geojson).not.toBeNull()
      expect(r.metrics.polygon_geojson!.type).toBe('Polygon')
    }
  })
})

describe('hash', () => {
  it('returns the same number for the same string', () => {
    expect(hash('abc')).toBe(hash('abc'))
  })
  it('returns a different number for different strings', () => {
    expect(hash('abc')).not.toBe(hash('def'))
  })
  it('is always non-negative', () => {
    expect(hash('whatever-this-is')).toBeGreaterThanOrEqual(0)
  })
})
