// Pure: derive a {lat,lng} centre for the solar hero satellite image from
// the estimate's roof polygon. GeoJSON rings are [lng, lat] pairs, so the
// first vertex maps to { lat: v[1], lng: v[0] }. Null on no polygon
// (manual fallback) — the route then centres on the address instead.

export type LatLngCenter = { lat: number; lng: number }

export function centerForSolarEstimate(args: {
  roof: { polygon_geojson: { type?: string; coordinates?: number[][][] } | null }
}): LatLngCenter | null {
  const ring = args.roof.polygon_geojson?.coordinates?.[0]
  const v = ring?.[0]
  if (
    Array.isArray(v) &&
    typeof v[0] === 'number' &&
    Number.isFinite(v[0]) &&
    typeof v[1] === 'number' &&
    Number.isFinite(v[1])
  ) {
    return { lat: v[1], lng: v[0] }
  }
  return null
}

// ── Premium-quote overlay centre (spec 2026-06-12 §4.2) ──────────────
//
// The layout/string overlays project panel lat/lngs into the static
// map's pixel space, so the MAP and the OVERLAYS must agree on one
// centre coordinate. Priority:
//   1. centroid of the per-panel placements (best framing for layout)
//   2. roof polygon first vertex (legacy centring)
//   3. the estimate's resolved geocode (context.location)
//   4. null — caller falls back to the address string (overlays are
//      then impossible: an address-centred map has no deterministic
//      pixel mapping, so consumers omit the overlay sections).

type PanelCenterLike = { center: { lat: number; lng: number } }

/** PURE — mean of panel centres; null when no valid panels. */
export function panelArrayCentroid(
  panels: ReadonlyArray<PanelCenterLike> | null | undefined,
): LatLngCenter | null {
  if (!panels || panels.length === 0) return null
  let latSum = 0
  let lngSum = 0
  let n = 0
  for (const p of panels) {
    const { lat, lng } = p.center
    if (Number.isFinite(lat) && Number.isFinite(lng)) {
      latSum += lat
      lngSum += lng
      n += 1
    }
  }
  return n > 0 ? { lat: latSum / n, lng: lngSum / n } : null
}

/** PURE — the single centre both the static map AND the overlays use. */
export function resolveSolarOverlayCenter(args: {
  roof: {
    panels?: ReadonlyArray<PanelCenterLike> | null
    polygon_geojson: { type?: string; coordinates?: number[][][] } | null
  }
  location?: LatLngCenter | null
}): LatLngCenter | null {
  const centroid = panelArrayCentroid(args.roof.panels)
  if (centroid) return centroid
  const polygon = centerForSolarEstimate({ roof: args.roof })
  if (polygon) return polygon
  const loc = args.location
  if (loc && Number.isFinite(loc.lat) && Number.isFinite(loc.lng)) {
    return { lat: loc.lat, lng: loc.lng }
  }
  return null
}
