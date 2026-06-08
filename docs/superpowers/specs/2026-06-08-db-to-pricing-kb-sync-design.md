# Design — Automatic DB→Pricing-KB CSV sync

> Status: **approved design, pending spec review** · Author: Jeph (via Claude) · Date: 2026-06-08
> Topic: keep the Gemini File Search store **MT-QM-PRICING-KB** (`fileSearchStores/mtqmpricingkb-o95jk3es162t`) automatically in sync with the QuoteMate Supabase database, one CSV document per table, refreshed whenever a table changes.

## 1. Goal

When **any** row in **any** of the QuoteMate `public` tables changes (a tradie adds catalogue items, a new tradie is onboarded, an import commits, a webhook writes — from *any* source), the affected table is re-exported to CSV and that CSV replaces the table's document in the MT-QM-PRICING-KB Gemini File Search store. The store is consumed both by (a) the `mt-filestore-kb` console/agent for human pricing Q&A and (b) — as a follow-on — the QuoteMate quoting pipeline for grounding. The KB therefore always reflects the live DB.

## 2. Decisions locked in (from brainstorming, 2026-06-08)

| Decision | Choice | Notes |
|---|---|---|
| Consumer | **Both** — KB console/agent Q&A **and** quoting-pipeline grounding | Grounding wiring is a later phase; this spec delivers the sync. |
| Table scope | **All 47 `public` base tables**, including PII | See §9 risk note. |
| PII | **Explicitly accepted** | User gave informed consent that customer names/phones/emails/addresses and full SMS chat logs (`customers`, `intakes`, `sms_conversations`, `sms_messages`, `calls`) are uploaded to Gemini and **may be retained/indexed even after deletion**. Recorded here on the record. |
| Trigger | **Hybrid** — in-DB triggers mark a table dirty instantly; a cron flushes dirty tables | "Event" half implemented as cheap in-DB dirty flags (not HTTP webhooks). |
| Cadence | **Every 5 minutes via cron-job.org** | External HTTP scheduler hits the endpoint — no Vercel-Pro cron needed. Tunable in the cron-job.org dashboard; see §7. |
| Replace semantics | **Upload-new-then-delete-old** per table | Requires a new delete endpoint on `mt-filestore-kb` (§5). |
| Change detection | **sha256 content hash per table** | Uniform across all 47 tables; no `updated_at` dependency; skips no-op re-uploads. |

## 3. Non-goals

- Wiring the quoting pipeline to read this KB (separate follow-on phase).
- Per-tenant store partitioning (single shared store for v1).
- Streaming / row-level deltas inside a document (we replace the whole table CSV).
- Touching the 2 PDF documents already in the store (we only ever delete documents we created, tracked by name).

## 4. Architecture & data flow

```
ANY write to any of the 47 public tables
        │  Postgres AFTER INSERT/UPDATE/DELETE  (FOR EACH STATEMENT)
        ▼
  mark_kb_table_dirty()  →  kb_sync_state: dirty=true, bumped_at=now()
        │
        ▼  cron-job.org every 5 min → GET /api/cron/kb-sync (Bearer CRON_SECRET)
  flush worker (heavy work in next/server after()):
     pick dirty tables, bounded to KB_SYNC_MAX_TABLES_PER_RUN per run
     for each:
        1. capture seq = bumped_at
        2. SELECT * → CSV   (lib/kb-sync/export-table-csv.ts)
        3. hash = sha256(csv); if hash == content_hash → clear dirty, skip
        4. kbUploadDocument(store, csv, displayName=`db__<table>.csv`)  → newDoc.name
        5. if prior kb_document_name: kbDeleteDocument(prior)   (upload-then-delete: no gap)
        6. kb_sync_state ← {content_hash, kb_document_name:newDoc.name, last_synced_at, row_count, last_error:null}
        7. clear dirty ONLY if bumped_at still == seq (else a write landed mid-flush → stay dirty for next tick)
     on per-table error: stamp last_error, leave dirty=true, continue
        │
        ▼
  MT-QM-PRICING-KB
     ├─ db__<table>.csv   × up to 47   (managed by this sync)
     └─ <2 existing PDFs>               (untouched)
```

### Why in-DB triggers, not HTTP webhooks
An `AFTER ... FOR EACH STATEMENT` trigger that flips a boolean is transactional (cannot be missed even on direct SQL writes), needs no `pg_net`/HTTP, and adds negligible write latency. Statement-level means a 500-row bulk import fires the trigger **once**, not 500×. The cron is the only component that calls Gemini, so high-churn tables can't create an upload storm — they simply get re-uploaded at most once per tick.

## 5. Components

