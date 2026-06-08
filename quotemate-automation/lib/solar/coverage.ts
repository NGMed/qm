// ════════════════════════════════════════════════════════════════════
// Solar — coverage gate.
//
// Given a resolved lat/lng, ask Google's buildingInsights:findClosest
// whether we have usable roof imagery. MEDIUM is the money-path floor;
// LOW imagery or a 404 means "uncovered" and the orchestrator branches
// to the manual-roof fallback (never a hard fail — spec §7).
//
// Reuses the existing solar-api client (fetchBuildingInsights) verbatim —
// this module only maps its SolarApiResult onto the solar coverage union.
//
// PURE-ish: the one network call is delegated to the injectable client;
// this function adds no I/O of its own and never throws.
// ════════════════════════════════════════════════════════════════════

import { fetchBuildingInsights } from '../roofing/solar-api'
import type { ResolvedSolarOpts } from '../roofing/solar-api'
import type {
  SolarAddressInput,
  LatLng,
  SolarCoverageResult,
  SolarImageryQuality,
} from './types'

/** Imagery qualities good enough for the solar money path. */
const COVERAGE_FLOOR: SolarImageryQuality[] = ['HIGH', 'MEDIUM']

export async function checkSolarCoverage(
  _input: SolarAddressInput,
  location: LatLng,
  opts: ResolvedSolarOpts,
): Promise<SolarCoverageResult> {
  const res = await fetchBuildingInsights(location, opts)

  if (!res.ok) {
    if (res.code === 'no_coverage') {
      return {
        covered: false,
        code: 'no_building_at_address',
        detail: res.detail,
      }
    }
    if (res.code === 'no_key') {
      return {
        covered: false,
        code: 'provider_unavailable',
        detail: res.detail,
      }
    }
    if (res.code === 'network_error') {
      return {
        covered: false,
        code: 'provider_unavailable',
        detail: res.detail,
      }
    }
    if (res.code === 'invalid_response') {
      return {
        covered: false,
        code: 'provider_invalid_response',
        detail: res.detail,
      }
    }
    // http_error
    return {
      covered: false,
      code: 'provider_unavailable',
      detail: res.detail,
    }
  }

  const quality = res.insight.imageryQuality as SolarImageryQuality
  if (!COVERAGE_FLOOR.includes(quality)) {
    return {
      covered: false,
      code: 'imagery_below_floor',
      detail: `Imagery quality ${quality} is below the MEDIUM floor required for an instant solar estimate.`,
    }
  }

  return {
    covered: true,
    location,
    imagery_quality: quality,
    imagery_date: res.insight.imageryDate,
  }
}
