// QuoteMate · run migration 100
// (solar trade Phase 1 — solar trade row + solar_estimates + solar_config)
// Usage: node --env-file=.env.local scripts/run-migration-100.mjs

import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import pg from 'pg'

const { Client } = pg
const here = dirname(fileURLToPath(import.meta.url))
const sqlPath = join(here, '..', 'sql', 'migrations', '100_solar_trade_phase1.sql')

const dbUrl = process.env.SUPABASE_DB_URL
if (!dbUrl) {
  console.error('Missing SUPABASE_DB_URL')
  process.exit(1)
}

const sql = readFileSync(sqlPath, 'utf8')
const c = new Client({ connectionString: dbUrl, ssl: { rejectUnauthorized: false } })

async function tableExists(client, table) {
  const { rows } = await client.query(
    `select exists (
       select 1 from information_schema.tables
        where table_schema = 'public' and table_name = $1
     ) as present`,
    [table],
  )
  return rows[0].present
}

async function tradeExists(client, name) {
  const { rows } = await client.query(
    `select exists (select 1 from public.trades where name = $1) as present`,
    [name],
  )
  return rows[0].present
}

async function configCount(client) {
  const { rows } = await client.query(
    `select count(*)::int as n from public.solar_config`,
  )
  return rows[0].n
}

try {
  await c.connect()

  console.log('─── pre-flight ──')
  const beforeTrade = await tradeExists(c, 'solar')
  const beforeEst = await tableExists(c, 'solar_estimates')
  const beforeCfg = await tableExists(c, 'solar_config')
  console.log(`  before · solar trade row               ${beforeTrade}`)
  console.log(`  before · solar_estimates table         ${beforeEst}`)
  console.log(`  before · solar_config table            ${beforeCfg}`)

  console.log('\n─── executing migration 100 ──')
  await c.query(sql)
  console.log('  migration committed.')

  console.log('\n─── post-verify ──')
  const afterTrade = await tradeExists(c, 'solar')
  const afterEst = await tableExists(c, 'solar_estimates')
  const afterCfg = await tableExists(c, 'solar_config')
  const cfgRows = await configCount(c)
  console.log(`  after  · solar trade row               ${afterTrade}`)
  console.log(`  after  · solar_estimates table         ${afterEst}`)
  console.log(`  after  · solar_config table            ${afterCfg}`)
  console.log(`  after  · solar_config rows             ${cfgRows}`)

  if (!afterTrade) {
    console.error(`\nABORTING: expected the 'solar' trade row to exist.`)
    process.exit(2)
  }
  if (!afterEst) {
    console.error(`\nABORTING: expected the solar_estimates table to exist.`)
    process.exit(2)
  }
  if (!afterCfg) {
    console.error(`\nABORTING: expected the solar_config table to exist.`)
    process.exit(2)
  }
  if (cfgRows < 1) {
    console.error(`\nABORTING: expected ≥1 seeded solar_config row, found ${cfgRows}.`)
    process.exit(2)
  }

  console.log('\nMigration 100 complete.')
} catch (e) {
  console.error('MIGRATION FAILED:', e.message)
  process.exitCode = 1
} finally {
  await c.end()
}
