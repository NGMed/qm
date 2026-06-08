// Cron worker — called by cron-job.org every 5 min with
// `Authorization: Bearer <CRON_SECRET>`. Fast-acks and runs the flush in
// after(); summary goes to logs. maxDuration=300 (Vercel Pro) covers the
// blocking Gemini upload+index per table.
import { after } from 'next/server'
import pg from 'pg'
import { loadKbConfigFromEnv } from '@/lib/admin-loader/mt-filestore-kb'
import { syncDirtyTables } from '@/lib/kb-sync/sync'

export const dynamic = 'force-dynamic'
export const maxDuration = 300

function isAuthorised(req: Request): boolean {
  const expected = process.env.CRON_SECRET
  if (process.env.NODE_ENV === 'production') {
    if (!expected) return false
    return req.headers.get('authorization') === `Bearer ${expected}`
  }
  const got = req.headers.get('authorization')
  if (got && expected) return got === `Bearer ${expected}`
  return true
}

export async function GET(req: Request) {
  if (!isAuthorised(req)) {
    return Response.json({ ok: false, error: 'unauthorised' }, { status: 401 })
  }

  const dbUrl = process.env.SUPABASE_DB_URL
  const storeId = process.env.KB_PRICING_STORE_ID
  if (!dbUrl || !storeId) {
    return Response.json(
      { ok: false, error: 'missing SUPABASE_DB_URL or KB_PRICING_STORE_ID' },
      { status: 503 },
    )
  }

  let kb
  try {
    kb = loadKbConfigFromEnv()
  } catch (e) {
    return Response.json(
      { ok: false, error: `KB not configured: ${(e as Error).message}` },
      { status: 503 },
    )
  }

  const maxTables = Number(process.env.KB_SYNC_MAX_TABLES_PER_RUN ?? '8') || 8

  after(async () => {
    const client = new pg.Client({
      connectionString: dbUrl,
      ssl: { rejectUnauthorized: false },
    })
    try {
      await client.connect()
      const summary = await syncDirtyTables({ db: client, kb, storeId, maxTables })
      console.log('[cron/kb-sync] done', summary)
    } catch (e) {
      console.error('[cron/kb-sync] fatal', e)
    } finally {
      await client.end().catch(() => {})
    }
  })

  return Response.json({ ok: true, accepted: true })
}
