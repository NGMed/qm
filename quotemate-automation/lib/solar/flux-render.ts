// ════════════════════════════════════════════════════════════════════
// Solar — PURE annual-flux heatmap rendering (full-exploitation build
// 2026-06-13). Takes a decoded annual-flux band (+ optional roof mask)
// and produces an RGBA PNG: the classic roof "solar potential" image —
// dark/cool where shaded, bright yellow where the roof bakes.
//
// Rendering rules:
//   • Pixels outside the roof mask are fully transparent — the PNG is an
//     OVERLAY layered on the satellite basemap by the quote page.
//   • Flux values are normalised between the masked p2 / p98 percentiles
//     so a couple of sensor outliers can't wash the ramp out.
//   • Nodata / negative values are transparent.
//
// PURE — pixel math only; pngjs encodes the bytes. No I/O.
// ════════════════════════════════════════════════════════════════════

import { PNG } from 'pngjs'
import { maskAt, type RasterBand } from './raster-analysis'

/** Colour ramp stops, cold → hot (RGB). */
const RAMP: Array<[number, number, number]> = [
  [11, 16, 38], // deep navy
  [69, 39, 160], // purple
  [198, 40, 40], // crimson
  [255, 152, 0], // orange
  [255, 245, 157], // pale yellow
]

/** Overlay opacity for roof pixels (0–255). */
const ROOF_ALPHA = 230

export type FluxHeatmapResult = {
  /** Encoded PNG bytes (RGBA, transparent off-roof). */
  png: Uint8Array
  width: number
  height: number
  /** Normalisation bounds used (masked p2/p98), kWh/kW/year. */
  min_flux: number
  max_flux: number
  /** Number of roof pixels rendered. */
  roof_pixels: number
}

/** PURE — ramp lookup for t ∈ [0,1] with linear interpolation. */
export function fluxColor(t: number): [number, number, number] {
  const clamped = Math.min(1, Math.max(0, t))
  const pos = clamped * (RAMP.length - 1)
  const i = Math.min(RAMP.length - 2, Math.floor(pos))
  const f = pos - i
  const a = RAMP[i]
  const b = RAMP[i + 1]
  return [
    Math.round(a[0] + (b[0] - a[0]) * f),
    Math.round(a[1] + (b[1] - a[1]) * f),
    Math.round(a[2] + (b[2] - a[2]) * f),
  ]
}

/**
 * PURE — render the annual flux band to a transparent-background heatmap
 * PNG. Returns null when no roof pixel carries a usable flux value.
 */
export function renderFluxHeatmapPng(
  flux: RasterBand,
  mask: RasterBand | null,
  noDataValue: number | null = null,
): FluxHeatmapResult | null {
  const { width, height } = flux

  // First pass — collect masked values for percentile normalisation.
  const values: number[] = []
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const v = flux.data[y * width + x]
      if (typeof v !== 'number' || !Number.isFinite(v) || v < 0) continue
      if (noDataValue !== null && v === noDataValue) continue
      if (!maskAt(mask, x, y, width, height)) continue
      values.push(v)
    }
  }
  if (values.length === 0) return null

  values.sort((a, b) => a - b)
  const min = values[Math.floor(values.length * 0.02)]
  const max = values[Math.min(values.length - 1, Math.floor(values.length * 0.98))]
  const range = max - min

  const png = new PNG({ width, height })
  let roofPixels = 0
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const idx = (y * width + x) * 4
      const v = flux.data[y * width + x]
      const usable =
        typeof v === 'number' &&
        Number.isFinite(v) &&
        v >= 0 &&
        (noDataValue === null || v !== noDataValue) &&
        maskAt(mask, x, y, width, height)
      if (!usable) {
        png.data[idx + 3] = 0 // transparent
        continue
      }
      const t = range > 0 ? (v - min) / range : 0.5
      const [r, g, b] = fluxColor(t)
      png.data[idx] = r
      png.data[idx + 1] = g
      png.data[idx + 2] = b
      png.data[idx + 3] = ROOF_ALPHA
      roofPixels++
    }
  }
  if (roofPixels === 0) return null

  return {
    png: new Uint8Array(PNG.sync.write(png)),
    width,
    height,
    min_flux: Math.round(min * 10) / 10,
    max_flux: Math.round(max * 10) / 10,
    roof_pixels: roofPixels,
  }
}

export const __test_only__ = { RAMP, ROOF_ALPHA }
