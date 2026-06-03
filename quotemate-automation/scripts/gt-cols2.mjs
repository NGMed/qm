import pg from 'pg'
const c = new pg.Client({ connectionString: process.env.SUPABASE_DB_URL, ssl: { rejectUnauthorized: false } })
await c.connect()
for (const t of ['sms_conversations','sms_messages','intakes','quotes']) {
  const { rows } = await c.query(
    `select column_name, data_type from information_schema.columns where table_schema='public' and table_name=$1 order by ordinal_position`, [t])
  console.log(`\n── ${t} (${rows.length} cols) ──`)
  console.log(rows.map(r => r.column_name).join(', '))
}
await c.end()
