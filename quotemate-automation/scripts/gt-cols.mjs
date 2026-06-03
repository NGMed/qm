import pg from 'pg'
const c = new pg.Client({ connectionString: process.env.SUPABASE_DB_URL, ssl: { rejectUnauthorized: false } })
await c.connect()
for (const t of ['shared_assemblies','tenant_service_offerings','shared_materials','tenant_material_catalogue','tenant_material_preferences']) {
  const { rows } = await c.query(
    `select column_name, data_type from information_schema.columns where table_schema='public' and table_name=$1 order by ordinal_position`, [t])
  console.log(`\n── ${t} (${rows.length} cols) ──`)
  console.log(rows.map(r => `${r.column_name}:${r.data_type}`).join('  |  ') || '(table not found)')
}
await c.end()
