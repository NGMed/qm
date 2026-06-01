// Pure helpers used by app/api/roofing/save-as-quote — extracted so
// vitest can test them without dragging in Supabase / Next runtime.

/** PURE — split "27 Smith Street, Penrith" → { street, suburb }. */
export function splitAddress(full: string): { street: string; suburb: string } {
  const idx = full.lastIndexOf(',')
  if (idx < 0) return { street: full.trim(), suburb: '' }
  return {
    street: full.slice(0, idx).trim(),
    suburb: full.slice(idx + 1).trim(),
  }
}

/** PURE — build the good/better/best jsonb tier objects the existing
 *  customer quote page (/q/[token]) expects. */
export function buildTierObjects(price: {
  area_m2: number
  effective_rate_per_m2: number
  tiers: ReadonlyArray<{
    tier: 'good' | 'better' | 'best'
    label: string
    ex_gst: number
    inc_gst: number
    scope: string
  }>
}) {
  const tierObj = (i: number) => {
    const t = price.tiers[i]
    return {
      label: t.label,
      subtotal_ex_gst: t.ex_gst,
      total_inc_gst: t.inc_gst,
      line_items: [
        {
          unit: 'sqm',
          quantity: Number(price.area_m2.toFixed(1)),
          description: t.scope,
          unit_price_ex_gst: Number(price.effective_rate_per_m2.toFixed(2)),
          total_ex_gst: t.ex_gst,
          source: 'labour',
        },
      ],
    }
  }
  return { good: tierObj(0), better: tierObj(1), best: tierObj(2) }
}
