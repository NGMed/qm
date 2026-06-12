import { describe, it, expect } from 'vitest'
import { writeArrayBuffer } from 'geotiff'
import { decodeSolarGeoTiff } from './geotiff'

/** Build a tiny single-band GeoTIFF via the geotiff library itself. */
async function makeGeoTiff(values: number[], width: number, height: number): Promise<Uint8Array> {
  const buf = (await writeArrayBuffer(values, {
    width,
    height,
    // Minimal geo keys so the writer emits a valid file.
    ModelPixelScale: [0.5, 0.5, 0],
    ModelTiepoint: [0, 0, 0, 151.2, -33.8, 0],
  })) as ArrayBuffer
  return new Uint8Array(buf)
}

describe('decodeSolarGeoTiff', () => {
  it('round-trips a small raster written by the geotiff library', async () => {
    const values = [10, 20, 30, 40, 50, 60]
    const bytes = await makeGeoTiff(values, 3, 2)
    const res = await decodeSolarGeoTiff(bytes)
    expect(res.ok).toBe(true)
    if (!res.ok) return
    expect(res.data.width).toBe(3)
    expect(res.data.height).toBe(2)
    expect(res.data.bands).toBe(1)
    expect(Array.from(res.data.rasters[0])).toEqual(values)
  })

  it('rejects empty bodies', async () => {
    const res = await decodeSolarGeoTiff(new Uint8Array(0))
    expect(res.ok).toBe(false)
  })

  it('rejects non-GeoTIFF bytes without throwing', async () => {
    const res = await decodeSolarGeoTiff(new TextEncoder().encode('not a tiff at all'))
    expect(res.ok).toBe(false)
    if (!res.ok) expect(res.detail).toContain('decode failed')
  })
})
