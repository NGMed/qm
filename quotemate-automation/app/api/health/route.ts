// Lightweight liveness probe. Used by Railway's healthcheck and any
// uptime monitor (UptimeRobot, BetterStack, etc.). Should return fast
// — don't ping the DB here; that's what /api/health/deep is for.

export const dynamic = 'force-dynamic'

export async function GET() {
  return Response.json({
    ok: true,
    service: 'quotemate-automation',
    time: new Date().toISOString(),
    region:
      process.env.VERCEL_REGION ??
      process.env.RAILWAY_REGION ??
      process.env.FLY_REGION ??
      'unknown',
    commit: process.env.VERCEL_GIT_COMMIT_SHA ?? process.env.RAILWAY_GIT_COMMIT_SHA ?? null,
    // Which feature flags are actually live in THIS running deployment.
    // Lets you confirm — in one request — that the deploy serving SMS
    // is the build + flags you expect (the WP9 price/image flow only
    // runs when wp9_product_options is true AND the commit is recent).
    features: {
      wp9_product_options: process.env.WP9_PRODUCT_OPTIONS === '1',
      deterministic_bom: process.env.DETERMINISTIC_BOM === '1',
      wp4_render_verify: process.env.WP4_RENDER_VERIFY === '1',
      price_history_hint: process.env.PRICE_HISTORY_HINT === '1',
    },
  })
}
