// GET /api/onboard/intent/[token] — resolve an SMS-initiated signup
// intent token into its prefill payload, for the /signup page to read
// when it loads with ?intent=<token> in the URL.
//
// Returns 404 when the token doesn't exist, is already used, or has
// expired. The 404 lets the signup page degrade gracefully — it'll
// just show the empty form without the "mobile already saved" banner.

import { createClient } from '@supabase/supabase-js'
import { resolveActiveIntent } from '@/lib/onboard/intent-tokens'

const supabase = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!,
)

type Params = { token: string }

export async function GET(
  _req: Request,
  ctx: { params: Promise<Params> },
) {
  const { token } = await ctx.params
  if (!token || token.length < 4 || token.length > 16) {
    return Response.json(
      { ok: false, error: 'invalid token format' },
      { status: 400 },
    )
  }

  const intent = await resolveActiveIntent(supabase, token)
  if (!intent) {
    return Response.json(
      { ok: false, error: 'token not found, already used, or expired' },
      { status: 404 },
    )
  }

  return Response.json({
    ok: true,
    intent: {
      token: intent.token,
      owner_mobile: intent.owner_mobile,
      expires_at: intent.expires_at,
    },
  })
}
