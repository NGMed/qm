-- Migration 103 · Solar AI "panels installed" concept preview
--
-- Adds the storage path + generation status for the Gemini-rendered
-- "roof with the quoted panels installed" concept image shown beside the
-- REAL satellite hero on /q/solar/[token]. The satellite_image_url
-- contract is untouched: it stays a real photo (spec §1, §6); the AI
-- concept lives in its own clearly-labelled column pair.
--
-- panels_image_status lifecycle: idle → generating → ready | failed
-- (CAS-claimed by lib/solar/panels-after.ts so concurrent triggers don't
-- double-render; mirrors roofing_measurements.preview_status).

alter table public.solar_estimates
  add column if not exists panels_image_path text,
  add column if not exists panels_image_status text not null default 'idle';

grant all on table public.solar_estimates to service_role;

-- Keep PostgREST/Supabase Data API in sync for immediate local dev writes.
notify pgrst, 'reload schema';

do $$
declare
  has_path   boolean;
  has_status boolean;
begin
  select exists (
    select 1 from information_schema.columns
     where table_schema = 'public'
       and table_name = 'solar_estimates'
       and column_name = 'panels_image_path'
  ) into has_path;

  select exists (
    select 1 from information_schema.columns
     where table_schema = 'public'
       and table_name = 'solar_estimates'
       and column_name = 'panels_image_status'
  ) into has_status;

  raise notice 'Migration 103: solar_estimates.panels_image_path=%, panels_image_status=%',
    has_path, has_status;
end $$;
