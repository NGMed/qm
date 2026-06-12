// ════════════════════════════════════════════════════════════════════
// Solar — GeoTIFF decode wrapper (full-exploitation build 2026-06-13).
//
// Google Solar dataLayers assets (annual/monthly flux, hourly shade,
// DSM, mask) are GeoTIFF rasters fetched via short-lived geoTiff:get
// URLs. This module decodes raw bytes into a plain SolarRaster shape so
// every downstream analysis (raster-analysis.ts, flux-render.ts) stays
// PURE and testable on plain arrays.
//
// Never throws — returns a result object (codebase contract). Size-caps
// input bytes and output pixels so a hostile/corrupt body can't OOM.
// ════════════════════════════════════════════════════════════════════

import { fromArrayBuffer } from 'geotiff'

/** Raw GeoTIFF bytes cap — Solar rasters at 0.5 m/px, r=50 m are ~KBs. */
const MAX_GEOTIFF_BYTES = 50 * 1024 * 1024
/** Pixel cap per raster (w × h). 2048² is far beyond any sane request. */
const MAX_PIXELS = 2048 * 2048
/** Band cap — hourly shade has 24; nothing legitimate has more. */
const MAX_BANDS = 24

export type SolarRaster = {
  width: number
  height: number
  bands: number
  /** Band-major pixel data: rasters[band][y * width + x]. */
  rasters: Float64Array[]
  /** [west, south, east, north] in the raster's CRS, when present. */
  bbox: [number, number, number, number] | null
  /** GDAL nodata value, when declared (Solar flux uses -9999). */
  no_data_value: number | null
}

export type SolarRasterResult =
  | { ok: true; data: SolarRaster }
  | { ok: false; detail: string }

/**
 * Decode GeoTIFF bytes to a SolarRaster. Reads the FIRST image (Solar
 * layers are single-image files). Tolerant of any band count up to 24.
 */
export async function decodeSolarGeoTiff(bytes: Uint8Array): Promise<SolarRasterResult> {
  if (bytes.byteLength === 0) return { ok: false, detail: 'GeoTIFF body was empty.' }
  if (bytes.byteLength > MAX_GEOTIFF_BYTES) {
    return { ok: false, detail: `GeoTIFF exceeds ${MAX_GEOTIFF_BYTES} bytes.` }
  }
  try {
    const buffer = bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength)
    const tiff = await fromArrayBuffer(buffer as ArrayBuffer)
    const image = await tiff.getImage(0)
    const width = image.getWidth()
    const height = image.getHeight()
    const bands = image.getSamplesPerPixel()
    if (!Number.isFinite(width) || !Number.isFinite(height) || width <= 0 || height <= 0) {
      return { ok: false, detail: 'GeoTIFF carried invalid dimensions.' }
    }
    if (width * height > MAX_PIXELS) {
      return { ok: false, detail: `GeoTIFF exceeds ${MAX_PIXELS} pixels.` }
    }
    if (!Number.isFinite(bands) || bands <= 0 || bands > MAX_BANDS) {
      return { ok: false, detail: `GeoTIFF carried an unsupported band count (${bands}).` }
    }

    const raw = (await image.readRasters({ interleave: false })) as ArrayLike<number>[]
    const rasters: Float64Array[] = []
    for (let b = 0; b < bands; b++) {
      const band = raw[b]
      if (!band || typeof (band as { length?: number }).length !== 'number') {
        return { ok: false, detail: `GeoTIFF band ${b} was unreadable.` }
      }
      rasters.push(Float64Array.from(band as ArrayLike<number>))
    }

    let bbox: [number, number, number, number] | null = null
    try {
      const bb = image.getBoundingBox()
      if (Array.isArray(bb) && bb.length === 4 && bb.every((v) => Number.isFinite(v))) {
        bbox = [bb[0], bb[1], bb[2], bb[3]]
      }
    } catch {
      bbox = null
    }

    let no_data_value: number | null = null
    try {
      const nd = image.getGDALNoData()
      no_data_value = typeof nd === 'number' && Number.isFinite(nd) ? nd : null
    } catch {
      no_data_value = null
    }

    return { ok: true, data: { width, height, bands, rasters, bbox, no_data_value } }
  } catch (e) {
    return {
      ok: false,
      detail: `GeoTIFF decode failed: ${e instanceof Error ? e.message : String(e)}`,
    }
  }
}

export const __test_only__ = { MAX_GEOTIFF_BYTES, MAX_PIXELS, MAX_BANDS }
