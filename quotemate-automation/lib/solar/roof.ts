// ════════════════════════════════════════════════════════════════════
// Solar — normalise a parsed buildingInsights result into roof facts.
//
// The reused solar-api parser (parseBuildingInsights) extracts segments,
// area-weighted pitch and imagery only — it was written for the roofing
// pitch override. Solar additionally needs maxArrayPanelsCount,
// panelCapacityWatts and the precomputed solarPanelConfigs. Those live in
// solarPotential on the SAME response body, so this module takes the
// parsed SolarRoofInsight PLUS a `raw` handle to that body and reads the
// extra fields directly. The result is the single SolarRoofFacts shape
// the rest of the engine consumes (manual-fallback.ts produces the same
// shape with source='manual').
//
// PURE — no I/O, fully unit-testable.
// ════════════════════════════════════════════════════════════════════

import type { SolarRoofInsight } from '../roofing/solar-api'
import type {
  SolarCoverageResult,
  SolarRoofFacts,
  SolarRoofPlane,
  SolarOrientation,
  SolarPanelConfig,
  SolarImageryQuality,
} from './types'

/** The parsed insight plus the raw response body it came from. */
export type SolarRoofInsightWithRaw = SolarRoofInsight & { raw: unknown }

const DEFAULT_PANEL_CAPACITY_WATTS = 400

export function normaliseSolarRoofFacts(
  insights: SolarRoofInsightWithRaw,
  coverage: Extract<SolarCoverageResult, { covered: true }>,
): SolarRoofFacts {
  const planes: SolarRoofPlane[] = insights.segments.map((s) => ({
    pitch_degrees: round1(s.pitchDegrees),
    azimuth_degrees: s.azimuthDegrees,
    area_m2: round1(s.areaMeters2),
    orientation: azimuthToOrientation(s.azimuthDegrees, s.pitchDegrees),
  }))

  const usable_area_m2 = round1(
    planes.reduce((acc, p) => acc + p.area_m2, 0),
  )

  // Primary orientation = the orientation of the single largest plane.
  const largest = planes.reduce<SolarRoofPlane | null>(
    (best, p) => (best === null || p.area_m2 > best.area_m2 ? p : best),
    null,
  )
  const primary_orientation: SolarOrientation = largest?.orientation ?? 'unknown'

  const sp = readSolarPotential(insights.raw)
  const max_panels_count =
    numberOr(sp.maxArrayPanelsCount, 0) > 0
      ? Math.floor(numberOr(sp.maxArrayPanelsCount, 0))
      : 0
  const panel_capacity_watts = numberOr(
    sp.panelCapacityWatts,
    DEFAULT_PANEL_CAPACITY_WATTS,
  )

  const panel_configs: SolarPanelConfig[] = Array.isArray(sp.solarPanelConfigs)
    ? sp.solarPanelConfigs
        .map((c): SolarPanelConfig | null => {
          if (!c || typeof c !== 'object') return null
          const obj = c as Record<string, unknown>
          const panels = numberOr(obj.panelsCount, NaN)
          const dc = numberOr(obj.yearlyEnergyDcKwh, NaN)
          if (!Number.isFinite(panels) || !Number.isFinite(dc)) return null
          return {
            panels_count: Math.floor(panels),
            yearly_energy_dc_kwh: round1(dc),
          }
        })
        .filter((c): c is SolarPanelConfig => c !== null)
    : []

  return {
    source: 'google',
    usable_area_m2,
    planes,
    segment_count: insights.segmentCount,
    primary_orientation,
    mean_pitch_degrees: round1(insights.weightedMeanPitchDegrees),
    max_panels_count,
    panel_capacity_watts,
    panel_configs,
    storeys: null,
    polygon_geojson: null,
    imagery_quality: coverage.imagery_quality as SolarImageryQuality,
    imagery_date: coverage.imagery_date,
  }
}

/** PURE — coarse 8-point orientation from a compass azimuth. Flat roofs
 *  (pitch < 5°) read as 'flat'; a null azimuth reads as 'unknown'. */
export function azimuthToOrientation(
  azimuth: number | null,
  pitchDegrees: number,
): SolarOrientation {
  if (Number.isFinite(pitchDegrees) && pitchDegrees < 5) return 'flat'
  if (azimuth === null || !Number.isFinite(azimuth)) return 'unknown'
  const a = ((azimuth % 360) + 360) % 360
  const buckets: SolarOrientation[] = [
    'north', 'north_east', 'east', 'south_east',
    'south', 'south_west', 'west', 'north_west',
  ]
  // 45°-wide sectors centred on each cardinal/intercardinal point.
  const idx = Math.round(a / 45) % 8
  return buckets[idx]
}

// ── helpers ──────────────────────────────────────────────────────────

function readSolarPotential(raw: unknown): Record<string, unknown> {
  if (!raw || typeof raw !== 'object') return {}
  let b = raw as Record<string, unknown>
  if (!('solarPotential' in b) && b.data && typeof b.data === 'object') {
    b = b.data as Record<string, unknown>
  }
  const sp = b.solarPotential
  return sp && typeof sp === 'object' ? (sp as Record<string, unknown>) : {}
}

function numberOr(v: unknown, fallback: number): number {
  if (typeof v === 'number' && Number.isFinite(v)) return v
  if (typeof v === 'string') {
    const n = Number.parseFloat(v)
    if (Number.isFinite(n)) return n
  }
  return fallback
}

function round1(n: number): number {
  if (!Number.isFinite(n)) return 0
  return Math.round(n * 10) / 10
}

export const __test_only__ = { azimuthToOrientation, round1, DEFAULT_PANEL_CAPACITY_WATTS }
