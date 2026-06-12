// ════════════════════════════════════════════════════════════════════
// Solar — utility-cost personalisation (premium quote spec §4.1, §4.4 §5).
//
// Derives the "Utility costs before / with solar" figures per tier:
//
//   PERSONAL (bill given):  household_annual_kwh = (bill × 4) ÷ retail
//   MODELLED (no bill):     household_annual_kwh = config typical (6000)
//
//   bill_before = household_kwh × retail
//   bill_with   = grid_import_after × retail − export_credit
//     where self-consumed generation is capped at what the household
//     actually uses (a 6 kW array on a tiny bill cannot offset more
//     than the bill), and exports earn the feed-in tariff. A negative
//     "with solar" bill is a genuine credit; consumers clamp for bars.
//
// This module deliberately does NOT touch SolarEconomicsTier — the
// published savings/payback figures stay exactly as the deterministic
// engine computed them (engine = source of truth). Utility costs are a
// presentation-layer derivation over the same persisted inputs, shared
// by the page, the charts, and the PDF, and labelled "modelled on
// typical usage" when no bill exists (degradation matrix §4.6).
//
// PURE — no I/O, fully unit-testable.
// ════════════════════════════════════════════════════════════════════

import type {
  SolarConfig,
  SolarEstimateContext,
  SolarEconomicsResult,
  SolarProductionResult,
} from './types'
import { roundTo } from './math'

/** Fallback when config omits typical_household_kwh_per_year. */
const DEFAULT_TYPICAL_HOUSEHOLD_KWH = 6000

export type SolarUtilityCostTier = {
  tier: 'good' | 'better' | 'best'
  /** kWh/yr of generation the household uses on-site (capped at usage). */
  self_consumed_kwh: number
  /** kWh/yr still imported from the grid after solar. */
  grid_import_kwh: number
  /** kWh/yr exported, earning the feed-in tariff. */
  exported_kwh: number
  /** $/yr electricity bill with this system. Negative = net credit. */
  annual_bill_with_solar_aud: number
  /** Fraction of the before-bill removed by this system (0–1, capped). */
  bill_offset_pct: number
}

export type SolarUtilityCosts = {
  /** 'personal' when derived from the customer's bill; else 'modelled'. */
  source: 'personal' | 'modelled'
  /** Annual household consumption used for the derivation, kWh/yr. */
  household_annual_kwh: number
  /** $/yr electricity bill before solar. */
  annual_bill_before_aud: number
  /** $/quarter before solar (the figure the customer recognises). */
  quarterly_bill_before_aud: number
  tiers: SolarUtilityCostTier[]
}

/**
 * PURE — derive before/with-solar utility costs for every tier. Works on
 * any persisted estimate: pre-premium rows simply lack
 * context.quarterly_bill_aud and resolve to the modelled path.
 */
export function deriveSolarUtilityCosts(args: {
  context: SolarEstimateContext
  economics: SolarEconomicsResult
  production: SolarProductionResult[]
  config: Pick<SolarConfig, 'typical_household_kwh_per_year'>
}): SolarUtilityCosts {
  const { context, economics, production, config } = args

  const retail = economics.assumptions.retail_rate_aud_per_kwh
  const feedIn = economics.assumptions.feed_in_tariff_aud_per_kwh
  const selfPct = economics.assumptions.self_consumption_pct

  const bill = context.quarterly_bill_aud
  const personal =
    typeof bill === 'number' && Number.isFinite(bill) && bill > 0 && retail > 0

  const typical =
    config.typical_household_kwh_per_year != null &&
    Number.isFinite(config.typical_household_kwh_per_year) &&
    config.typical_household_kwh_per_year > 0
      ? config.typical_household_kwh_per_year
      : DEFAULT_TYPICAL_HOUSEHOLD_KWH

  const household_annual_kwh = personal
    ? Math.round((bill * 4) / retail)
    : typical

  const annual_bill_before_aud = roundTo(household_annual_kwh * retail, 2)

  const tiers: SolarUtilityCostTier[] = economics.tiers.map((econ, i) => {
    const ac = production[i]?.annual_kwh_ac ?? 0
    // Self-consumption is the engine's fraction of generation, but a
    // household can never self-consume more than it uses.
    const self_consumed_kwh = Math.min(
      Math.round(ac * selfPct),
      household_annual_kwh,
    )
    const exported_kwh = Math.max(0, ac - self_consumed_kwh)
    const grid_import_kwh = Math.max(0, household_annual_kwh - self_consumed_kwh)

    const annual_bill_with_solar_aud = roundTo(
      grid_import_kwh * retail - exported_kwh * feedIn,
      2,
    )

    const offsetRaw =
      annual_bill_before_aud > 0
        ? (annual_bill_before_aud - annual_bill_with_solar_aud) /
          annual_bill_before_aud
        : 0
    const bill_offset_pct = roundTo(Math.min(1, Math.max(0, offsetRaw)), 3)

    return {
      tier: econ.tier,
      self_consumed_kwh,
      grid_import_kwh,
      exported_kwh,
      annual_bill_with_solar_aud,
      bill_offset_pct,
    }
  })

  return {
    source: personal ? 'personal' : 'modelled',
    household_annual_kwh,
    annual_bill_before_aud,
    quarterly_bill_before_aud: roundTo(annual_bill_before_aud / 4, 2),
    tiers,
  }
}

/** Caption for the utility-cost / financial charts (degradation §4.6). */
export function utilityCostsCaption(source: 'personal' | 'modelled'): string {
  return source === 'personal'
    ? 'Personalised from the quarterly bill you provided.'
    : 'Modelled on typical usage — add your quarterly bill for a personal figure.'
}
