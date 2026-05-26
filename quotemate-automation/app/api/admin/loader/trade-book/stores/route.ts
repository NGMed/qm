// GET /api/admin/loader/trade-book/stores — list the mt-filestore-kb
// stores the admin can extract from. Admin-only.
//
// Returns: { ok: true, stores: [{ id, name, displayName, state? }] }
//
// Used by the /admin/loader UI's trade-book section to populate the
// store-picker dropdown. Returns a 503 with a clear message when KB_API_URL
// or KB_API_KEY env vars aren't set yet, so the operator sees actionable
// diagnostics instead of a silent failure.

import { createClient } from '@supabase/supabase-js'
import { resolveAdminUserId } from '@/lib/admin-loader/route-auth'
import { kbListStores, loadKbConfigFromEnv } from '@/lib/admin-loader/mt-filestore-kb'

export const dynamic = 'force-dynamic'

const supabase = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!,
)

export async function GET(req: Request) {
  const adminId = await resolveAdminUserId(supabase, req)
  if (!adminId) return Response.json({ ok: false, error: 'forbidden' }, { status: 403 })

  let kbConfig
  try {
    kbConfig = loadKbConfigFromEnv()
  } catch (e: any) {
    return Response.json(
      { ok: false, error: `mt-filestore-kb not configured: ${e?.message ?? String(e)}` },
      { status: 503 },
    )
  }

  try {
    const stores = await kbListStores(kbConfig)
    // Surface the short id (last URL segment) alongside the full resource
    // name so the UI can show a human label + send the right value back
    // to the extract route.
    const shaped = stores.map((s) => ({
      id: (s.name ?? '').split('/').pop() ?? '',
      name: s.name ?? '',
      displayName: s.displayName ?? null,
      state: s.state ?? null,
    }))
    return Response.json({ ok: true, stores: shaped })
  } catch (e: any) {
    return Response.json(
      { ok: false, error: `mt-filestore-kb error: ${e?.message ?? String(e)}` },
      { status: 502 },
    )
  }
}
