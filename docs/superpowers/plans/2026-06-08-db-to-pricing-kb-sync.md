# DB→Pricing-KB CSV Sync — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Whenever any row in any QuoteMate `public` table changes, re-export that table to CSV and replace its document in the `MT-QM-PRICING-KB` Gemini File Search store, so the KB always mirrors the live DB.

**Architecture:** In-DB statement-level `AFTER` triggers flip a per-table `dirty` flag in a new `kb_sync_state` table the instant anything changes (any source, transactional, fires once per bulk statement). An external scheduler (cron-job.org) calls `GET /api/cron/kb-sync` every 5 min; the worker exports each dirty table via raw `pg`, skips it if its sha256 is unchanged, otherwise uploads the new CSV to the store and deletes the prior document, then clears the flag (with a `bumped_at` race guard). A small `deleteDocument` endpoint is added to the separately-deployed `mt-filestore-kb` Railway service because the store API has no per-document delete.

**Tech Stack:** Next.js 16 (App Router, Node runtime), `pg` 8, Vitest (QuoteMate); NestJS + axios + Jest (`mt-filestore-kb`); Postgres 17 (Supabase); Gemini File Search REST; cron-job.org.

**Reference spec:** [docs/superpowers/specs/2026-06-08-db-to-pricing-kb-sync-design.md](../specs/2026-06-08-db-to-pricing-kb-sync-design.md)

---

## Two repos in play

| Repo | Path | Tests | Deploy |
|------|------|-------|--------|
| **mt-filestore-kb** | `C:/Users/dalig/Downloads/QuoteMate/mt-filestore-kb` | Jest | Railway |
| **QuoteMate** | `C:/Users/dalig/Downloads/QuoteMate/quoteMate/quotemate-automation` | Vitest | Vercel (Pro) |

Git commands note the repo. QuoteMate work goes on a feature branch (see Task 0).

## File structure

**mt-filestore-kb (Railway service):**
- Modify `src/gemini/gemini.service.ts` — add `deleteDocument()`.
- Modify `src/gemini/gemini.service.spec.ts` — add tests.
- Modify `src/controllers/stores.controller.ts` — add `DELETE :storeId/documents/:docId`.

**QuoteMate:**
- Modify `lib/admin-loader/mt-filestore-kb.ts` — add `kbDeleteDocument()`.
- Modify `lib/admin-loader/mt-filestore-kb.test.ts` — add tests.
- Create `lib/kb-sync/export-table-csv.ts` — pure CSV + pg export (single source of truth).
- Create `lib/kb-sync/export-table-csv.test.ts`.
- Create `lib/kb-sync/sync.ts` — flush core (deps injected, unit-testable).
- Create `lib/kb-sync/sync.test.ts`.
- Create `app/api/cron/kb-sync/route.ts` — thin cron wrapper (auth + pg + `after()`).
- Create `app/api/cron/kb-sync/route.test.ts` — auth/guard tests.
- Create `sql/migrations/096_kb_sync_state.sql` + `scripts/run-migration-096.mjs`.
- Rewrite `scripts/export-tables-to-csv.mjs` → `scripts/export-tables-to-csv.ts` (imports the lib).
- Create `scripts/kb-sync-once.ts` — backfill / manual reconcile.
- Modify `package.json` — move `pg` to `dependencies`.
- Modify `.env.local` — add `KB_PRICING_STORE_ID`, `KB_SYNC_MAX_TABLES_PER_RUN`.

---

## Task 0: Feature branch (QuoteMate)

**Files:** none.

- [ ] **Step 1: Branch off main**

The repo is on `main`. Work on a branch.

Run (in `quoteMate` repo root):
```bash
git checkout -b feat/kb-sync
```
Expected: `Switched to a new branch 'feat/kb-sync'`.

---

## Task 1: `mt-filestore-kb` — `GeminiService.deleteDocument()`

**Files:**
- Modify: `C:/Users/dalig/Downloads/QuoteMate/mt-filestore-kb/src/gemini/gemini.service.ts`
- Test: `C:/Users/dalig/Downloads/QuoteMate/mt-filestore-kb/src/gemini/gemini.service.spec.ts`

- [ ] **Step 1: Write the failing tests**

Append to `gemini.service.spec.ts` (the `fakeConfig` stub already exists at the top of the file):

```ts
describe('GeminiService.deleteDocument', () => {
  it('DELETEs the full document resource name with the api key', async () => {
    const service = new GeminiService(fakeConfig);
    const del = jest.fn().mockResolvedValue({ data: {} });
    (service as unknown as { http: { delete: jest.Mock } }).http = { delete: del };

    await service.deleteDocument(
      'fileSearchStores/abc/documents/xyz',
      'test-key',
    );

    expect(del).toHaveBeenCalledTimes(1);
    const [url, cfg] = del.mock.calls[0];
    expect(url).toBe(
      'https://generativelanguage.googleapis.com/v1beta/fileSearchStores/abc/documents/xyz',
    );
    expect((cfg as { params: { key: string } }).params.key).toBe('test-key');
  });

  it('rejects a name that is not a document resource', async () => {
    const service = new GeminiService(fakeConfig);
    (service as unknown as { http: { delete: jest.Mock } }).http = {
      delete: jest.fn(),
    };
    await expect(
      service.deleteDocument('fileSearchStores/abc', 'k'),
    ).rejects.toBeDefined();
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run (in the `mt-filestore-kb` repo):
```bash
npx jest src/gemini/gemini.service.spec.ts
```
Expected: FAIL — `service.deleteDocument is not a function`.

- [ ] **Step 3: Implement `deleteDocument`**

In `gemini.service.ts`, add this method right after `deleteStore` (around line 292, before `listDocuments`):

```ts
  async deleteDocument(documentName: string, apiKey?: string): Promise<void> {
    const key = this.resolveKey(apiKey);
    const name = (documentName || '').trim();
    if (!name.startsWith('fileSearchStores/') || !name.includes('/documents/')) {
      throw new HttpException(
        'A full document resource name (fileSearchStores/<id>/documents/<docId>) is required.',
        HttpStatus.BAD_REQUEST,
      );
    }
    try {
      await this.http.delete(`${this.baseUrl}/${name}`, { params: { key } });
    } catch (err) {
      this.fail('deleteDocument', err);
    }
  }
