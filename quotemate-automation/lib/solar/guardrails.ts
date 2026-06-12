// ════════════════════════════════════════════════════════════════════
// Solar — deterministic output check (spec §7).
//
// Solar's analogue of the strict-grounding validator. Every published
// estimate must satisfy: net = gross − STC, gross within sane $/kW
// bounds, payback within years bounds, AC/kW within ±35% of the CEC
// benchmark. Any violation appends a human string to guardrail_flags;
// flagged estimates route to tradie review and NEVER publish silently.
//
// PURE — no I/O. Fully unit-testable.
// ════════════════════════════════════════════════════════════════════

import type { SolarPriceTier, SolarEconomicsTier, SolarProductionResult } from './types'

/** Allowed rounding drift between net and (gross − rebate), in dollars. */
const NET_IDENTITY_TOLERANCE_AUD = 0.011

/**
 * PURE — verify net_ex_gst === gross_ex_gst − stc.rebate_aud for one tier.
 * Returns [] when the identity holds (within a 1-cent tolerance), or a
 * one-element array describing the breach.
 */
export function checkNetIdentity(tier: SolarPriceTier): string[] {
  const expectedNet = tier.gross_ex_gst - tier.stc.rebate_aud
  const drift = Math.abs(tier.net_ex_gst - expectedNet)
  if (drift <= NET_IDENTITY_TOLERANCE_AUD) return []
  return [
    `${tier.tier}: net price ($${tier.net_ex_gst.toFixed(2)}) does not equal ` +
      `gross − STC ($${tier.gross_ex_gst.toFixed(2)} − $${tier.stc.rebate_aud.toFixed(2)} ` +
      `= $${expectedNet.toFixed(2)}).`,
  ]
}

// ── Sane-bounds constants (spec §7) ─────────────────────────────────
const GROSS_PER_KW_MIN_AUD = 700
const GROSS_PER_KW_MAX_AUD = 1800
const PAYBACK_YEARS_MIN = 2
const PAYBACK_YEARS_MAX = 12
const CEC_BENCHMARK_TOLERANCE = 0.35

/**
 * PURE — gross $/kW DC must sit in $700–$1,800 (spec §7). Skips the
 * check for zero-priced tiers (which never publish anyway).
 */
export function checkGrossPerKwBounds(tier: SolarPriceTier): string[] {
  if (tier.system_kw_dc <= 0 || tier.gross_ex_gst <= 0) return []
  const perKw = tier.gross_ex_gst / tier.system_kw_dc
  if (perKw < GROSS_PER_KW_MIN_AUD || perKw > GROSS_PER_KW_MAX_AUD) {
    return [
      `${tier.tier}: gross price is $${perKw.toFixed(0)}/kW DC, outside the ` +
        `$${GROSS_PER_KW_MIN_AUD}–$${GROSS_PER_KW_MAX_AUD} $/kW sanity band.`,
    ]
  }
  return []
}

/**
 * PURE — the whole payback band must sit inside 2–12 years (spec §7).
 * A sub-2-year payback is implausibly good; over 12 years is implausibly
 * poor for an AU residential system.
 */
export function checkPaybackBounds(econ: SolarEconomicsTier): string[] {
  const { payback_years_low: lo, payback_years_high: hi } = econ
  if (lo === null || hi === null) return []
  if (lo < PAYBACK_YEARS_MIN || hi > PAYBACK_YEARS_MAX) {
    return [
      `${econ.tier}: payback band ${lo.toFixed(1)}–` +
        `${hi.toFixed(1)} yrs falls outside the ` +
        `${PAYBACK_YEARS_MIN}–${PAYBACK_YEARS_MAX} year sanity band.`,
    ]
  }
  return []
}

/**
 * PURE — AC production per kW must sit within ±35% of the CEC city
 * benchmark (spec §7). Catches a runaway derate or wrong-zone insolation.
 */
export function checkCecBenchmark(prod: SolarProductionResult): string[] {
  if (prod.system_kw_dc <= 0 || prod.cec_benchmark_kwh_per_kw <= 0) return []
  const acPerKw = prod.annual_kwh_ac / prod.system_kw_dc
  const lo = prod.cec_benchmark_kwh_per_kw * (1 - CEC_BENCHMARK_TOLERANCE)
  const hi = prod.cec_benchmark_kwh_per_kw * (1 + CEC_BENCHMARK_TOLERANCE)
  if (acPerKw < lo || acPerKw > hi) {
    return [
      `${prod.system_kw_dc} kW DC: production is ${acPerKw.toFixed(0)} kWh/kW/yr, ` +
        `outside ±${(CEC_BENCHMARK_TOLERANCE * 100).toFixed(0)}% of the CEC ` +
        `benchmark (${prod.cec_benchmark_kwh_per_kw} kWh/kW/yr).`,
    ]
  }
  return []
}

import type { SolarEstimate, SolarCoverageFailureCode, SolarRoofFacts } from './types'

// ── Roof-area consistency cross-check (premium quote §4.1) ───────────

