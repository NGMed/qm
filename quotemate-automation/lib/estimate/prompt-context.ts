// Render context for the estimator prompt templates (admin bulk loader —
// docs/admin-bulk-loader-spec.md §6.1).
//
// The trade_prompts.estimator_system_prompt template is rendered against
// this context. It computes every {{placeholder}} the electrical and
// plumbing templates reference, INCLUDING the derived values their source
// modules computed inline (`call_out_minimum + hourly_rate`, the
// emergency-callout multiplier, the markup factor). The {{markup N}} helper
// reads `default_markup_pct` straight from this context.
//
// A new trade's template references whatever subset of these it needs;
// extra keys are harmless (the engine only errors on a MISSING placeholder).

import type { TemplateContext } from '@/lib/prompt-template/render'

export type EstimatorPricingBook = {
  hourly_rate: number
  call_out_minimum: number
  apprentice_rate: number
  /** Premium-tier tradie rate. Optional — when set, surfaced in the prompt
   *  so Opus can use it for complex BEST-tier labour. Pre-2026-05-25 this
   *  was accepted by the validator but never shown to Opus, so it never
   *  surfaced in quotes. */
  senior_rate?: number | null
  default_markup_pct: number
  risk_buffer_pct: number
  /** Multiplier on hourly_rate + call_out_minimum for after-hours / emergency
   *  jobs. Defaults to 1.5 when null/unset (pre-2026-05-25 behaviour was a
   *  hardcoded 1.5 here; the tradie's configured value was silently ignored). */
  after_hours_multiplier?: number | null
  min_labour_hours?: number | null
  gst_registered: boolean
  licence_type: string | null
  licence_state: string | null
}

// Default minimum labour hours per trade — mirrors the `?? N` fallback in
// electrical-prompt.ts (2) and plumbing-prompt.ts (1.5). A pricing_book row
// with a NULL min_labour_hours falls back to its trade default.
const MIN_LABOUR_FALLBACK: Record<string, number> = {
  electrical: 2,
  plumbing: 1.5,
}

const AFTER_HOURS_FALLBACK = 1.5

export function buildEstimatorContext(
  trade: string,
  book: EstimatorPricingBook,
): TemplateContext {
  const minLabour = book.min_labour_hours ?? MIN_LABOUR_FALLBACK[trade] ?? 2
  // P-1 — replaces a previously hardcoded `1.5` for callout_emergency. The
  // tradie's configured `after_hours_multiplier` now flows through; null/unset
  // falls back to 1.5 so existing tenants without the column behave unchanged.
  const afterHoursMx = book.after_hours_multiplier ?? AFTER_HOURS_FALLBACK
  return {
    hourly_rate: book.hourly_rate,
    call_out_minimum: book.call_out_minimum,
    apprentice_rate: book.apprentice_rate,
    // P-2 — surfaced in templates so Opus can reference it. The prompts show
    // a "(not configured)" line when null so the template doesn't render
    // a misleading "$null".
    senior_rate: book.senior_rate ?? '(not configured)',
    default_markup_pct: book.default_markup_pct,
    risk_buffer_pct: book.risk_buffer_pct,
    after_hours_multiplier: afterHoursMx,
    min_labour_hours: minLabour,
    gst_registered: book.gst_registered,
    licence_type: book.licence_type ?? '(unset)',
    licence_state: book.licence_state ?? '(unset)',
    // Derived — these were inline expressions in the source prompt modules.
    callout_plus_hourly: book.call_out_minimum + book.hourly_rate,
    callout_emergency: Math.round(book.call_out_minimum * afterHoursMx),
    after_hours_hourly: Math.round(book.hourly_rate * afterHoursMx),
    markup_factor: (1 + book.default_markup_pct / 100).toFixed(2),
  }
}
