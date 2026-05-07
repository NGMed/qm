// Database-grounding validator — runs after Opus emits a draft quote and
// before the quote is persisted. Walks every line_item and verifies that
// its unit_price_ex_gst is traceable to a real DB row × pricing_book
// derivation AND that the line description and the source row are in
// the same product category (downlights, GPOs, smoke alarms, etc).
//
// If any line item fails, the route handler downgrades the entire quote
// to inspection-required: tiers wiped to null, $199 site-visit fee becomes
// the only chargeable amount, customer is told "pricing not yet available".
//
// This is the fourth and last layer of defence against fabricated prices,
// on top of:
//   1. STRICT GROUNDING in the system prompt
//   2. NON-NEGOTIABLE RULES in the system prompt
//   3. Route-level forced null tiers when needs_inspection is true
//   4. THIS validator — the only deterministic, machine-checkable layer
//
// Updated 2026-05-06: previous version checked that the price existed in
// the DB but did not verify the SEMANTIC match between the line text and
// the source row. That allowed bugs like a "smoke alarm" line being
// priced from a "downlight" row at the same dollar amount × different
// markup. Now we require category overlap as well.

export type PricingBookForValidation = {
  hourly_rate: number | string
  apprentice_rate: number | string
  call_out_minimum: number | string
  default_markup_pct: number | string
}

export type GroundingFailure = {
  tier: 'good' | 'better' | 'best'
  lineIndex: number
  description: string
  unit: string
  unit_price_ex_gst: number
  expected: string
}

export type GroundingResult =
  | { valid: true }
  | { valid: false; failures: GroundingFailure[] }

/** A categorised candidate price — one entry per DB row × markup variant. */
export type CandidatePrice = {
  /** Marked-up dollar amount that a line item could legitimately quote. */
  price: number
  /** The original row's name, e.g. "Tri-colour LED downlight". */
  sourceName: string
  /** Category tags extracted from the source name. */
  categories: Set<Category>
}

export type CandidatePrices = {
  material: CandidatePrice[]
  assembly: CandidatePrice[]
}

/** Tolerance in dollars — Stripe stores cents; markups round; allow ±$0.50 */
const PRICE_TOLERANCE = 0.5

function n(v: number | string): number {
  return typeof v === 'string' ? parseFloat(v) : v
}

// ─────────────────────────────────────────────────────────────────
// Category extraction — keyword tags applied to both candidate rows
// and line descriptions. Validation passes only when at least one
// tag appears on both sides.
// ─────────────────────────────────────────────────────────────────

export type Category =
  | 'downlight'
  | 'gpo'
  | 'smoke_alarm'
  | 'fan'
  | 'outdoor_light'
  | 'rcbo'
  | 'sundry'
  | 'oven_cooktop'
  | 'ev_charger'
  | 'switchboard'
  | 'general'

/** Extract category tags from arbitrary product-name or line-description text. */
export function categorise(text: string): Set<Category> {
  const t = (text ?? '').toLowerCase()
  const cats = new Set<Category>()

  // Outdoor first — "outdoor IP-rated LED light" must beat the bare-LED rule.
  if (/\b(outdoor|exterior|deck|weatherproof|ip[-\s]?rated|garden|patio|wall\s*pack)\b/.test(t)) {
    cats.add('outdoor_light')
  }
  if (/\bdownlight/.test(t)) cats.add('downlight')
  if (/\b(gpo|power\s*point|socket|wall\s*outlet|\busb\s*out)/.test(t)) cats.add('gpo')
  if (/\bsmoke\s*alarm|\binterconnect(?:ed)?\s+alarm/.test(t)) cats.add('smoke_alarm')
  if (/\b(ceiling\s*fan|\bfan\b)/.test(t)) cats.add('fan')
  if (/\b(rcbo|safety\s*switch|safety\s*breaker|circuit\s*breaker)\b/.test(t)) cats.add('rcbo')
  if (/\b(sundries|sundry|terminals|consumables|miscellaneous|extras|disposal|removal\s*of\s*old)\b/.test(t)) {
    cats.add('sundry')
  }
  if (/\b(oven|cooktop|stove|range\s*hood)\b/.test(t)) cats.add('oven_cooktop')
  if (/\b(ev\s*charger|electric\s*vehicle|wallbox)\b/.test(t)) cats.add('ev_charger')
  if (/\b(switchboard|switch\s*board|main\s*board|distribution\s*board)\b/.test(t)) {
    cats.add('switchboard')
  }

  if (cats.size === 0) cats.add('general')
  return cats
}

/**
 * A line description and a candidate row "match categorically" when:
 *   - they share at least one specific tag (downlight ∩ downlight), OR
 *   - the line is purely 'general' AND the row is 'sundry' only — handles
 *     legitimate catch-all lines like "Disposal of old fittings" being
 *     priced from the Sundries row.
 */
function categoriesMatch(lineCats: Set<Category>, rowCats: Set<Category>): boolean {
  for (const lc of lineCats) {
    for (const rc of rowCats) {
      if (lc === rc) return true
    }
  }
  if (lineCats.has('general') && rowCats.size === 1 && rowCats.has('sundry')) return true
  return false
}