### 5.1 DB migration — `sql/migrations/096_kb_sync_state.sql` (+ `scripts/run-migration-096.mjs`)
- `create table kb_sync_state (table_name text primary key, dirty boolean not null default true, bumped_at timestamptz not null default now(), content_hash text, kb_document_name text, last_synced_at timestamptz, last_error text, row_count integer)`.
- `mark_kb_table_dirty()` trigger function: `insert into kb_sync_state(table_name, dirty, bumped_at) values (TG_TABLE_NAME, true, now()) on conflict (table_name) do update set dirty=true, bumped_at=now();` then `return null`.
- A `DO $$` loop over `information_schema.tables` (schema `public`, `BASE TABLE`, excluding `kb_sync_state` itself) creates `after insert or update or delete on <t> for each statement execute function mark_kb_table_dirty()` for each.
- Seed one `kb_sync_state` row per table with `dirty=true` so the first cron run backfills everything.
- Idempotent + additive; follows the migration conventions in CLAUDE.md. Highest existing migration is 095 (confirmed) → this is **096**.
- *(Optional, deferred)* an `event_trigger on ddl_command_end` to auto-attach the trigger to future `CREATE TABLE`s — noted, not built in v1.

### 5.2 CSV export library — `lib/kb-sync/export-table-csv.ts`
Refactor the working logic from `scripts/export-tables-to-csv.mjs` into a pure, tested module: `exportTableCsv(client, tableName) → { csv, hash, rowCount }`. CSV rules unchanged (CRLF, quote-when-needed, jsonb/array→JSON, Date→ISO, bytea→base64, null→empty). `scripts/export-tables-to-csv.mjs` is rewritten to import this — single source of truth, no drift.

### 5.3 KB client addition — `lib/admin-loader/mt-filestore-kb.ts`
Add `kbDeleteDocument(config, documentName, fetchImpl?)`. It parses `storeId` and `docId` out of the full document resource name (`fileSearchStores/<storeId>/documents/<docId>`) and calls the nested route from §5.4: `DELETE /v1/stores/<storeId>/documents/<docId>`. Mirrors existing error handling (`KbHttpError`, never throws on 4xx/5xx beyond the typed error).

### 5.4 `mt-filestore-kb` service change (cross-repo, `C:/Users/dalig/Downloads/QuoteMate/mt-filestore-kb`)
- `GeminiService.deleteDocument(documentName, apiKey?)` → `this.http.delete(`${baseUrl}/${documentName}`, { params: { key } })`. The document `name` is already a full `fileSearchStores/<id>/documents/<docId>` path.
- Controller route: `DELETE /v1/stores/:storeId/documents/:docId` → reconstructs `fileSearchStores/{storeId}/documents/{docId}` and calls `deleteDocument`. (Matches the existing nested documents route shape.)
- Unit test alongside `gemini.service.spec.ts`.
- **Operational dependency: redeploy the Railway service** before the QuoteMate cron's delete calls will work. Until then, the worker still uploads (replace degrades to append — flagged in logs).

### 5.5 Flush worker — `app/api/cron/kb-sync/route.ts`
- Reuses the `isAuthorised(req)` Bearer-`CRON_SECRET` pattern verbatim from `sms-cleanup/route.ts` (required in prod, lenient in dev). Triggered by **cron-job.org**, configured to send `Authorization: Bearer <CRON_SECRET>` as a custom request header.
- `export const dynamic = 'force-dynamic'`; `export const maxDuration = 300` (Pro/Railway — see §7).
- Fast-ack then heavy work in `after()` per the repo's webhook convention; returns a summary `{ ok, attempted, uploaded, skipped, failed }`.
- Sequential per-table processing (Gemini rate-limits; the service already retries 429s); bounded by `KB_SYNC_MAX_TABLES_PER_RUN` (default 8). Leftover dirty tables flush on the next tick.
- Per-table try/catch: failure stamps `last_error`, leaves `dirty=true`, never aborts the batch.

### 5.6 Manual/backfill script — `scripts/kb-sync-once.mjs`
Run with `node --env-file=.env.local scripts/kb-sync-once.mjs [--table X] [--all]`. Performs the same flush logic outside the cron for first backfill, reconciliation, and ops. Also used to seed the store initially without waiting on cron ticks.

### 5.7 Config — `.env.local` / Vercel env
- Reuse `KB_API_URL` / `KB_API_KEY`.
- Add `KB_PRICING_STORE_ID=fileSearchStores/mtqmpricingkb-o95jk3es162t`.
- Add `KB_SYNC_MAX_TABLES_PER_RUN=8`.
- Reuse existing `CRON_SECRET`.

