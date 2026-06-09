// ════════════════════════════════════════════════════════════════════
// Solar — forward-geocoding helper (address → LatLng).
//
// The roofing geocode.ts does REVERSE geocoding (coord → address) via
// Nominatim. The solar entry flow needs the opposite: a customer-typed
// address → {lat,lng} to seed the coverage gate + buildingInsights call.
// We use Google Geocoding (same key family as the Solar/Maps APIs).
//
// Same shape as the rest of lib/solar: pure parser + injectable-fetch
// I/O wrapper, so the parse logic is unit-testable without network.
// PURE money path stays elsewhere; this is just resolution.
// ════════════════════════════════════════════════════════════════════

import type { LatLng } from './types'

const DEFAULT_BASE_URL =
  process.env.GOOGLE_GEOCODE_API_URL ??
  'https://maps.googleapis.com/maps/api/geocode/json'

type FetchLike = (
  input: RequestInfo | URL,
  init?: RequestInit,
) => Promise<Response>

export type GeocodeResult =
  | { ok: true; location: LatLng; formatted_address: string | null }
  | {
      ok: false
      code: 'config_missing' | 'not_found' | 'network_error' | 'provider_error'
      detail: string
    }

export type GeocodeOpts = {
  apiKey: string | undefined
  fetchImpl?: FetchLike
  baseUrl?: string
}

/** PURE — parse a Google Geocoding API response body. */
export function parseGeocodeResponse(body: unknown): GeocodeResult {
  if (!body || typeof body !== 'object') {
    return { ok: false, code: 'provider_error', detail: 'Geocoder returned a non-object body.' }
  }
  const b = body as Record<string, unknown>
  const status = typeof b.status === 'string' ? b.status : ''
  if (status === 'ZERO_RESULTS') {
    return { ok: false, code: 'not_found', detail: 'No match for that address.' }
  }
  const results = Array.isArray(b.results) ? b.results : []
  const first = results[0] as
    | { geometry?: { location?: { lat?: unknown; lng?: unknown } }; formatted_address?: unknown }
    | undefined
  const lat = first?.geometry?.location?.lat
  const lng = first?.geometry?.location?.lng
  if (typeof lat !== 'number' || typeof lng !== 'number' || !Number.isFinite(lat) || !Number.isFinite(lng)) {
    return { ok: false, code: 'provider_error', detail: `Geocoder status ${status || 'unknown'}, no finite location.` }
  }
  const formatted =
    typeof first?.formatted_address === 'string' ? first.formatted_address : null
  return { ok: true, location: { lat, lng }, formatted_address: formatted }
}

/** Forward-geocode an address. Best-effort — any miss surfaces as
 *  { ok: false, code }. Never throws. */
export async function geocodeAddress(
  address: string,
  opts: GeocodeOpts,
): Promise<GeocodeResult> {
  if (!opts.apiKey) {
    return { ok: false, code: 'config_missing', detail: 'Geocoding API key is not configured.' }
  }
  const base = opts.baseUrl ?? DEFAULT_BASE_URL
  const url =
    `${base}?address=${encodeURIComponent(address)}` +
    `&region=au&components=country:AU&key=${encodeURIComponent(opts.apiKey)}`
  const fetchImpl = opts.fetchImpl ?? ((u, init) => fetch(u, init))

  let res: Response
  try {
    res = await fetchImpl(url, { method: 'GET', headers: { Accept: 'application/json' } })
  } catch (e) {
    return { ok: false, code: 'network_error', detail: e instanceof Error ? e.message : String(e) }
  }
  if (!res.ok) {
    return { ok: false, code: 'provider_error', detail: `Geocoder HTTP ${res.status}` }
  }
  let body: unknown
  try {
    body = await res.json()
  } catch {
    return { ok: false, code: 'provider_error', detail: 'Geocoder returned non-JSON.' }
  }
  return parseGeocodeResponse(body)
}
