// Load CesiumJS from a CDN at runtime instead of bundling it.
//
// Cesium is one of the largest npm packages and Turbopack HANGS trying to
// compile it on first dynamic import in `npm run dev` (the production build
// pre-compiles it, so only dev is affected). Loading the prebuilt global
// from jsDelivr sidesteps the bundler entirely — it loads in seconds in
// both dev and prod, only when the 3D view is opened.
//
// Returns the global `Cesium` namespace. Idempotent (one script tag).
// NB: if a strict Content-Security-Policy is added later, allow
// `https://cdn.jsdelivr.net` in script-src / style-src / worker-src.

const CESIUM_VERSION = '1.142.0'
const CDN_BASE = `https://cdn.jsdelivr.net/npm/cesium@${CESIUM_VERSION}/Build/Cesium/`

// eslint-disable-next-line @typescript-eslint/no-explicit-any
let cesiumPromise: Promise<any> | null = null

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export function loadCesium(): Promise<any> {
  if (typeof window === 'undefined') return Promise.reject(new Error('Cesium can only load in the browser'))
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const w = window as any
  if (w.Cesium) return Promise.resolve(w.Cesium)
  if (cesiumPromise) return cesiumPromise

  // Must be set before the engine script runs so Workers/Assets resolve.
  w.CESIUM_BASE_URL = CDN_BASE

  cesiumPromise = new Promise((resolve, reject) => {
    if (!document.getElementById('cesium-widgets-css')) {
      const link = document.createElement('link')
      link.id = 'cesium-widgets-css'
      link.rel = 'stylesheet'
      link.href = `${CDN_BASE}Widgets/widgets.css`
      document.head.appendChild(link)
    }
    const existing = document.getElementById('cesium-engine-js') as HTMLScriptElement | null
    const script = existing ?? document.createElement('script')
    script.id = 'cesium-engine-js'
    script.async = true
    const onLoad = () => {
      if (w.Cesium) resolve(w.Cesium)
      else reject(new Error('CesiumJS loaded but the global was not found'))
    }
    script.addEventListener('load', onLoad)
    script.addEventListener('error', () => {
      cesiumPromise = null
      reject(new Error('Failed to load CesiumJS from the CDN'))
    })
    if (!existing) {
      script.src = `${CDN_BASE}Cesium.js`
      document.head.appendChild(script)
    }
  })
  return cesiumPromise
}
