// Self-contained HTML for the customer SOLAR quote PDF, rendered by
// Gotenberg (lib/pdf/gotenberg.ts). Brings solar to PDF parity with the
// electrical/plumbing quote report (lib/quote/report-html.ts) and the
// roofing report: same print-friendly light theme (mono eyebrows, orange
// accent, uppercase display headings, inline styles).
//
// Money convention: SolarPriceTier already carries inc-GST figures
// (net_inc_gst, gross_inc_gst) and the STC rebate, all computed by the
// deterministic engine — we render them verbatim (no re-rounding). Pure;
// unit-tested.

import type { SolarEstimate, SolarPriceTier } from './types'

const esc = (s: string) =>
  s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;')

const aud0 = (n: number) =>
  '$' + Math.round(Number.isFinite(n) ? n : 0).toLocaleString('en-AU')

const kw = (n: number) =>
  (Number.isFinite(n) ? n : 0).toLocaleString('en-AU', { maximumFractionDigits: 1 })

export type SolarReportInput = {
  businessName: string
  address: string
  estimate: SolarEstimate
  quoteViewUrl?: string | null
  licenceLine?: string | null
  generatedAt?: Date
}

/** Format a payback band as "4–6 yrs", or a graceful fallback. */
function paybackText(low: number | null, high: number | null): string {
  if (low == null || high == null) return 'See your tradie for payback detail'
  const l = Math.round(low)
  const h = Math.round(high)
  return l === h ? `${l} yr${l === 1 ? '' : 's'}` : `${l}–${h} yrs`
}

function tierSection(
  price: SolarPriceTier,
  panelsCount: number | null,
  econ: { annual_savings_aud: number; payback_years_low: number | null; payback_years_high: number | null } | null,
  recommended: boolean,
): string {
  const panels = panelsCount != null ? ` · ${panelsCount} panels` : ''
  return `
  <section class="tier ${recommended ? 'tier-selected' : ''}">
    <div class="tier-head">
      <span class="tier-name">${price.tier.toUpperCase()}${recommended ? ' · RECOMMENDED' : ''}</span>
      <span class="tier-price">${aud0(price.net_inc_gst)} <small>net inc GST</small></span>
    </div>
    <div class="tier-label">${kw(price.system_kw_dc)} kW${panels} — ${esc(price.label ?? '')}</div>
    ${price.scope ? `<div class="tier-scope">${esc(price.scope)}</div>` : ''}
    <table>
      <tbody>
        <tr><td>System price (inc GST)</td><td class="num">${aud0(price.gross_inc_gst)}</td></tr>
        <tr><td>Less STC rebate (${price.stc.certificates} certificates @ ${aud0(price.stc.stc_price_aud)})</td><td class="num">&minus;${aud0(price.stc.rebate_aud)}</td></tr>
        <tr class="net"><td>Your price after rebate (inc GST)</td><td class="num">${aud0(price.net_inc_gst)}</td></tr>
      </tbody>
    </table>
    ${
      econ
        ? `<div class="econ">Est. first-year savings <b>${aud0(econ.annual_savings_aud)}/yr</b> · Payback <b>${paybackText(econ.payback_years_low, econ.payback_years_high)}</b></div>`
        : ''
    }
  </section>`
}

