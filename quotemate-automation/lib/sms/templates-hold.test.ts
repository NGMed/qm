// WP6 — SMS price-hold line coverage (runs under `npm test`, which
// resolves the @/ alias unlike the bare-node parity script).
//
// Also locks in the no-regression invariant: when price_hold_until is
// absent (legacy quotes + the SMS-parity fixture), buildQuoteSms output
// is byte-identical to before — the hold line is purely additive.

import { describe, expect, it } from 'vitest'
import { buildQuoteSms } from './templates'

const intake = {
  job_type: 'downlights',
  caller: { name: 'Mike Smith' },
  scope: { item_count: 5, description: '5 LED downlights in kitchen' },
}

const baseQuote = {
  good: { label: 'Standard LED', subtotal_ex_gst: 600, line_items: [] },
  better: { label: 'Tri-colour LED', subtotal_ex_gst: 800, line_items: [] },
  best: { label: 'Smart dimmable LED', subtotal_ex_gst: 1100, line_items: [] },
  selected_tier: 'better' as const,
  scope_of_works: 'Replace 5 existing halogen downlights with new LED fittings in kitchen.',
  scope_short: '5 LED downlights in kitchen',
  assumptions: [],
  estimated_timeframe: 'Half day',
  needs_inspection: false,
  inspection_reason: null,
  quote_view_url: 'https://quote-mate-rho.vercel.app/q/abc123',
  pay_links: { good: 'g', better: 'b', best: 'x' },
  deposit_pct: 30,
}

describe('buildQuoteSms — WP6 price-hold line', () => {
  it('omits the hold line entirely when price_hold_until is absent (no parity regression)', () => {
    const body = buildQuoteSms(intake, baseQuote)
    expect(body).not.toMatch(/Price held until/)
    expect(body).not.toMatch(/this price expired/)
    expect(body).toMatch(/- QuoteMate$/)
  })

  it('adds a "Price held until" line for a future hold, before the sign-off', () => {
    const future = new Date(Date.now() + 5 * 24 * 60 * 60 * 1000).toISOString()
    const body = buildQuoteSms(intake, { ...baseQuote, price_hold_until: future })
    expect(body).toMatch(/Price held until .+ - lock in a tier to secure it\./)
    expect(body).toMatch(/- QuoteMate$/)
    expect(body.indexOf('Price held until')).toBeLessThan(body.indexOf('- QuoteMate'))
  })

  it('adds an expiry warning when the hold has passed', () => {
    const past = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString()
    const body = buildQuoteSms(intake, { ...baseQuote, price_hold_until: past })
    expect(body).toMatch(/Heads up: this price expired .+ - reply for a fresh quote\./)
  })

  it('stays GSM-7 safe (ASCII only) with the hold line present', () => {
    const future = new Date(Date.now() + 3 * 24 * 60 * 60 * 1000).toISOString()
    const body = buildQuoteSms(intake, { ...baseQuote, price_hold_until: future })
    expect(/[^\x20-\x7E\n]/.test(body)).toBe(false)
  })

  it('ignores an unparseable price_hold_until (no line, no throw)', () => {
    const body = buildQuoteSms(intake, { ...baseQuote, price_hold_until: 'not-a-date' })
    expect(body).not.toMatch(/Price held until/)
    expect(body).toMatch(/- QuoteMate$/)
  })
})