export function validateQuoteGrounding(
  draft: any,
  pricingBook: PricingBookForValidation,
  candidates: CandidatePrices,
): GroundingResult {
  // Inspection-required quotes don't carry line items to validate.
  if (draft?.needs_inspection === true) return { valid: true }

  const hourly = n(pricingBook.hourly_rate)
  const apprentice = n(pricingBook.apprentice_rate)
  const callOut = n(pricingBook.call_out_minimum)
  const markupPct = n(pricingBook.default_markup_pct)

  const within = (a: number, b: number) => Math.abs(a - b) <= PRICE_TOLERANCE

  /** Candidate rows whose price matches `target` within tolerance. */
  const findMatches = (target: number, list: CandidatePrice[]) =>
    list.filter((c) => within(c.price, target))

  const failures: GroundingFailure[] = []
  const TIERS = ['good', 'better', 'best'] as const

  for (const tierKey of TIERS) {
    const tier = draft?.[tierKey]
    if (!tier || !Array.isArray(tier.line_items)) continue

    for (let i = 0; i < tier.line_items.length; i++) {
      const li = tier.line_items[i]
      const price = Number(li?.unit_price_ex_gst)
      const description = String(li?.description ?? '(no description)')
      const unit = String(li?.unit ?? '?')

      if (!Number.isFinite(price)) {
        failures.push({
          tier: tierKey, lineIndex: i, description, unit,
          unit_price_ex_gst: price,
          expected: 'finite numeric unit_price_ex_gst',
        })
        continue
      }

      let valid = false
      let expected = ''

      if (unit === 'hr') {
        // Labour rates: hourly_rate or apprentice_rate exactly. No semantic
        // category check — labour lines are intrinsically generic.
        valid = within(price, hourly) || within(price, apprentice)
        expected = `pricing_book.hourly_rate ($${hourly}) or apprentice_rate ($${apprentice})`
      } else if (li?.source === 'callout' || (unit === 'each' && within(price, callOut))) {
        // Call-out — unit is 'each' but price matches call_out_minimum.
        valid = within(price, callOut)
        expected = `pricing_book.call_out_minimum ($${callOut})`
      } else if (unit === 'each' || unit === 'lm') {
        // Materials or assemblies — price match AND category match required.
        const lineCats = categorise(description)
        const priceMatches = [
          ...findMatches(price, candidates.material),
          ...findMatches(price, candidates.assembly),
        ]

        if (priceMatches.length === 0) {
          valid = false
          expected = `shared_materials/shared_assemblies (raw or × ${markupPct}% markup)`
        } else {
          // Of the rows that match by price, do any also match by category?
          const semanticMatch = priceMatches.find((c) => categoriesMatch(lineCats, c.categories))
          if (semanticMatch) {
            valid = true
          } else {
            valid = false
            const lineCatList = Array.from(lineCats).join(',')
            const sourceList = priceMatches
              .map((c) => `"${c.sourceName}" [${Array.from(c.categories).join(',')}]`)
              .slice(0, 3)
              .join(' | ')
            expected = `price $${price} only exists in DB rows of a different category. Line categorised as [${lineCatList}], but matching rows are: ${sourceList}`
          }
        }
      } else {
        valid = false
        expected = `recognised unit (hr / each / lm)`
      }

      if (!valid) {
        failures.push({
          tier: tierKey, lineIndex: i, description, unit,
          unit_price_ex_gst: price,
          expected,
        })
      }
    }
  }

  return failures.length === 0 ? { valid: true } : { valid: false, failures }
}

/**
 * Build the candidate-price set used by validateQuoteGrounding.
 * For each raw DB row (name + price), expand into multiple realistic
 * markup variants (10% to 40% in 5% steps, plus the tradie's configured
 * default_markup_pct). Each variant carries the source row's name and
 * extracted category tags so semantic grounding can be enforced.
 */
export function buildCandidatePrices(
  rawMaterialRows: Array<{ name: string; price: number | string | null | undefined }>,
  rawAssemblyRows: Array<{ name: string; price: number | string | null | undefined }>,
  pricingBook: PricingBookForValidation,
): CandidatePrices {
  // AU electrical markup range — covers what a tradie might realistically
  // pass to apply_markup. Default markup_pct is included even if outside
  // the 10–40 band.
  const standardMarkups = new Set<number>([0, 10, 15, 20, 25, 28, 30, 35, 40])
  standardMarkups.add(n(pricingBook.default_markup_pct))

  const multipliers = Array.from(standardMarkups).map((pct) => 1 + pct / 100)

  const expand = (rows: Array<{ name: string; price: number | string | null | undefined }>): CandidatePrice[] => {
    const out: CandidatePrice[] = []
    for (const row of rows) {
      const raw = Number(row.price)
      if (!Number.isFinite(raw)) continue
      const categories = categorise(row.name ?? '')
      for (const m of multipliers) {
        out.push({
          price: +(raw * m).toFixed(2),
          sourceName: row.name ?? '(unnamed)',
          categories,
        })
      }
    }
    return out
  }

  return {
    material: expand(rawMaterialRows),
    assembly: expand(rawAssemblyRows),
  }
}
