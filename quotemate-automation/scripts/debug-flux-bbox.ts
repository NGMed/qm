// One-off diagnostic: print the real annual-flux GeoTIFF bbox so the
// plane-anchor projection (lat/lng vs raster CRS) can be verified.
// Usage: npx tsx --env-file=.env.local --env-file=.env.development.local scripts/debug-flux-bbox.ts
import { fetchSolarDataLayersWithUrls } from '../lib/solar/data-layers'
import { decodeSolarGeoTiff } from '../lib/solar/geotiff'
import { withApiKey } from '../lib/solar/sun-assets'

async function main() {
  const apiKey = process.env.GOOGLE_SOLAR_API_KEY ?? process.env.GOOGLE_MAPS_API_KEY
  if (!apiKey) throw new Error('no maps key')
  const loc = { lat: -33.8679, lng: 151.211 } // Martin Place, Sydney

  const { summary, urls } = await fetchSolarDataLayersWithUrls(loc, { apiKey })
  console.log('summary:', summary.status, summary.detail ?? '')
  if (!urls?.annual_flux) {
    console.log('no flux url')
    return
  }
  const res = await fetch(withApiKey(urls.annual_flux, apiKey))
  console.log('flux HTTP:', res.status)
  const buf = new Uint8Array(await res.arrayBuffer())
  const dec = await decodeSolarGeoTiff(buf)
  if (!dec.ok) {
    console.log('decode failed:', dec.detail)
    return
  }
  console.log('size :', dec.data.width, 'x', dec.data.height, 'bands', dec.data.bands)
  console.log('bbox :', dec.data.bbox)
  console.log('expected (deg): lng ~151.21, lat ~-33.87')
}

main().catch((e) => {
  console.error(e)
  process.exit(1)
})
