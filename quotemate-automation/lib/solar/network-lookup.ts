// ════════════════════════════════════════════════════════════════════
// Solar — postcode → DNSP/network resolver (spec §4, economics).
//
// The feed-in tariff and export limit are network-specific.  We derive
// the network from a coarse postcode prefix table that covers the two
// live states (NSW + QLD).  Any postcode not in the table falls back to
// the 'default' sentinel, which routes through
// config.feed_in.default_aud_per_kwh — always a safe value.
//
// The table intentionally omits fringe postcodes; accuracy is best-
// effort.  Tradie review is mandatory for all solar quotes (spec §6),
// so a wrong network selection is caught before customer send.
//
// PURE — no I/O, no SDK.  Fully unit-testable.
// ════════════════════════════════════════════════════════════════════

/**
 * Coarse postcode prefix → DNSP/network lookup.
 *
 * NSW networks:
 *   Ausgrid   — greater Sydney metro (2xxx) + ACT fringe
 *   Endeavour — south-western Sydney / Wollongong / Blue Mts (2xxx overlap)
 *   Essential — regional NSW (2xxx inland + north coast)
 *
 * QLD networks:
 *   Energex   — south-east QLD (4xxx)
 *   Ergon     — regional QLD (4xxx rural / north)
 *
 * Lookup strategy: exact postcode first, then 3-digit prefix, then
 * 2-digit prefix, then fallback to 'default'.
 */

// ── Exact-postcode overrides for key suburban postcodes ──────────────
const EXACT: Record<string, string> = {
  // Sydney metro — Ausgrid
  '2000': 'Ausgrid', '2010': 'Ausgrid', '2020': 'Ausgrid', '2025': 'Ausgrid',
  '2030': 'Ausgrid', '2040': 'Ausgrid', '2045': 'Ausgrid', '2050': 'Ausgrid',
  '2060': 'Ausgrid', '2065': 'Ausgrid', '2070': 'Ausgrid', '2075': 'Ausgrid',
  '2080': 'Ausgrid', '2085': 'Ausgrid', '2088': 'Ausgrid', '2090': 'Ausgrid',
  '2100': 'Ausgrid', '2110': 'Ausgrid', '2115': 'Ausgrid', '2120': 'Ausgrid',
  '2125': 'Ausgrid', '2130': 'Ausgrid', '2135': 'Ausgrid', '2140': 'Ausgrid',
  '2145': 'Ausgrid', '2150': 'Ausgrid', '2160': 'Ausgrid', '2165': 'Ausgrid',
  '2170': 'Ausgrid', '2175': 'Ausgrid', '2190': 'Ausgrid', '2195': 'Ausgrid',
  '2200': 'Ausgrid', '2205': 'Ausgrid', '2210': 'Ausgrid', '2220': 'Ausgrid',

  // Western / south-western Sydney — Endeavour
  '2745': 'Endeavour', '2747': 'Endeavour', '2750': 'Endeavour', '2570': 'Endeavour',
  '2560': 'Endeavour', '2564': 'Endeavour', '2565': 'Endeavour', '2566': 'Endeavour',

  // SE QLD metro — Energex
  '4000': 'Energex', '4005': 'Energex', '4010': 'Energex', '4014': 'Energex',
  '4017': 'Energex', '4051': 'Energex', '4059': 'Energex', '4066': 'Energex',
  '4067': 'Energex', '4068': 'Energex', '4101': 'Energex', '4102': 'Energex',
  '4105': 'Energex', '4109': 'Energex', '4122': 'Energex', '4152': 'Energex',
  '4179': 'Energex', '4205': 'Energex', '4350': 'Energex',
}

// ── 3-digit prefix → network ─────────────────────────────────────────
const PREFIX3: Record<string, string> = {
  // NSW — Ausgrid (inner-outer metro belt)
  '200': 'Ausgrid', '201': 'Ausgrid', '202': 'Ausgrid', '203': 'Ausgrid',
  '204': 'Ausgrid', '205': 'Ausgrid', '206': 'Ausgrid', '207': 'Ausgrid',
  '208': 'Ausgrid', '209': 'Ausgrid', '210': 'Ausgrid', '211': 'Ausgrid',
  '212': 'Ausgrid', '213': 'Ausgrid', '214': 'Ausgrid', '215': 'Ausgrid',
  '216': 'Ausgrid', '217': 'Ausgrid', '218': 'Ausgrid', '219': 'Ausgrid',
  '220': 'Ausgrid', '221': 'Ausgrid', '222': 'Ausgrid',

  // NSW — Endeavour (south-west + Hunter valley fringe)
  '274': 'Endeavour', '275': 'Endeavour', '256': 'Endeavour', '257': 'Endeavour',

  // QLD — Energex (SE QLD)
  '400': 'Energex', '401': 'Energex', '402': 'Energex', '403': 'Energex',
  '404': 'Energex', '405': 'Energex', '406': 'Energex', '407': 'Energex',
  '408': 'Energex', '409': 'Energex', '410': 'Energex', '411': 'Energex',
  '412': 'Energex', '413': 'Energex', '414': 'Energex', '415': 'Energex',
  '416': 'Energex', '417': 'Energex', '418': 'Energex', '419': 'Energex',
  '420': 'Energex', '421': 'Energex', '422': 'Energex', '423': 'Energex',
  '435': 'Energex',

  // QLD — Ergon (regional QLD)
  '470': 'Ergon', '471': 'Ergon', '472': 'Ergon', '473': 'Ergon',
  '474': 'Ergon', '475': 'Ergon', '476': 'Ergon', '480': 'Ergon',
  '481': 'Ergon', '482': 'Ergon', '483': 'Ergon', '484': 'Ergon',
  '485': 'Ergon', '486': 'Ergon', '487': 'Ergon', '488': 'Ergon',
}

// ── 2-digit prefix → network ─────────────────────────────────────────
const PREFIX2: Record<string, string> = {
  // NSW (non-metro) → Essential Energy (regional NSW default)
  '23': 'Essential', '24': 'Essential', '25': 'Essential', '26': 'Essential',
  '27': 'Essential', '28': 'Essential', '29': 'Essential',

  // QLD → Ergon for most regional prefixes
  '43': 'Ergon', '44': 'Ergon', '45': 'Ergon', '46': 'Ergon',
  '47': 'Ergon', '48': 'Ergon',
}

/**
 * Resolve the DNSP network name from an AU postcode.
 *
 * Returns the network string (e.g. 'Ausgrid', 'Energex') that the solar
 * engine uses for feed-in tariff + export limit look-ups.  Falls back to
 * 'default' for any unrecognised postcode — the engine uses
 * `config.feed_in.default_aud_per_kwh` in that case (spec §4).
 *
 * PURE — no I/O.
 */
export function resolveNetworkFromPostcode(postcode: string): string {
  const p = postcode.trim()
  if (EXACT[p]) return EXACT[p]
  if (p.length >= 3 && PREFIX3[p.slice(0, 3)]) return PREFIX3[p.slice(0, 3)]
  if (p.length >= 2 && PREFIX2[p.slice(0, 2)]) return PREFIX2[p.slice(0, 2)]
  return 'default'
}
