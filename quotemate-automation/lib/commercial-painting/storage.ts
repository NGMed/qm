// Storage wrapper for commercial painting run documents — same private
// `plan-pdfs` bucket the SMS estimator uses, painting-prefixed paths:
//   plan-pdfs/paint/<runId>/<uploadId>.<ext>
//
// Unlike the dashboard electrical estimator (analyse live, never store),
// a painting run is multi-document and multi-step (classify → extract →
// preview), so the files must be retained for the run's lifetime.

import { createClient } from '@supabase/supabase-js'

const BUCKET = 'plan-pdfs'

let _client: ReturnType<typeof createClient> | null = null
function getClient() {
  if (_client) return _client
  _client = createClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.SUPABASE_SERVICE_ROLE_KEY!,
    { auth: { persistSession: false } },
  )
  return _client
}

const EXT_BY_MIME: Record<string, string> = {
  'application/pdf': 'pdf',
  'image/png': 'png',
  'image/jpeg': 'jpg',
  'image/webp': 'webp',
}

export function paintDocPath(runId: string, uploadId: string, mime: string): string {
  const ext = EXT_BY_MIME[mime] ?? 'bin'
  return `paint/${runId}/${uploadId}.${ext}`
}

/** Store one run document; returns its storage path. Retry-safe (upsert). */
export async function uploadPaintDoc(opts: {
  runId: string
  uploadId: string
  mime: string
  data: ArrayBuffer | Uint8Array | Buffer
}): Promise<string> {
  const path = paintDocPath(opts.runId, opts.uploadId, opts.mime)
  const { error } = await getClient()
    .storage.from(BUCKET)
    .upload(path, opts.data, { contentType: opts.mime, upsert: true })
  if (error) throw new Error(`paint doc upload failed: ${error.message}`)
  return path
}

/** Read a stored run document back as a Buffer. */
export async function downloadPaintDoc(path: string): Promise<Buffer> {
  const { data, error } = await getClient().storage.from(BUCKET).download(path)
  if (error || !data) throw new Error(`paint doc download failed: ${error?.message ?? 'no data'}`)
  return Buffer.from(await data.arrayBuffer())
}