```

- [ ] **Step 4: Run tests to verify they pass**

Run:
```bash
npx jest src/gemini/gemini.service.spec.ts
```
Expected: PASS (all `deleteDocument` tests green).

- [ ] **Step 5: Commit**

```bash
git add src/gemini/gemini.service.ts src/gemini/gemini.service.spec.ts
git commit -m "feat(gemini): add deleteDocument to remove a single File Search doc"
```

---

## Task 2: `mt-filestore-kb` — `DELETE` document route

**Files:**
- Modify: `C:/Users/dalig/Downloads/QuoteMate/mt-filestore-kb/src/controllers/stores.controller.ts`

`Delete` and `Param` are already imported in this file.

- [ ] **Step 1: Add the route**

Insert this method into `StoresController`, right after the `deleteStore` method (around line 87, before `@Get(':storeId/documents')`):

```ts
  @Delete(':storeId/documents/:docId')
  @ApiOperation({ summary: 'Delete a single document from a store' })
  async deleteDocument(
    @Param('storeId') storeId: string,
    @Param('docId') docId: string,
    @Headers('x-gemini-key') geminiKey?: string,
  ) {
    const store = this.gemini.normalizeStoreName(storeId);
    const documentName = `${store}/documents/${docId}`;
    await this.gemini.deleteDocument(documentName, geminiKey);
    return { deleted: true, document: documentName };
  }
```

- [ ] **Step 2: Verify the build compiles**

Run:
```bash
npx tsc --noEmit -p tsconfig.json
```
Expected: no errors.

- [ ] **Step 3: Run the full service test suite**

Run:
```bash
npm test
```
Expected: PASS (existing suites + Task 1 tests).

- [ ] **Step 4: Commit**

```bash
git add src/controllers/stores.controller.ts
git commit -m "feat(stores): DELETE /v1/stores/:storeId/documents/:docId"
```

> **Operational (not now):** this service must be **redeployed to Railway** before QuoteMate's delete calls work — handled in Task 10. Until then the QuoteMate worker still uploads; replace degrades to append (logged).

---

## Task 3: QuoteMate — `kbDeleteDocument` client

**Files:**
- Modify: `quotemate-automation/lib/admin-loader/mt-filestore-kb.ts`
- Test: `quotemate-automation/lib/admin-loader/mt-filestore-kb.test.ts`

All commands below run in `quotemate-automation`.

- [ ] **Step 1: Write the failing tests**

Append to `mt-filestore-kb.test.ts`. Also add `kbDeleteDocument` to the existing import block at the top of the file.

```ts
describe('kbDeleteDocument', () => {
  it('DELETEs the nested store/doc path parsed from the full name', async () => {
    const f = mockOk({ deleted: true })
    await kbDeleteDocument(
      config,
      'fileSearchStores/abc/documents/xyz',
      f,
    )
    const [url, init] = (f as any).mock.calls[0]
    expect(url).toBe(
      'https://kb.example.com/v1/stores/abc/documents/xyz',
    )
    expect(init.method).toBe('DELETE')
    expect((init.headers as Headers).get('x-api-key')).toBe('test-api-key')
  })

  it('throws on a name that is not a document resource', async () => {
    const f = mockOk({})
    await expect(
      kbDeleteDocument(config, 'fileSearchStores/abc', f),
    ).rejects.toThrow(/documentName/)
    expect(f).not.toHaveBeenCalled()
  })

  it('throws KbHttpError on a non-2xx', async () => {
    const f = mockStatus(404, 'not found')
    await expect(
      kbDeleteDocument(config, 'fileSearchStores/abc/documents/x', f),
    ).rejects.toThrow(KbHttpError)
  })
})
```

- [ ] **Step 2: Run tests to verify they fail**

Run:
```bash
npx vitest run lib/admin-loader/mt-filestore-kb.test.ts
```
Expected: FAIL — `kbDeleteDocument is not exported`.

- [ ] **Step 3: Implement `kbDeleteDocument`**

Append to `lib/admin-loader/mt-filestore-kb.ts` (it can use the existing `kbFetch`, `KbHttpError`, `KbConfig`, `KbFetch`):

```ts
// ─────────────────────────────────────────────────────────────────────
// kbDeleteDocument — DELETE /v1/stores/:storeId/documents/:docId
//
// The store has no bulk replace, so the DB→KB sync deletes a table's
// prior document before/after re-uploading. Takes the full Gemini
// document resource name (as returned by kbUploadDocument) and routes
// it to mt-filestore-kb's nested delete endpoint.
// ─────────────────────────────────────────────────────────────────────