export function buildSolarQuoteReportHtml(input: SolarReportInput): string {
  const e = input.estimate
  const date = (input.generatedAt ?? new Date()).toLocaleDateString('en-AU', {
    day: 'numeric',
    month: 'long',
    year: 'numeric',
  })

  // Align the price tiers with their panel count (sizing) + economics by tier key.
  const panelsByTier = new Map(e.sizing.tiers.map((t) => [t.tier, t.panels_count]))
  const econByTier = new Map(e.economics.tiers.map((t) => [t.tier, t]))
  // Mirror persist-helpers: the 'better' tier is the recommended default.
  const recommendedTier = e.price.tiers.some((t) => t.tier === 'better') ? 'better' : e.price.tiers[0]?.tier

  const tiers = e.price.tiers
    .map((p) =>
      tierSection(
        p,
        panelsByTier.get(p.tier) ?? null,
        econByTier.get(p.tier) ?? null,
        p.tier === recommendedTier,
      ),
    )
    .join('')

  const a = e.economics.assumptions
  const bandLabel = e.confidence_band === 'tight' ? '±20% (good imagery)' : '±30% (indicative)'

  return `<!doctype html>
<html lang="en-AU">
<head>
<meta charset="utf-8">
<title>Solar estimate — ${esc(input.businessName)}</title>
<style>
  * { box-sizing: border-box; }
  body { font-family: 'Helvetica Neue', Arial, sans-serif; color: #16202b; margin: 0; font-size: 12px; line-height: 1.5; }
  header { border-bottom: 3px solid #FF5F00; padding-bottom: 14px; margin-bottom: 18px; }
  .eyebrow { font-family: 'Courier New', monospace; font-size: 9px; letter-spacing: 0.18em; text-transform: uppercase; color: #6b7683; }
  h1 { font-size: 24px; text-transform: uppercase; letter-spacing: -0.02em; margin: 6px 0 2px; }
  h1 .accent { color: #FF5F00; }
  .meta { color: #6b7683; font-size: 11px; }
  h2 { font-size: 13px; text-transform: uppercase; margin: 22px 0 6px; letter-spacing: 0.02em; }
  .summary { border-left: 3px solid #FF5F00; padding: 8px 12px; background: #f7f8fa; }
  .tier { border: 1px solid #dde3e9; margin-top: 14px; padding: 12px 14px; page-break-inside: avoid; }
  .tier-selected { border: 2px solid #FF5F00; }
  .tier-head { display: flex; justify-content: space-between; align-items: baseline; }
  .tier-name { font-family: 'Courier New', monospace; font-size: 11px; font-weight: 700; letter-spacing: 0.15em; color: #FF5F00; }
  .tier-price { font-size: 20px; font-weight: 800; }
  .tier-price small { font-size: 10px; font-weight: 400; color: #6b7683; }
  .tier-label { margin-top: 2px; color: #3a4654; font-weight: 600; }
  .tier-scope { margin-top: 4px; color: #4a5562; font-size: 11px; }
  table { width: 100%; border-collapse: collapse; margin-top: 10px; }
  td { border-bottom: 1px solid #e6ebf0; padding: 5px 6px; vertical-align: top; }
  tr.net td { border-bottom: none; border-top: 2px solid #16202b; font-weight: 800; }
  .num { text-align: right; white-space: nowrap; }
  .econ { margin-top: 8px; font-size: 11px; color: #3a4654; }
  .econ b { color: #16202b; }
  ul { margin: 6px 0 0; padding-left: 18px; }
  li { margin-bottom: 3px; }
  .note { color: #6b7683; font-size: 11px; }
  footer { margin-top: 26px; padding-top: 10px; border-top: 1px solid #dde3e9; font-family: 'Courier New', monospace; font-size: 8.5px; letter-spacing: 0.15em; text-transform: uppercase; color: #6b7683; }
</style>
</head>
<body>
  <header>
    <div class="eyebrow">Solar estimate · indicative</div>
    <h1>${esc(input.businessName)} <span class="accent">×</span> QuoteMate</h1>
    <div class="meta">${esc(input.address)} · ${date} · Confidence ${bandLabel}</div>
  </header>

  <h2>Your system</h2>
  <div class="summary">
    Estimate for a ${kw(e.price.tiers[e.price.tiers.length - 1]?.system_kw_dc ?? 0)} kW solar system,
    sized to your roof and capped to your network's export limit. Prices are net of the STC rebate
    and include GST.
  </div>

  <h2>Your options</h2>
  ${tiers}

  <h2>Assumptions</h2>
  <ul>
    <li>Self-consumption ${Math.round((a.self_consumption_pct ?? 0) * 100)}% of generation used on-site.</li>
    <li>Retail rate ${aud0(a.retail_rate_aud_per_kwh)}/kWh · Feed-in tariff ${aud0(a.feed_in_tariff_aud_per_kwh)}/kWh (${esc(a.feed_in_network)}).</li>
    <li>STC rebate is point-of-sale and assigned to the installer; figures use a conservative certificate price.</li>
  </ul>

  <p class="note">Indicative estimate — final price is confirmed by ${esc(input.businessName)} after review.
  ${input.quoteViewUrl ? `Live version of this quote: ${esc(input.quoteViewUrl)}` : ''}</p>

  <footer>Generated by QuoteMate${
    input.licenceLine ? ` · ${esc(input.licenceLine)}` : ''
  } · Reply to your SMS or call to go ahead</footer>
</body>
</html>`
}
