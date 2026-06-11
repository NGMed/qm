// QuoteMate · run migration 103 (Solar AI "panels installed" preview —
// solar_estimates.panels_image_path + panels_image_status).
// Usage: node --env-file=.env.local scripts/run-migration-103.mjs

import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import pg from 'pg'

const { Client } = pg
const here = dirname(fileURLToPath(import.meta.url))
const sqlPath = join(here, '..', 'sql', 'migrations', '103_solar_panels_preview.sql')

const dbUrl = process.env.SUPABASE_DB_URL
if (!dbUrl) {
  console.error('Missing SUPABASE_DB_URL')
  process.exit(1)
}

const sql = readFileSync(sqlPath, 'utf8')
const c = new Client({ connectionString: dbUrl, ssl: { rejectUnauthorized: false } })

async function columnExists(client, column) {
  const { rows } = await client.query(
    `select exists (
       select 1 from information_schema.columns
        where table_schema='public'
          and table_name='solar_estimates'
          and column_name=$1
     ) as present`,
    [column],
  )
  return rows[0].present
}

try {
  await c.connect()
  console.log('─── executing migration 103 ──')
  await c.query(sql)
  console.log('  migration committed.')

  let allPresent = true
  for (const col of ['panels_image_path', 'panels_image_status']) {
    const present = await columnExists(c, col)
    console.log(`  after · solar_estimates.${col.padEnd(22)} ${present}`)
    if (!present) allPresent = false
  }

  if (!allPresent) {
    console.error('\nABORTING: expected both panels-preview columns to exist after migration.')
    process.exit(2)
  }
  console.log('\nMigration 103 complete.')
} catch (e) {
  console.error('MIGRATION FAILED:', e.message)
  process.exitCode = 1
} finally {
  await c.end()
}
