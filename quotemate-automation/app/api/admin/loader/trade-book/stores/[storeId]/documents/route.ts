// GET /api/admin/loader/trade-book/stores/[storeId]/documents
// Lists the documents indexed in a given mt-filestore-kb store. Admin-only.
//
// Returns: { ok: true, documents: [{ name, displayName, mimeType?, state? }] }
//
// Used by the /admin/loader UI to populate a second dropdown after the
// operator picks a store — they can choose to extract from one specific
// document (passed back as a metadataFilter) instead of the whole store.

import { createClient } from '@supabase/supabase-js'
import { resolveAdminUserId } from '@/lib/admin-loader/route-auth'
import { kbListDocuments, loadKbConfigFromEnv } from '@/lib/admin-loader/mt-filestore-kb'

export const dynamic = 'force-dynamic'

const supabase = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!,
)

export async function GET(
  req: Request,
  ctx: { params: Promise<{ storeId: string }> },
) {
  const adminId = await resolveAdminUserId(supabase, req)
  if (!adminId) return Response.json({ ok: false, error: 'forbidden' }, { status: 403 })

  const { storeId } = await ctx.params
  if (!storeId) {
    return Response.json({ ok: false, error: 'storeId is required' }, { status: 400 })
  }

  let kbConfig
  try {
    kbConfig = loadKbConfigFromEnv()
  } catch (e: any) {
    return Response.json(
      { ok: false, error: `mt-filestore-kb not configured: ${e?.message ?? String(e)}` },
      { status: 503 },
    )
  }

  // Accept either the short id OR the full "fileSearchStores/..." name.
  // kbListDocuments handles both because mt-filestore-kb's server resolves
  // either form server-side.
  const resolvedStore = storeId.startsWith('fileSearchStores/')
    ? storeId
    : `fileSearchStores/${storeId}`

  try {
    const docs = await kbListDocuments(kbConfig, resolvedStore)
    const shaped = docs.map((d) => ({
      name: d.name ?? '',
      displayName: d.displayName ?? null,
      mimeType: d.mimeType ?? null,
      state: d.state ?? null,
    }))
    return Response.json({ ok: true, documents: shaped })
  } catch (e: any) {
    return Response.json(
      { ok: false, error: `mt-filestore-kb error: ${e?.message ?? String(e)}` },
      { status: 502 },
    )
  }
}
