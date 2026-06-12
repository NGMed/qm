// ════════════════════════════════════════════════════════════════════
// Solar — long-horizon financial + environmental math (premium quote
// spec §4.3). Pure, per tier, from the EXISTING deterministic outputs
// (SolarEconomicsTier year-1 savings + SolarPriceTier net price) plus
// config-versioned projection constants:
//
//   savings(y) = year-1 savings × (1 − degradation)^(y−1)
//                                × (1 + escalation)^(y−1)
//
//   • 20-year summary: NPV (discounted at discount_rate_pct), total
//     ROI % (cumulative ÷ net price), IRR (bisection; null when not
//     bracketable), payback band passthrough.
//   • 25-year cumulative series for the savings chart (§4.2).
//   • Environmental: annual_kwh_ac × carbon factor → tonnes CO₂e/yr,
//     20-year total, tree/km equivalents via cited config constants.
//     Returns null when the factor is null (manual fallback §4.6).
//
// These are MODELLED PROJECTIONS layered over grounded year-1 figures —
// the engine's prices and savings stay untouched (engine = source of
// truth). Compliance copy (SOLAR_PROJECTION_COPY) must accompany every
// rendering.
//
// PURE — no I/O, fully unit-testable.
// ════════════════════════════════════════════════════════════════════

import type { SolarConfig, SolarEconomicsTier, SolarPriceTier } from './types'
import { roundTo } from './math'

/** Aggregates horizon (Pylon-style "20-year financial summary"). */
export const SUMMARY_HORIZON_YEARS = 20
/** Chart series horizon (spec §4.2 cumulative savings line). */
export const CHART_HORIZON_YEARS = 25

const DEFAULT_ESCALATION = 0.03
const DEFAULT_DISCOUNT_RATE = 0.05
const DEFAULT_DEGRADATION = 0.005

export type SolarYearProjection = {
  /** 1-based year of operation. */
  year: number
  /** $ saved in this year (degradation + escalation applied). */
  savings_aud: number
  /** Running total through this year. */
  cumulative_aud: number
}

export type SolarFinancialSummary = {
  tier: 'good' | 'better' | 'best'
  /** Year-by-year projection over CHART_HORIZON_YEARS (25). */
  years: SolarYearProjection[]
  /** Cumulative savings at the 20-year mark. */
  total_savings_20yr_aud: number
  /** NPV of (−net price, savings…) over 20 years at the discount rate. */
  npv_aud: number
  /** total 20-yr savings ÷ net price, as a percentage. */
  total_roi_pct: number
  /** Internal rate of return over 20 years, %. Null when unbracketable. */
  irr_pct: number | null
  /** Payback band passthrough from the deterministic engine. */
  payback_years_low: number | null
  payback_years_high: number | null
  /** The constants applied — surfaced in the assumptions table. */
  assumptions: {
    escalation_pct_per_year: number
    discount_rate_pct: number
    degradation_pct_per_year: number
  }
}

type ProjectionConfig = Pick<
  SolarConfig,
  'price_escalation_pct_per_year' | 'discount_rate_pct' | 'degradation_pct_per_year'
>

function resolveRates(config: ProjectionConfig) {
  const esc = guardedFraction(config.price_escalation_pct_per_year, DEFAULT_ESCALATION)
  const disc = guardedFraction(config.discount_rate_pct, DEFAULT_DISCOUNT_RATE)
  const deg = guardedFraction(config.degradation_pct_per_year, DEFAULT_DEGRADATION)
  return { esc, disc, deg }
}

/**
 * PURE — the full financial summary for one tier. Returns null when the
 * tier has no positive year-1 savings or no positive net price (an
 * inspection-routed or degenerate tier — sections are then omitted).
 */
export function buildSolarFinancialSummary(args: {
  econ: SolarEconomicsTier
  price: SolarPriceTier
  config: ProjectionConfig
}): SolarFinancialSummary | null {
  const { econ, price, config } = args
  const year1 = econ.annual_savings_aud
  const net = price.net_ex_gst
  if (!Number.isFinite(year1) || year1 <= 0) return null
  if (!Number.isFinite(net) || net <= 0) return null

  const { esc, disc, deg } = resolveRates(config)

  const years: SolarYearProjection[] = []
  let cumulative = 0
  for (let y = 1; y <= CHART_HORIZON_YEARS; y++) {
    const savings = year1 * (1 - deg) ** (y - 1) * (1 + esc) ** (y - 1)
    cumulative += savings
    years.push({
      year: y,
      savings_aud: roundTo(savings, 2),
      cumulative_aud: roundTo(cumulative, 2),
    })
  }

  const total20 = years[SUMMARY_HORIZON_YEARS - 1].cumulative_aud

  // Cashflow: −net at year 0, then each year's savings through year 20.
  const cashflows = [
    -net,
    ...years.slice(0, SUMMARY_HORIZON_YEARS).map((p) => p.savings_aud),
  ]
  const npv_aud = roundTo(npv(disc, cashflows), 2)
  // A deeply negative IRR is mathematically valid (savings never repay
  // the cost) but meaningless on a customer proposal — suppress it and
  // let the negative NPV carry that story instead.
  const irrRaw = solveIrr(cashflows)
  const irr = irrRaw !== null && irrRaw > 0 ? irrRaw : null

  return {
    tier: econ.tier,
    years,
    total_savings_20yr_aud: total20,
    npv_aud,
    total_roi_pct: roundTo((total20 / net) * 100, 1),
    irr_pct: irr === null ? null : roundTo(irr * 100, 1),
    payback_years_low: econ.payback_years_low,
    payback_years_high: econ.payback_years_high,
    assumptions: {
      escalation_pct_per_year: esc,
      discount_rate_pct: disc,
      degradation_pct_per_year: deg,
    },
  }
}