### 5.8 Scheduler — cron-job.org (external)
No `vercel.json` cron entry. Instead, a cron-job.org job:
- **URL:** `https://quote-mate-rho.vercel.app/api/cron/kb-sync` (prod) — method GET.
- **Schedule:** every 5 minutes (`*/5`).
- **Header:** `Authorization: Bearer <CRON_SECRET>`.
- **Request timeout:** set generously (cron-job.org allows up to its max); but the endpoint is designed to **fast-ack** (return ~immediately) and do the upload work in `after()`, so cron-job.org gets a quick 200 regardless of indexing time.
- Enable cron-job.org failure notifications so a broken sync is visible.

## 6. Failure handling & idempotency
- **Crash mid-flush:** dirty flag only cleared after a fully successful upload+state-write, so an interrupted table stays dirty and retries next tick.
- **Write during flush:** `bumped_at` comparison (step 7) means a row written while we were exporting keeps the table dirty → re-synced next tick. No lost updates.
- **No-op writes:** content hash unchanged → no upload, just clear dirty. Protects against re-embedding cost when a statement touched but didn't change CSV-relevant data.
- **Delete-endpoint not yet deployed:** upload still succeeds; old doc not removed → transient duplicate documents. Worker logs a warning; cleaned up once the service is redeployed and the next change re-runs replace. A `scripts/kb-prune-orphans.mjs` (optional) can list+delete `db__*` docs not in `kb_sync_state`.
- **Gemini 429 / indexing slowness:** handled inside `mt-filestore-kb` (retry w/ backoff, poll to completion). Worker-side timeout bounded by `maxDuration` + per-run table cap.

## 7. Platform (resolved)
Two constraints; both handled, no open decision.

**(a) Scheduling — cron-job.org.** Calls `/api/cron/kb-sync` every 5 min on the free tier with a custom `Authorization` header. Independent of the QuoteMate host plan.

**(b) Execution time — fine on the current plan.** QuoteMate prod (`quote-mate-rho.vercel.app`) runs on **Vercel Pro**: ~25 routes set `export const maxDuration = 300` and the app is live end-to-end, which Hobby's 10–60s cap could not run. Decisively, `app/api/admin/loader/trade-book/upload/route.ts` (`maxDuration = 300`) already performs the exact pattern this worker needs — a blocking upload to `mt-filestore-kb` that polls Gemini to completion — and works in prod. So the **synchronous design (§5.5) is used as-is**, with `export const maxDuration = 300` on the cron route and `KB_SYNC_MAX_TABLES_PER_RUN` (default 8) sized so a run stays well under 300s; fast-ack + `after()` keeps cron-job.org's request short regardless.

The two-phase async-upload variant is therefore **not needed** and is dropped — noted only as the path we'd take if the worker were ever moved to a tight-budget host (Vercel Hobby): an `?async=true` upload mode on `mt-filestore-kb` that returns the operation name without polling, plus an `indexing` state resolved on a later tick.

## 8. Testing
- Unit: `export-table-csv.ts` (escaping, jsonb, nulls, hash stability) — port existing assertions.
- Unit: `kbDeleteDocument` (URL/headers/error shapes) — extend `mt-filestore-kb.test.ts`.
- Unit (mt-filestore-kb repo): `GeminiService.deleteDocument` happy/error paths.
- Integration (mocked fetch): flush worker — dirty selection, hash-skip, upload→delete order, bumped_at race keeps dirty, per-table error isolation, per-run cap.
- Manual: `scripts/kb-sync-once.mjs --all` against the live store → verify 47 `db__*.csv` docs appear and the 2 PDFs are untouched; mutate one row → confirm only that table re-uploads next run.

## 9. Risks (acknowledged)
- **Recurring Gemini cost / churn:** `sms_messages`, `pipeline_traces`, `quotes` change constantly while the app is active → re-upload+re-embed most ticks. Hashing + per-run cap limit but don't remove this; it is the dominant cost of "all 47 tables." Tunable via cadence and `KB_SYNC_MAX_TABLES_PER_RUN`.
- **PII to Gemini:** accepted (§2); may persist after deletion.
- **Retrieval quality:** mixing chat logs/traces into a *pricing* KB dilutes precision for the stated pricing Q&A + grounding goal. Mitigated only by scope, which the user chose to keep at all-47. Future option: a metadata tag (`kind=pricing|operational`) on each doc + a `metadataFilter` at query time to scope reads.

## 10. Rollout
1. mt-filestore-kb: add `deleteDocument` + route, test, **redeploy Railway**.
2. QuoteMate: migration 096 (state table + triggers), `export-table-csv.ts`, `kbDeleteDocument`, cron route, backfill script, env vars, `vercel.json`.
3. Create the cron-job.org job: GET prod `/api/cron/kb-sync`, every 5 min, header `Authorization: Bearer <CRON_SECRET>`, failure alerts on.
4. Run `scripts/kb-sync-once.mjs --all` to backfill; verify store contents.
5. Enable the cron; watch logs for a few ticks; verify churn/cost is acceptable, retune cadence/cap.
```
