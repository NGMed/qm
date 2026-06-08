// ════════════════════════════════════════════════════════════════════
// Solar — manual-roof fallback (spec §3, §7).
//
// When an address is uncovered (no Google imagery / 404 / LOW quality) we
// NEVER lose the lead. The customer declares 2–3 facts — dominant roof
// direction, a rough size bucket and storeys — and we synthesise the SAME
// SolarRoofFacts shape that roof.ts produces from Google, differing only
// in source='manual' and a wider confidence band downstream.
//
// The area→panels heuristic is deliberately conservative: ~1.95 m² of
// roof per panel (a 1.879 × 1.045 m panel + setbacks/obstruction discount
// baked into the size buckets). DC yield is a flat CEC-ish 1400 kWh/kW/yr
// benchmark so sizing/production have a real config to pick from.
//
// PURE — no I/O, fully unit-testable.
// ════════════════════════════════════════════════════════════════════

import type {
  SolarManualRoofInput,
  SolarRoofFacts,
  SolarPanelConfig,
  SolarConfig,
} from './types'

type ManualFallbackConfig = Pick<
  SolarConfig,
  'default_panel_capacity_watts' | 'manual_benchmark_kwh_per_kw' | 'area_per_panel_m2'
>

/** Declared size bucket → usable (panel-placeable) roof area, m².
 *  Already discounted for obstructions/setbacks — these are NET areas. */
export const MANUAL_AREA_M2: Record<SolarManualRoofInput['roof_size'], number> = {
  small: 45,
  medium: 90,
  large: 150,
}

/** Roof area consumed by one panel incl. setbacks, m². */
const AREA_PER_PANEL_M2 = 1.95
/** Per-panel DC rating assumed on the manual path, W. */
const MANUAL_PANEL_CAPACITY_WATTS = 400
/** Conservative DC specific yield, kWh per kW DC per year. */
const MANUAL_BENCHMARK_KWH_PER_KW = 1400

export function buildManualRoofFacts(
  input: SolarManualRoofInput,
  config?: ManualFallbackConfig,
): SolarRoofFacts {
  const usable_area_m2 = MANUAL_AREA_M2[input.roof_size]

  // Guard: a 0 or non-finite panel capacity would produce a zero-kW system
  // silently — fall back to the module default so the estimate is always valid.
  const panel_capacity_watts =
    config?.default_panel_capacity_watts != null &&
    config.default_panel_capacity_watts > 0
      ? config.default_panel_capacity_watts
      : MANUAL_PANEL_CAPACITY_WATTS

  // Guard: a 0 or non-finite benchmark would produce 0 kWh/yr silently —
  // fall back to the module default so the estimate is always valid.
  const benchmark_kwh_per_kw =
    config?.manual_benchmark_kwh_per_kw != null &&
    config.manual_benchmark_kwh_per_kw > 0
      ? config.manual_benchmark_kwh_per_kw
      : MANUAL_BENCHMARK_KWH_PER_KW

  // Read area_per_panel_m2 from config so a panel-size model-year change is
  // config-driven; fall back to the module constant when absent or invalid.
  const area_per_panel_m2 =
    config?.area_per_panel_m2 != null && config.area_per_panel_m2 > 0
      ? config.area_per_panel_m2
      : AREA_PER_PANEL_M2

  const max_panels_count = Math.max(0, Math.floor(usable_area_m2 / area_per_panel_m2))
  const system_kw_dc = (max_panels_count * panel_capacity_watts) / 1000

  const panel_configs: SolarPanelConfig[] =
    max_panels_count > 0
      ? [
          {
            panels_count: max_panels_count,
            yearly_energy_dc_kwh: round1(system_kw_dc * benchmark_kwh_per_kw),
          },
        ]
      : []

  return {
    source: 'manual',
    usable_area_m2,
    planes: [],
    segment_count: 0,
    primary_orientation: input.orientation,
    mean_pitch_degrees: null,
    max_panels_count,
    panel_capacity_watts,
    panel_configs,
    storeys: input.storeys,
    polygon_geojson: null,
    imagery_quality: null,
    imagery_date: null,
  }
}

function round1(n: number): number {
  if (!Number.isFinite(n)) return 0
  return Math.round(n * 10) / 10
}

export const __test_only__ = {
  AREA_PER_PANEL_M2,
  MANUAL_PANEL_CAPACITY_WATTS,
  MANUAL_BENCHMARK_KWH_PER_KW,
}