/** Relative divergence between summed segment areas and Google's
 *  wholeRoofStats area that triggers the logged cross-check. */
const ROOF_AREA_MISMATCH_TOLERANCE = 0.15

/**
 * PURE — compare our summed segment areas against Google's own
 * wholeRoofStats.areaMeters2. Returns [] when consistent (or when the
 * whole-roof figure is absent), else a one-element human-readable note.
 *
 * VALIDATION ONLY — deliberately NOT wired into runSolarGuardrails: a
 * guardrail flag blocks tradie confirmation until a clean re-draft, but
 * an area mismatch is data-driven and a re-draft cannot clear it. The
 * orchestrator logs this instead (spec §4.1 "logged cross-check",
 * review-forcing-not-blocking).
 */
export function checkRoofAreaConsistency(roof: SolarRoofFacts): string[] {
  const whole = roof.whole_roof_area_m2
  if (whole == null || !(whole > 0)) return []
  const sum = roof.usable_area_m2
  const divergence = Math.abs(sum - whole) / whole
  if (divergence <= ROOF_AREA_MISMATCH_TOLERANCE) return []
  return [
    `roof_area_mismatch: segment areas sum to ${sum.toFixed(1)} m² vs Google's ` +
      `whole-roof ${whole.toFixed(1)} m² (${(divergence * 100).toFixed(0)}% apart) — ` +
      'check the roof model before relying on the layout.',
  ]
}

/**
 * PURE — a priced tier whose STC zone never resolved (rating 0 while the
 * SRES still deems > 0 years) is being quoted WITHOUT the rebate the
 * customer is legally entitled to — they would overpay by the full STC
 * value. This used to fail silently (the 670 London Road, Chandler 4154
 * gap); now it flags for tradie review until the zone table/ranges are
 * extended and the estimate re-drafted.
 */
export function checkStcZoneResolved(tier: SolarPriceTier): string[] {
  if (tier.stc.deeming_years <= 0) return [] // SRES ended — 0 certs is correct
  if (tier.stc.zone_rating > 0) return []
  return [
    `stc_zone_missing:${tier.tier}: no STC zone rating resolved for this postcode — ` +
      'the rebate was not subtracted, so the customer would overpay. ' +
      'Extend the STC zone table and re-draft.',
  ]
}

/**
 * PURE — run every deterministic output check across an entire
 * SolarEstimate and return the flat list of human-readable breaches
 * (spec §7). An empty array means the estimate is clean and may publish
 * once the tradie confirms; a non-empty array MUST block silent publish
 * and surface to the tradie. This is the value written to
 * SolarEstimate.guardrail_flags.
 */
export function runSolarGuardrails(estimate: SolarEstimate): string[] {
  const flags: string[] = []
  for (const tier of estimate.price.tiers) {
    flags.push(...checkNetIdentity(tier))
    flags.push(...checkGrossPerKwBounds(tier))
    flags.push(...checkStcZoneResolved(tier))
  }
  for (const econ of estimate.economics.tiers) {
    flags.push(...checkPaybackBounds(econ))
  }
  for (const prod of estimate.production) {
    flags.push(...checkCecBenchmark(prod))
  }
  return flags
}

/** The set of failure codes that are TRANSIENT API/quota problems (not
 *  genuine coverage outcomes). Only these trigger the "estimate shortly"
 *  fallback rather than the normal uncovered → manual-ask branch. */
const API_FAILURE_CODES: ReadonlySet<SolarCoverageFailureCode> = new Set([
  'provider_unavailable',
  'provider_rate_limited',
  'provider_quota_exhausted',
  'provider_invalid_response',
])

export type ApiFailureFallback = {
  /** True when we should branch to the manual-roof path despite a covered
   *  address (because the provider, not the roof, failed). */
  useManualFallback: boolean
  /** Customer-facing reassurance; null when not an API failure. */
  customerMessage: string | null
  /** Admin/ops note for quota exhaustion (spec §7 daily-quota cap); null
   *  for non-quota failures. */
  quotaNote: string | null
}

/**
 * PURE — map a coverage failure code to the API-failure fallback
 * decision (spec §7). Provider/quota failures → manual path + a graceful
 * "estimate shortly" message; quota exhaustion additionally surfaces a
 * daily-quota note so ops knows the GCP cap bound (cost guardrail).
 * Genuine coverage outcomes (no building, outside coverage) return
 * useManualFallback:false — they take the normal uncovered branch.
 */
export function apiFailureFallback(
  code: SolarCoverageFailureCode,
): ApiFailureFallback {
  if (!API_FAILURE_CODES.has(code)) {
    return { useManualFallback: false, customerMessage: null, quotaNote: null }
  }
  return {
    useManualFallback: true,
    customerMessage:
      'We could not reach our roof-imagery provider just now — we will have your estimate shortly. Answer a couple of quick questions to get an instant indicative figure.',
    quotaNote:
      code === 'provider_quota_exhausted'
        ? 'Solar API daily quota exhausted — requests are capped to cap GCP spend; resets at the daily boundary.'
        : null,
  }
}
