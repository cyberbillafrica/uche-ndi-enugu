-- =====================================================================
-- 0009: POSTGREST VIEWS + REALTIME REGISTRATION (Phase 1B vertical slice)
--
-- The hosted data API (PostgREST) exposes the `public` schema only, and
-- project db_schema config cannot be changed from this repository. These
-- thin SECURITY INVOKER views expose the politicore tables the vertical
-- slice needs. security_invoker means the BASE TABLE RLS policies apply
-- exactly as before — the views add zero authorization of their own.
-- (Simple single-table views are auto-updatable, so INSERT/UPDATE flow
-- through to the base table with RLS enforced.)
--
-- Also registers notifications for Supabase Realtime (postgres_changes).
-- =====================================================================

-- Identity (own row + same-tenant directory per profiles RLS)
CREATE OR REPLACE VIEW public.politicore_profiles
  WITH (security_invoker = true) AS SELECT * FROM politicore.profiles;

-- Tenancy context
CREATE OR REPLACE VIEW public.tenants
  WITH (security_invoker = true) AS SELECT * FROM politicore.tenants;
CREATE OR REPLACE VIEW public.tenant_modules
  WITH (security_invoker = true) AS SELECT * FROM politicore.tenant_modules;
CREATE OR REPLACE VIEW public.public_site_settings
  WITH (security_invoker = true) AS SELECT * FROM politicore.public_site_settings;

-- Notifications (per-user rows; policies unchanged)
CREATE OR REPLACE VIEW public.notifications
  WITH (security_invoker = true) AS SELECT * FROM politicore.notifications;

-- Geography reference (world-readable per Phase 1A policies)
CREATE OR REPLACE VIEW public.states
  WITH (security_invoker = true) AS SELECT * FROM politicore.states;
CREATE OR REPLACE VIEW public.senatorial_zones
  WITH (security_invoker = true) AS SELECT * FROM politicore.senatorial_zones;
CREATE OR REPLACE VIEW public.lgas
  WITH (security_invoker = true) AS SELECT * FROM politicore.lgas;
CREATE OR REPLACE VIEW public.wards
  WITH (security_invoker = true) AS SELECT * FROM politicore.wards;
CREATE OR REPLACE VIEW public.polling_units
  WITH (security_invoker = true) AS SELECT * FROM politicore.polling_units;

-- View grants mirror the base-table grants (explicit per view).
GRANT SELECT ON public.politicore_profiles TO anon, authenticated, service_role;
GRANT SELECT, INSERT, UPDATE, DELETE ON public.politicore_profiles TO authenticated, service_role;
GRANT SELECT ON public.tenants TO anon, authenticated, service_role;
GRANT SELECT ON public.tenant_modules TO anon, authenticated, service_role;
GRANT SELECT, INSERT, UPDATE, DELETE ON public.tenant_modules TO authenticated, service_role;
GRANT SELECT ON public.public_site_settings TO anon, authenticated, service_role;
GRANT SELECT, INSERT, UPDATE, DELETE ON public.notifications TO authenticated, service_role;
GRANT SELECT ON public.notifications TO anon, authenticated, service_role;
GRANT SELECT ON public.states TO anon, authenticated, service_role;
GRANT SELECT ON public.senatorial_zones TO anon, authenticated, service_role;
GRANT SELECT ON public.lgas TO anon, authenticated, service_role;
GRANT SELECT ON public.wards TO anon, authenticated, service_role;
GRANT SELECT ON public.polling_units TO anon, authenticated, service_role;

-- Realtime: notifications per-user push (postgres_changes). Guarded — the
-- publication exists only on hosted Supabase; local pglite skips this.
DO $rt$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_publication WHERE pubname = 'supabase_realtime')
     AND NOT EXISTS (
       SELECT 1 FROM pg_publication_tables
       WHERE pubname = 'supabase_realtime'
         AND schemaname = 'politicore' AND tablename = 'notifications'
     ) THEN
    ALTER PUBLICATION supabase_realtime ADD TABLE politicore.notifications;
  END IF;
END
$rt$;