export async function kbDeleteDocument(
  config: KbConfig,
  documentName: string,
  fetchImpl: KbFetch = fetch,
): Promise<void> {
  const name = (documentName ?? '').trim()
  const m = name.match(/^fileSearchStores\/([^/]+)\/documents\/(.+)$/)
  if (!m) {
    throw new Error(
      `kbDeleteDocument: documentName must be "fileSearchStores/<storeId>/documents/<docId>", got "${documentName}"`,
    )
  }
  const [, storeId, docId] = m
  const path = `/v1/stores/${encodeURIComponent(storeId)}/documents/${encodeURIComponent(docId)}`
  const res = await kbFetch(config, path, { method: 'DELETE' }, fetchImpl)
  if (!res.ok) {
    throw new KbHttpError(res.status, path, await res.text())
  }
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run:
```bash
npx vitest run lib/admin-loader/mt-filestore-kb.test.ts
```
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add lib/admin-loader/mt-filestore-kb.ts lib/admin-loader/mt-filestore-kb.test.ts
git commit -m "feat(kb-sync): add kbDeleteDocument client"
```

---

## Task 4: QuoteMate — `export-table-csv.ts` (pure CSV + pg export)

**Files:**
- Create: `quotemate-automation/lib/kb-sync/export-table-csv.ts`
- Test: `quotemate-automation/lib/kb-sync/export-table-csv.test.ts`

- [ ] **Step 1: Write the failing tests**

Create `lib/kb-sync/export-table-csv.test.ts`:

```ts
import { describe, expect, it, vi } from 'vitest'
import {
  toCsvField,
  rowsToCsv,
  exportTableCsv,
  type PgQueryable,
} from './export-table-csv'

describe('toCsvField', () => {
  it('renders null/undefined as empty', () => {
    expect(toCsvField(null)).toBe('')
    expect(toCsvField(undefined)).toBe('')
  })
  it('quotes and escapes fields with comma/quote/newline', () => {
    expect(toCsvField('a,b')).toBe('"a,b"')
    expect(toCsvField('he said "hi"')).toBe('"he said ""hi"""')
    expect(toCsvField('line1\nline2')).toBe('"line1\nline2"')
  })
  it('JSON-stringifies objects and arrays', () => {
    expect(toCsvField({ a: 1 })).toBe('"{""a"":1}"')
    expect(toCsvField([1, 2])).toBe('"[1,2]"')
  })
  it('renders Date as ISO and Buffer as base64', () => {
    expect(toCsvField(new Date('2026-01-02T03:04:05.000Z'))).toBe(
      '2026-01-02T03:04:05.000Z',
    )
    expect(toCsvField(Buffer.from('hi'))).toBe('aGk=')
  })
})

describe('rowsToCsv', () => {
  it('emits header + rows with CRLF and trailing newline', () => {
    const csv = rowsToCsv(['id', 'name'], [{ id: 1, name: 'A,B' }])
    expect(csv).toBe('id,name\r\n1,"A,B"\r\n')
  })
})

describe('exportTableCsv', () => {
  it('uses ordinal column order and hashes the CSV', async () => {
    const db: PgQueryable = {
      query: vi.fn(async (sql: string) => {
        if (/information_schema\.columns/.test(sql)) {
          return { rows: [{ column_name: 'id' }, { column_name: 'name' }] }
        }
        return { rows: [{ id: 1, name: 'x' }] }
      }) as any,
    }
    const out = await exportTableCsv(db, 'widgets')
    expect(out.csv).toBe('id,name\r\n1,x\r\n')
    expect(out.rowCount).toBe(1)
    expect(out.hash).toMatch(/^[0-9a-f]{64}$/)
  })

  it('rejects an unsafe table name without querying', async () => {
    const db: PgQueryable = { query: vi.fn() as any }
    await expect(exportTableCsv(db, 'a; drop table x')).rejects.toThrow(
      /unsafe table name/,
    )
    expect(db.query).not.toHaveBeenCalled()
  })
})
```

- [ ] **Step 2: Run tests to verify they fail**

Run:
```bash
npx vitest run lib/kb-sync/export-table-csv.test.ts
```
Expected: FAIL — module not found.

- [ ] **Step 3: Implement the module**

Create `lib/kb-sync/export-table-csv.ts`:

```ts
// Single source of truth for turning a Postgres table into CSV.
// Used by the cron sync worker, the backfill script, and the disk-dump
// script. Uses raw pg (not supabase-js) so it isn't capped at PostgREST's
// 1000-row limit and gets true ordinal column order even for empty tables.

import { createHash } from 'node:crypto'

/** Anything with a node-postgres-shaped `query`. */
export type PgQueryable = {
  query: (sql: string, params?: unknown[]) => Promise<{ rows: any[] }>
}

export type TableCsv = {
  table: string
  csv: string
  hash: string
  rowCount: number
}

export function toCsvField(v: unknown): string {
  if (v === null || v === undefined) return ''
  let s: string
  if (Buffer.isBuffer(v)) s = v.toString('base64')
  else if (v instanceof Date) s = v.toISOString()
  else if (typeof v === 'object') s = JSON.stringify(v)
  else s = String(v)
  if (s.includes('"') || s.includes(',') || s.includes('\n') || s.includes('\r')) {
    return '"' + s.replace(/"/g, '""') + '"'
  }
  return s
}

export function rowsToCsv(
  fieldNames: string[],
  rows: Record<string, unknown>[],
): string {
  const lines = [fieldNames.map(toCsvField).join(',')]
  for (const row of rows) {
    lines.push(fieldNames.map((f) => toCsvField(row[f])).join(','))
  }
  return lines.join('\r\n') + '\r\n'
}

export async function listColumns(db: PgQueryable, table: string): Promise<string[]> {
  const { rows } = await db.query(
    `select column_name from information_schema.columns
      where table_schema = 'public' and table_name = $1
      order by ordinal_position`,
    [table],
  )
  return rows.map((r) => r.column_name as string)
}

export async function listPublicTables(db: PgQueryable): Promise<string[]> {
  const { rows } = await db.query(
    `select c.relname as t
       from pg_class c
       join pg_namespace n on n.oid = c.relnamespace
      where n.nspname = 'public' and c.relkind = 'r'
      order by c.relname`,
  )
  return rows.map((r) => r.t as string)
}

export async function exportTableCsv(db: PgQueryable, table: string): Promise<TableCsv> {
  // We must interpolate the identifier (cannot parameterize it), so guard it.
  if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(table)) {
    throw new Error(`exportTableCsv: unsafe table name "${table}"`)
  }
  const fieldNames = await listColumns(db, table)
  const { rows } = await db.query(`select * from "${table}"`)
  const csv = rowsToCsv(fieldNames, rows as Record<string, unknown>[])
  const hash = createHash('sha256').update(csv).digest('hex')
  return { table, csv, hash, rowCount: rows.length }
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run:
```bash
npx vitest run lib/kb-sync/export-table-csv.test.ts
```
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add lib/kb-sync/export-table-csv.ts lib/kb-sync/export-table-csv.test.ts
git commit -m "feat(kb-sync): pg-based table→CSV export lib with sha256"
```

---

## Task 5: QuoteMate — converge the disk-dump script onto the lib

**Files:**
- Delete: `quotemate-automation/scripts/export-tables-to-csv.mjs`
- Create: `quotemate-automation/scripts/export-tables-to-csv.ts`

This removes the duplicated CSV serializer (the `.mjs` written earlier) so there is one implementation.

- [ ] **Step 1: Replace the script**

Delete the old `.mjs` and create `scripts/export-tables-to-csv.ts`:

```ts
// QuoteMate · dump every public table to db-export/<table>.csv
// Run: node --env-file=.env.local --import tsx scripts/export-tables-to-csv.ts
//
// ⚠ Output contains real customer PII — db-export/ is gitignored.

import { writeFileSync, mkdirSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import pg from 'pg'
import { exportTableCsv, listPublicTables } from '../lib/kb-sync/export-table-csv'

const here = dirname(fileURLToPath(import.meta.url))
const outDir = join(here, '..', 'db-export')
const dbUrl = process.env.SUPABASE_DB_URL
if (!dbUrl) {
  console.error('Missing SUPABASE_DB_URL in .env.local')
  process.exit(1)
}

const c = new pg.Client({ connectionString: dbUrl, ssl: { rejectUnauthorized: false } })
try {
  await c.connect()
  mkdirSync(outDir, { recursive: true })
  const tables = await listPublicTables(c)
  console.log(`Exporting ${tables.length} table(s) → ${outDir}\n`)
  let total = 0
  for (const table of tables) {
    const { csv, rowCount } = await exportTableCsv(c, table)
    writeFileSync(join(outDir, `${table}.csv`), csv, 'utf8')
    total += rowCount
    console.log(`  ✓ ${table.padEnd(34)}${String(rowCount).padStart(7)} rows`)
  }
  console.log(`\nDone. ${tables.length} tables, ${total.toLocaleString()} rows → ${outDir}`)
} catch (err) {
  console.error('Export failed:', (err as Error).message ?? err)
  process.exit(1)
} finally {
  await c.end()
}
```

- [ ] **Step 2: Verify it runs (sandbox disabled so files persist)**

Run:
```bash
node --env-file=.env.local --import tsx scripts/export-tables-to-csv.ts
```
Expected: lists ~47 tables with row counts and `Done.`. (If the agent's shell sandboxes the FS, run un-sandboxed so files land on disk.)

- [ ] **Step 3: Commit**

```bash
git add scripts/export-tables-to-csv.ts
git rm scripts/export-tables-to-csv.mjs
git commit -m "refactor(kb-sync): disk-dump script reuses export-table-csv lib"
```

---

## Task 6: QuoteMate — migration 096 (state table + triggers)

**Files:**
- Create: `quotemate-automation/sql/migrations/096_kb_sync_state.sql`
- Create: `quotemate-automation/scripts/run-migration-096.mjs`

- [ ] **Step 1: Write the migration SQL**

Create `sql/migrations/096_kb_sync_state.sql`:

```sql
-- Migration 096 · kb_sync_state + dirty-tracking triggers on all public tables
-- Drives the DB→MT-QM-PRICING-KB CSV sync. Additive + idempotent.
-- Highest existing migration before this is 095.

create table if not exists public.kb_sync_state (
  table_name       text primary key,
  dirty            boolean not null default true,
  bumped_at        timestamptz not null default now(),
  content_hash     text,
  kb_document_name text,
  last_synced_at   timestamptz,
  last_error       text,
  row_count        integer
);

-- One generic statement-level trigger fn: marks the touched table dirty.
create or replace function public.mark_kb_table_dirty()
returns trigger
language plpgsql
as $$
begin
  insert into public.kb_sync_state (table_name, dirty, bumped_at)
  values (tg_table_name, true, now())
  on conflict (table_name) do update
    set dirty = true, bumped_at = now();
  return null;
end;
$$;

-- Attach to every base table in public (except our own bookkeeping table
-- and PostGIS's spatial_ref_sys if present). Idempotent: drop-if-exists first.
do $$
declare r record;
begin
  for r in
    select c.relname
      from pg_class c
      join pg_namespace n on n.oid = c.relnamespace
     where n.nspname = 'public' and c.relkind = 'r'
       and c.relname not in ('kb_sync_state', 'spatial_ref_sys')
  loop
    execute format('drop trigger if exists kb_sync_dirty on public.%I', r.relname);
    execute format(
      'create trigger kb_sync_dirty after insert or update or delete on public.%I '
      || 'for each statement execute function public.mark_kb_table_dirty()',
      r.relname);
    insert into public.kb_sync_state (table_name, dirty, bumped_at)
    values (r.relname, true, now())
    on conflict (table_name) do nothing;
  end loop;
end $$;

notify pgrst, 'reload schema';

do $$
declare cnt int;
begin
  select count(*) into cnt from public.kb_sync_state;
  raise notice 'Migration 096: kb_sync_state seeded with % table(s)', cnt;
end $$;
```

- [ ] **Step 2: Write the migration runner**

Create `scripts/run-migration-096.mjs` (mirrors `run-migration-040.mjs`):

```js
// QuoteMate · run migration 096 (kb_sync_state + dirty triggers)
// Usage: node --env-file=.env.local scripts/run-migration-096.mjs
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import pg from 'pg'

const { Client } = pg
const here = dirname(fileURLToPath(import.meta.url))
const sqlPath = join(here, '..', 'sql', 'migrations', '096_kb_sync_state.sql')

const dbUrl = process.env.SUPABASE_DB_URL
if (!dbUrl) {
  console.error('Missing SUPABASE_DB_URL in .env.local')
  process.exit(1)
}

const sql = readFileSync(sqlPath, 'utf8')
const c = new Client({ connectionString: dbUrl, ssl: { rejectUnauthorized: false } })

try {
  await c.connect()
  console.log(`→ Applying 096_kb_sync_state.sql (${sql.length.toLocaleString()} chars)...`)
  await c.query(sql)
  console.log('OK migration applied')

  const { rows: state } = await c.query('select count(*)::int as n from public.kb_sync_state')
  const { rows: trig } = await c.query(
    `select count(*)::int as n from pg_trigger where tgname = 'kb_sync_dirty'`,
  )
  console.log(`  ✓ kb_sync_state rows: ${state[0].n}`)
  console.log(`  ✓ kb_sync_dirty triggers attached: ${trig[0].n}`)
  if (state[0].n === 0 || trig[0].n === 0) {
    console.error('POST-VERIFY FAIL: state rows or triggers missing')
    process.exit(1)
  }
  console.log('\nOK — migration 096 verified.')
} catch (err) {
  console.error('Migration failed:', err.message ?? err)
  process.exit(1)
} finally {
  await c.end()
}
```

- [ ] **Step 3: Apply the migration to prod Supabase**

Run:
```bash
node --env-file=.env.local scripts/run-migration-096.mjs
```
Expected: `OK migration applied`, then `kb_sync_state rows: 47` (≈) and `kb_sync_dirty triggers attached: 47` (≈), then `migration 096 verified.`

- [ ] **Step 4: Commit**

```bash
git add sql/migrations/096_kb_sync_state.sql scripts/run-migration-096.mjs
git commit -m "feat(kb-sync): migration 096 kb_sync_state + dirty triggers"
```

---

## Task 7: QuoteMate — `sync.ts` flush core

**Files:**
- Create: `quotemate-automation/lib/kb-sync/sync.ts`
- Test: `quotemate-automation/lib/kb-sync/sync.test.ts`

- [ ] **Step 1: Write the failing tests**

Create `lib/kb-sync/sync.test.ts`:

```ts
import { describe, expect, it, vi } from 'vitest'
import { syncDirtyTables } from './sync'
import type { PgQueryable, TableCsv } from './export-table-csv'

function fakeDb(dirtyRows: any[]) {
  const calls: { sql: string; params?: unknown[] }[] = []
  const db: PgQueryable = {
    query: vi.fn(async (sql: string, params?: unknown[]) => {
      calls.push({ sql, params })
      if (/from kb_sync_state\s+where dirty = true/i.test(sql)) {
        return { rows: dirtyRows }
      }
      return { rows: [] }
    }) as any,
  }
  return { db, calls }
}

const kb = { url: 'https://kb.example.com', apiKey: 'k' }
const storeId = 'fileSearchStores/store1'

it('skips a table whose hash is unchanged (no upload)', async () => {
  const { db } = fakeDb([
    { table_name: 'pricing_book', bumped_at: 't1', content_hash: 'H', kb_document_name: 'd1' },
  ])
  const exportTable = vi.fn(async (): Promise<TableCsv> => ({
    table: 'pricing_book', csv: 'x', hash: 'H', rowCount: 3,
  }))
  const uploadDocument = vi.fn()
  const deleteDocument = vi.fn()
  const s = await syncDirtyTables({ db, kb, storeId, maxTables: 8, exportTable, uploadDocument, deleteDocument })
  expect(uploadDocument).not.toHaveBeenCalled()
  expect(s.skipped).toBe(1)
  expect(s.uploaded).toBe(0)
})

it('uploads a changed table then deletes the prior doc', async () => {
  const { db } = fakeDb([
    { table_name: 'shared_assemblies', bumped_at: 't1', content_hash: 'OLD', kb_document_name: 'prior-doc' },
  ])
  const exportTable = vi.fn(async (): Promise<TableCsv> => ({
    table: 'shared_assemblies', csv: 'a,b\r\n1,2\r\n', hash: 'NEW', rowCount: 1,
  }))
  const uploadDocument = vi.fn(async () => ({ name: 'new-doc' }))
  const deleteDocument = vi.fn(async () => undefined)
  const s = await syncDirtyTables({ db, kb, storeId, maxTables: 8, exportTable, uploadDocument, deleteDocument })
  expect(uploadDocument).toHaveBeenCalledOnce()
  const uploadArgs = (uploadDocument as any).mock.calls[0]
  expect(uploadArgs[1].storeId).toBe(storeId)
  expect(uploadArgs[1].displayName).toBe('db__shared_assemblies.csv')
  expect(deleteDocument).toHaveBeenCalledWith(kb, 'prior-doc')
  expect(s.uploaded).toBe(1)
})

it('isolates a per-table failure and records last_error', async () => {
  const { db, calls } = fakeDb([
    { table_name: 'quotes', bumped_at: 't1', content_hash: null, kb_document_name: null },
  ])
  const exportTable = vi.fn(async () => { throw new Error('boom') })
  const s = await syncDirtyTables({ db, kb, storeId, maxTables: 8, exportTable, uploadDocument: vi.fn(), deleteDocument: vi.fn() })
  expect(s.failed).toBe(1)
  const errUpdate = calls.find((c) => /set last_error/i.test(c.sql))
  expect(errUpdate?.params).toContain('boom')
})
```

- [ ] **Step 2: Run tests to verify they fail**

Run:
```bash
npx vitest run lib/kb-sync/sync.test.ts
```
Expected: FAIL — module not found.

- [ ] **Step 3: Implement `sync.ts`**

Create `lib/kb-sync/sync.ts`:

```ts
// Flush core for the DB→KB sync. Pure-ish: all side-effecting deps are
// injected so it unit-tests without a DB or network. The cron route and
// the backfill script call this with real pg + kb config.

import { exportTableCsv, type PgQueryable, type TableCsv } from './export-table-csv'
import {
  kbUploadDocument,
  kbDeleteDocument,
  type KbConfig,
} from '../admin-loader/mt-filestore-kb'

export type DirtyRow = {
  table_name: string
  bumped_at: string
  content_hash: string | null
  kb_document_name: string | null
}

export type SyncDeps = {
  db: PgQueryable
  kb: KbConfig
  storeId: string
  maxTables: number
  exportTable?: (db: PgQueryable, table: string) => Promise<TableCsv>
  uploadDocument?: typeof kbUploadDocument
  deleteDocument?: typeof kbDeleteDocument
}

export type SyncResult = {
  table: string
  status: 'uploaded' | 'skipped' | 'failed'
  error?: string
}

export type SyncSummary = {
  attempted: number
  uploaded: number
  skipped: number
  failed: number
  results: SyncResult[]
}

export async function syncDirtyTables(deps: SyncDeps): Promise<SyncSummary> {
  const exportTable = deps.exportTable ?? exportTableCsv
  const upload = deps.uploadDocument ?? kbUploadDocument
  const del = deps.deleteDocument ?? kbDeleteDocument

  const { rows } = await deps.db.query(
    `select table_name, bumped_at, content_hash, kb_document_name
       from kb_sync_state
      where dirty = true
      order by bumped_at asc
      limit $1`,
    [deps.maxTables],
  )
  const dirty = rows as DirtyRow[]
  const summary: SyncSummary = {
    attempted: dirty.length, uploaded: 0, skipped: 0, failed: 0, results: [],
  }

  for (const row of dirty) {
    const seq = row.bumped_at
    try {
      const { csv, hash, rowCount } = await exportTable(deps.db, row.table_name)

      if (hash === row.content_hash) {
        await deps.db.query(
          `update kb_sync_state
              set dirty = (bumped_at <> $2), last_synced_at = now(),
                  row_count = $3, last_error = null
            where table_name = $1`,
          [row.table_name, seq, rowCount],
        )
        summary.skipped++
        summary.results.push({ table: row.table_name, status: 'skipped' })
        continue
      }

      const file = new File([csv], `db__${row.table_name}.csv`, { type: 'text/csv' })
      const doc = await upload(deps.kb, {
        storeId: deps.storeId,
        file,
        displayName: `db__${row.table_name}.csv`,
      })

      // Upload-then-delete: only remove the prior doc once the new one exists.
      if (row.kb_document_name) {
        try {
          await del(deps.kb, row.kb_document_name)
        } catch (e) {
          console.warn(
            `[kb-sync] orphan: failed to delete prior doc for ${row.table_name}:`,
            e instanceof Error ? e.message : e,
          )
        }
      }

      await deps.db.query(
        `update kb_sync_state
            set content_hash = $2, kb_document_name = $3, row_count = $4,
                last_synced_at = now(), last_error = null,
                dirty = (bumped_at <> $5)
          where table_name = $1`,
        [row.table_name, hash, doc?.name ?? null, rowCount, seq],
      )
      summary.uploaded++
      summary.results.push({ table: row.table_name, status: 'uploaded' })
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e)
      await deps.db
        .query(`update kb_sync_state set last_error = $2 where table_name = $1`, [
          row.table_name,
          msg,
        ])
        .catch(() => {})
      summary.failed++
      summary.results.push({ table: row.table_name, status: 'failed', error: msg })
    }
  }
  return summary
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run:
```bash
npx vitest run lib/kb-sync/sync.test.ts
```
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add lib/kb-sync/sync.ts lib/kb-sync/sync.test.ts
git commit -m "feat(kb-sync): flush core (hash-skip, upload-then-delete, race guard)"
```

---

## Task 8: QuoteMate — cron route + move `pg` to dependencies

**Files:**
- Modify: `quotemate-automation/package.json`
- Create: `quotemate-automation/app/api/cron/kb-sync/route.ts`
- Test: `quotemate-automation/app/api/cron/kb-sync/route.test.ts`

- [ ] **Step 1: Move `pg` to dependencies**

A production route now imports `pg`, so it must be a runtime dependency. In `package.json`, remove `"pg": "^8.20.0"` from `devDependencies` and add it to `dependencies` (keep `@types/pg` in devDependencies). Then:

```bash
npm install
```
Expected: lockfile updates, no errors.

- [ ] **Step 2: Write the failing tests (auth + config guards)**

Create `app/api/cron/kb-sync/route.test.ts`:

```ts
import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest'

// after() must be a no-op in tests (we only assert the guard responses).
vi.mock('next/server', () => ({ after: (_fn: unknown) => {} }))

import { GET } from './route'

const OLD = { ...process.env }
beforeEach(() => {
  process.env.NODE_ENV = 'production'
  process.env.CRON_SECRET = 'secret'
  process.env.SUPABASE_DB_URL = 'postgres://x'
  process.env.KB_PRICING_STORE_ID = 'fileSearchStores/s'
  process.env.KB_API_URL = 'https://kb'
  process.env.KB_API_KEY = 'k'
})
afterEach(() => {
  process.env = { ...OLD }
  vi.restoreAllMocks()
})

it('401s without the Bearer secret in production', async () => {
  const res = await GET(new Request('https://app/api/cron/kb-sync'))
  expect(res.status).toBe(401)
})

it('accepts with the correct Bearer and returns accepted', async () => {
  const res = await GET(
    new Request('https://app/api/cron/kb-sync', {
      headers: { authorization: 'Bearer secret' },
    }),
  )
  expect(res.status).toBe(200)
  const body = await res.json()
  expect(body.ok).toBe(true)
  expect(body.accepted).toBe(true)
})

it('503s when KB_PRICING_STORE_ID is missing', async () => {
  delete process.env.KB_PRICING_STORE_ID
  const res = await GET(
    new Request('https://app/api/cron/kb-sync', {
      headers: { authorization: 'Bearer secret' },
    }),
  )
  expect(res.status).toBe(503)
})
```

- [ ] **Step 3: Run tests to verify they fail**

Run:
```bash
npx vitest run app/api/cron/kb-sync/route.test.ts
```
Expected: FAIL — route module not found.

- [ ] **Step 4: Implement the route**

Create `app/api/cron/kb-sync/route.ts`:

```ts
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
```

- [ ] **Step 5: Run tests to verify they pass**

Run:
```bash
npx vitest run app/api/cron/kb-sync/route.test.ts
```
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add package.json package-lock.json app/api/cron/kb-sync/route.ts app/api/cron/kb-sync/route.test.ts
git commit -m "feat(kb-sync): /api/cron/kb-sync worker; pg→dependencies"
```

---

## Task 9: QuoteMate — backfill / manual reconcile script

**Files:**
- Create: `quotemate-automation/scripts/kb-sync-once.ts`

- [ ] **Step 1: Write the script**

Create `scripts/kb-sync-once.ts`:

```ts
// QuoteMate · run the DB→KB sync once from the CLI (backfill / reconcile).
// Loops until no dirty tables remain (each pass is bounded by maxTables).
// Run: node --env-file=.env.local --import tsx scripts/kb-sync-once.ts
//   --all   first mark every table dirty (full re-sync)

import pg from 'pg'
import { loadKbConfigFromEnv } from '../lib/admin-loader/mt-filestore-kb'
import { syncDirtyTables } from '../lib/kb-sync/sync'

const dbUrl = process.env.SUPABASE_DB_URL
const storeId = process.env.KB_PRICING_STORE_ID
if (!dbUrl || !storeId) {
  console.error('Missing SUPABASE_DB_URL or KB_PRICING_STORE_ID in .env.local')
  process.exit(1)
}
const kb = loadKbConfigFromEnv()
const maxTables = Number(process.env.KB_SYNC_MAX_TABLES_PER_RUN ?? '8') || 8
const markAll = process.argv.includes('--all')

const c = new pg.Client({ connectionString: dbUrl, ssl: { rejectUnauthorized: false } })
try {
  await c.connect()
  if (markAll) {
    await c.query('update kb_sync_state set dirty = true, bumped_at = now()')
    console.log('Marked all tables dirty.')
  }
  let pass = 0
  for (;;) {
    pass++
    const s = await syncDirtyTables({ db: c, kb, storeId, maxTables })
    console.log(`pass ${pass}:`, s)
    if (s.attempted === 0) break
    if (s.uploaded === 0 && s.failed === s.attempted) {
      console.error('All remaining tables are failing — stopping to avoid a loop.')
      break
    }
  }
  console.log('Backfill complete.')
} catch (err) {
  console.error('kb-sync-once failed:', (err as Error).message ?? err)
  process.exit(1)
} finally {
  await c.end()
}
```

- [ ] **Step 2: Type-check the script compiles**

Run:
```bash
npx tsc --noEmit lib/kb-sync/sync.ts lib/kb-sync/export-table-csv.ts scripts/kb-sync-once.ts
```
Expected: no errors. (If `tsc` flags missing libs from isolated invocation, instead run the project check: `npx tsc --noEmit -p tsconfig.json` and expect no new errors.)

- [ ] **Step 3: Commit**

```bash
git add scripts/kb-sync-once.ts
git commit -m "feat(kb-sync): backfill/reconcile CLI script"
```

> Do **not** run the backfill yet — it uploads to the live store and needs the redeployed delete endpoint + prod env (Task 10).

---

## Task 10: Config, docs, and rollout

**Files:**
- Modify: `quotemate-automation/.env.local`
- Modify: `quotemate-automation/CLAUDE.md` (or `quotemate-automation/AGENTS.md` reference) — short note
- Create: `quotemate-automation/docs/kb-sync.md`

- [ ] **Step 1: Add local env vars**

Append to `.env.local` (do NOT commit this file — it is gitignored):

```
KB_PRICING_STORE_ID=fileSearchStores/mtqmpricingkb-o95jk3es162t
KB_SYNC_MAX_TABLES_PER_RUN=8
```

Confirm `SUPABASE_DB_URL`, `KB_API_URL`, `KB_API_KEY`, `CRON_SECRET` already have real (non-blank) values.

- [ ] **Step 2: Write the ops doc**

Create `docs/kb-sync.md`:

```markdown
# DB → MT-QM-PRICING-KB sync

Triggers (`kb_sync_dirty`) on every public table set `kb_sync_state.dirty=true`
on any change. cron-job.org calls `/api/cron/kb-sync` every 5 min; the worker
re-exports dirty tables to CSV and replaces `db__<table>.csv` in the store
(`KB_PRICING_STORE_ID`). Unchanged tables (same sha256) are skipped.

## Env (Vercel prod + .env.local)
- SUPABASE_DB_URL  (pooler URL recommended for serverless)
- KB_API_URL, KB_API_KEY
- KB_PRICING_STORE_ID=fileSearchStores/mtqmpricingkb-o95jk3es162t
- KB_SYNC_MAX_TABLES_PER_RUN=8
- CRON_SECRET

## cron-job.org job
- URL: https://quote-mate-rho.vercel.app/api/cron/kb-sync  (GET)
- Schedule: */5 * * * *
- Header: Authorization: Bearer <CRON_SECRET>
- Enable failure notifications.

## Ops
- Full re-sync / backfill: `node --env-file=.env.local --import tsx scripts/kb-sync-once.ts --all`
- Inspect state: `select table_name, dirty, last_synced_at, last_error, row_count from kb_sync_state order by bumped_at desc;`

## Caveats
- All 47 tables sync, incl. customer PII (explicit decision — see spec §2/§9).
- High-churn tables (sms_messages, pipeline_traces, quotes) re-embed on most
  ticks; tune cadence / KB_SYNC_MAX_TABLES_PER_RUN if cost is high.
```

- [ ] **Step 3: Commit**

```bash
git add docs/kb-sync.md
git commit -m "docs(kb-sync): ops + env + cron-job.org setup"
```

- [ ] **Step 4: OPERATOR — redeploy `mt-filestore-kb` to Railway**

In the `mt-filestore-kb` repo: commit (done in Tasks 1–2), push, and trigger the Railway deploy. Verify the new route is live:
```bash
curl -i -X DELETE "https://mt-filestore-kb-production.up.railway.app/v1/stores/mtqmpricingkb-o95jk3es162t/documents/__nonexistent__" -H "x-api-key: <KB_API_KEY>"
```
Expected: a 4xx/5xx from Gemini (NOT a 404 "Cannot DELETE" from Nest) — confirms the route exists.

- [ ] **Step 5: OPERATOR — set Vercel prod env vars**

In Vercel project settings add/confirm (production): `SUPABASE_DB_URL` (pooler), `KB_API_URL`, `KB_API_KEY`, `CRON_SECRET`, `KB_PRICING_STORE_ID`, `KB_SYNC_MAX_TABLES_PER_RUN`. Redeploy QuoteMate so the new route + env are live.

- [ ] **Step 6: Backfill the store**

Once the delete endpoint is live and prod env is set, run locally:
```bash
node --env-file=.env.local --import tsx scripts/kb-sync-once.ts --all
```
Expected: passes report `uploaded` counts; ends with `Backfill complete.` Verify in the store: ~47 `db__*.csv` docs, and the 2 original PDFs untouched.

- [ ] **Step 7: OPERATOR — create the cron-job.org job**

Per `docs/kb-sync.md`: GET prod `/api/cron/kb-sync`, `*/5 * * * *`, `Authorization: Bearer <CRON_SECRET>`, failure alerts on. Watch a few ticks; mutate one row (e.g. add a `tenant_service_offerings` row) and confirm only that table re-uploads on the next run.

- [ ] **Step 8: Open the PR**

```bash
git push -u origin feat/kb-sync
gh pr create --fill
```

---

## Self-Review

**Spec coverage:**
- §2 all-47 incl PII → Task 6 trigger loop covers every public base table; §9 caveat documented (Task 10 doc). ✓
- §2 hybrid trigger → Task 6 in-DB dirty triggers + Task 8 cron worker. ✓
- §2 5-min via cron-job.org → Task 10 job. ✓
- §2 hash detection → Task 4 sha256 + Task 7 skip path. ✓
- §2/§5.4 upload-then-delete + delete endpoint → Tasks 1–3, 7. ✓
- §5.1 kb_sync_state + fn + attach + seed → Task 6. ✓
- §5.2 shared CSV lib + script convergence → Tasks 4, 5. ✓
- §5.3 kbDeleteDocument → Task 3. ✓
- §5.5 worker (auth, maxDuration, after, cap, per-table isolation, race guard) → Tasks 7, 8. ✓
- §5.6 backfill script → Task 9. ✓
- §5.7 env → Task 10. ✓
- §6 failure/idempotency (crash, write-during-flush, no-op, orphan) → Task 7 logic + tests. ✓
- §7 Vercel Pro / maxDuration=300 → Task 8. ✓

**Placeholder scan:** No TBD/TODO; every code step has full code; commands have expected output. ✓

**Type consistency:** `PgQueryable`/`TableCsv` defined in Task 4 and imported in Tasks 5/7/9; `syncDirtyTables`/`SyncDeps`/`SyncSummary` defined in Task 7 and used in Tasks 8/9; `kbDeleteDocument` signature `(config, documentName, fetchImpl?)` consistent across Tasks 3/7; `db__<table>.csv` displayName consistent in Task 7 logic + test. ✓

**Known follow-ups (out of scope, noted):** quoting-pipeline grounding consumer (spec §1); optional `scripts/kb-prune-orphans.mjs` (spec §6); optional DDL event-trigger to auto-attach to future tables (spec §5.1).
