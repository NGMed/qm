// Weatherproof / outdoor spec rule.
//
// When the customer's request implies an OUTDOOR / weather-exposed install
// (e.g. "exterior garage wall", "caravan", an IP rating asked for), the
// fitting must be weatherproof (IP-rated). A standard indoor product is then
// a spec MISMATCH — so spec-aware selection won't prefer it and the guard
// flags it. Cross-cutting (derived from location/use_case), so it lives
// outside the per-key reconciler but flows through the same verdict.
//
// PURE + dependency-free except the canonicaliser. Unit-tested.

import { canonicalise } from './spec-registry'
import type { ProductProperties, RequestedSpecs, SpecConflict } from './spec-reconcile'

// Clear weather-EXPOSED location words. Deliberately conservative — excludes
// high-collision words that commonly name INDOOR rooms / equipment ("pool
// pump" room, "garden" lights cupboard, "fence line", "courtyard room"), and
// drops use_case nouns (caravan/pool/garden) entirely: a related use_case
// does NOT mean the install point is weather-exposed. The install LOCATION is
// the reliable signal.
const EXPOSURE_LOCATION_RE =
  /\b(exterior|external|outdoor|outside|alfresco|patio|deck|verandah|veranda|pergola|carport|eaves?|soffit|balcony)\b/
// An explicit indoor qualifier overrides an exposure word ("enclosed patio",
// "patio doors inside", "exterior-trim GPO internal").
const INDOOR_RE = /\b(inside|indoor|internal|interior|enclosed|undercover)\b/
const TRUTHY = /^(true|yes|y|1|required|need(ed)?)$/

/** PURE — parse a canonical IPnn rating to its number (or NaN). */
function ipNumber(value: string | number | null | undefined): number {
  const canon = canonicalise('ip_rating', value)
  if (!canon) return NaN
  return parseInt(canon.replace(/\D/g, ''), 10)
}

function reqVal(requested: RequestedSpecs, key: string): string {
  if (!requested || typeof requested !== 'object') return ''
  const v = requested[key]
  // Lowercase + turn separators (_, -, /) into spaces so word-boundary
  // matches work on tokens like "exterior_wall".
  return v == null ? '' : String(v).trim().toLowerCase().replace(/[_/\-]+/g, ' ')
}

/**
 * PURE — does the customer's request imply an outdoor / weather-exposed
 * install that needs a weatherproof (IP-rated) fitting? Triggers on an
 * outdoor location or use_case, an explicit weatherproof/outdoor flag, or a
 * requested IP rating.
 */
export function requiresWeatherproof(requested: RequestedSpecs): boolean {
  if (!requested || typeof requested !== 'object') return false
  const wp = reqVal(requested, 'weatherproof')
  if (wp && TRUTHY.test(wp)) return true
  const outdoor = reqVal(requested, 'outdoor')
  if (outdoor && TRUTHY.test(outdoor)) return true
  // A requested IP rating only implies a weatherproof requirement at IP44+
  // (the common weatherproof threshold). A low/indoor code like IP20 must
  // NOT trigger it — that would exclude the correct indoor product.
  const reqIp = ipNumber(reqVal(requested, 'ip_rating'))
  if (Number.isFinite(reqIp) && reqIp >= 44) return true
  // Location-driven: a clear exposure word that ISN'T overridden by an
  // explicit indoor qualifier. (use_case is deliberately not a trigger.)
  const loc = reqVal(requested, 'location')
  if (loc && EXPOSURE_LOCATION_RE.test(loc) && !INDOOR_RE.test(loc)) return true
  return false
}

/**
 * PURE — does the product carry weatherproof evidence? True when it has a
 * weatherproof/outdoor flag, an IP rating of IP44+ (the common weatherproof
 * threshold), or a name that says weatherproof / outdoor / IP4x-IP6x / WP.
 */
export function productIsWeatherproof(
  properties: ProductProperties,
  name?: string | null,
): boolean {
  const props = (properties && typeof properties === 'object' ? properties : {}) as Record<string, unknown>

  const flag = (v: unknown): boolean =>
    v === true || (typeof v === 'string' && TRUTHY.test(v.trim().toLowerCase()))
  if (flag(props.weatherproof) || flag(props.outdoor)) return true

  const n = ipNumber(props.ip_rating as string | number | null | undefined)
  if (Number.isFinite(n) && n >= 44) return true

  // Name fallback — only STRONG weatherproof signals. Deliberately NOT the
  // bare words "outdoor"/"exterior" (they appear on indoor products like an
  // "exterior-trim" GPO, which would wrongly pass for an external job).
  const nm = (name ?? '').toLowerCase()
  if (/weather\s?proof|\bip\s?(4[4-9]|5\d|6\d)\b|\bwp\b/.test(nm)) return true
  return false
}

/**
 * PURE — the conflict to fold into a reconcile verdict: present when the
 * request needs weatherproof but the product isn't. null otherwise (no
 * weatherproof requirement, or the product is weatherproof).
 */
export function weatherproofConflict(
  requested: RequestedSpecs,
  properties: ProductProperties,
  name?: string | null,
): SpecConflict | null {
  if (!requiresWeatherproof(requested)) return null
  if (productIsWeatherproof(properties, name)) return null
  return { key: 'weatherproof', requested: 'weatherproof (external install)', product: 'not weatherproof' }
}