/** PURE — net present value of cashflows (index = year). */
export function npv(rate: number, cashflows: number[]): number {
  return cashflows.reduce((acc, cf, year) => acc + cf / (1 + rate) ** year, 0)
}

/**
 * PURE — IRR by bisection on npv(rate)=0 over (−0.95, 10). Null when
 * the endpoints do not bracket a sign change (e.g. savings never repay
 * the cost, or pathological cashflows).
 */
export function solveIrr(cashflows: number[]): number | null {
  let lo = -0.95
  let hi = 10
  let fLo = npv(lo, cashflows)
  const fHi = npv(hi, cashflows)
  if (!Number.isFinite(fLo) || !Number.isFinite(fHi)) return null
  if (fLo * fHi > 0) return null
  for (let i = 0; i < 200; i++) {
    const mid = (lo + hi) / 2
    const fMid = npv(mid, cashflows)
    if (Math.abs(fMid) < 1e-7 || hi - lo < 1e-9) return mid
    if (fLo * fMid <= 0) {
      hi = mid
    } else {
      lo = mid
      fLo = fMid
    }
  }
  return (lo + hi) / 2
}

// ── Environmental analysis (spec §4.3) ───────────────────────────────

const DEFAULT_TREES_PER_TONNE = 15
const DEFAULT_KM_PER_TONNE = 4000

export type SolarEnvironmentalImpact = {
  /** Tonnes CO₂e avoided per year of operation. */
  tonnes_co2_per_year: number
  /** Tonnes over the 20-year horizon (degradation applied). */
  tonnes_co2_20yr: number
  /** Equivalent tree-years planted per year (config constant, cited). */
  trees_equiv_per_year: number
  /** Equivalent petrol-car km avoided per year (config constant, cited). */
  km_driven_equiv_per_year: number
  /** The grid factor used, kg CO₂e per MWh. */
  carbon_offset_factor_kg_per_mwh: number
}

/**
 * PURE — environmental impact from the headline tier's production and
 * the Solar API's grid carbon factor. Null when the factor is absent
 * (manual fallback) — the section is omitted (degradation matrix §4.6).
 */
export function buildSolarEnvironmentalImpact(args: {
  annual_kwh_ac: number
  carbon_offset_factor_kg_per_mwh: number | null | undefined
  config: Pick<
    SolarConfig,
    'co2_equiv_trees_per_tonne' | 'co2_equiv_km_driven_per_tonne' | 'degradation_pct_per_year'
  >
}): SolarEnvironmentalImpact | null {
  const factor = args.carbon_offset_factor_kg_per_mwh
  if (factor == null || !Number.isFinite(factor) || factor <= 0) return null
  const ac = args.annual_kwh_ac
  if (!Number.isFinite(ac) || ac <= 0) return null

  // kWh × (kg/MWh) ÷ 1000 = kg → ÷ 1000 = tonnes.
  const tonnesYr = (ac * factor) / 1_000_000

  const deg = guardedFraction(args.config.degradation_pct_per_year, DEFAULT_DEGRADATION)
  let tonnes20 = 0
  for (let y = 1; y <= SUMMARY_HORIZON_YEARS; y++) {
    tonnes20 += tonnesYr * (1 - deg) ** (y - 1)
  }

  const trees =
    args.config.co2_equiv_trees_per_tonne != null &&
    args.config.co2_equiv_trees_per_tonne > 0
      ? args.config.co2_equiv_trees_per_tonne
      : DEFAULT_TREES_PER_TONNE
  const km =
    args.config.co2_equiv_km_driven_per_tonne != null &&
    args.config.co2_equiv_km_driven_per_tonne > 0
      ? args.config.co2_equiv_km_driven_per_tonne
      : DEFAULT_KM_PER_TONNE

  return {
    tonnes_co2_per_year: roundTo(tonnesYr, 2),
    tonnes_co2_20yr: roundTo(tonnes20, 1),
    trees_equiv_per_year: Math.round(tonnesYr * trees),
    km_driven_equiv_per_year: Math.round(tonnesYr * km),
    carbon_offset_factor_kg_per_mwh: factor,
  }
}

// ── helpers ──────────────────────────────────────────────────────────

/** Accept a finite fraction in [0, 1); anything else → fallback. */
function guardedFraction(v: number | undefined, fallback: number): number {
  return v != null && Number.isFinite(v) && v >= 0 && v < 1 ? v : fallback
}
