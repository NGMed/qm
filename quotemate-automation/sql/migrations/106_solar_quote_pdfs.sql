-- Migration 106 · Solar quote PDFs (Gotenberg)
--
-- Brings solar to PDF parity with electrical / plumbing (mig 105) and
-- roofing: the confirmed solar estimate now ships with a Gotenberg-rendered
-- PDF — a download link on the /q/solar/[token] page + in the customer SMS,
-- on-demand (re)generation via /api/q/solar/[token]/pdf, and a best-effort
-- MMS attachment of the document on the tradie-confirm send.
--
--   solar_estimates.pdf_path — storage path of the rendered solar quote PDF
--                              (quote-pdfs bucket: solar/<public_token>.pdf),
--                              null until first generated; regenerated on
--                              re-confirm / edit.
--
-- Reuses the existing `quote-pdfs` bucket (created by
-- scripts/create-quote-pdfs-bucket.mjs) — no new bucket required.
--
-- Idempotent. Apply with:
--   node --env-file=.env.local scripts/run-migration-106.mjs

alter table public.solar_estimates
  add column if not exists pdf_path text;

notify pgrst, 'reload schema';

-- ── Verification ─────────────────────────────────────────────────────
do $$
declare
  solar_ok boolean;
begin
  select exists (select 1 from information_schema.columns
                  where table_schema='public' and table_name='solar_estimates'
                    and column_name='pdf_path') into solar_ok;
  raise notice 'Migration 106: solar_estimates.pdf_path=%', solar_ok;
end $$;
