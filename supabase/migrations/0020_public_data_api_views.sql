-- =====================================================================
-- 0020: PUBLIC DATA-API VIEWS FOR ELECTION (hosted data API convention)
--
-- The hosted Supabase data API (PostgREST) exposes the `public` schema
-- ONLY (project db_schema config is platform-managed; 0009 documents
-- this and established the convention for Phase 1B slices). The Phase 2
-- Election service layer was initially written against schema-qualified
-- politicore.* targets, which the hosted API rejects with
-- "Invalid schema: politicore" — caught by the Phase 2 lock-gate hosted
-- smoke test.
--
-- This migration follows 0009 exactly: thin SECURITY INVOKER views over
-- the Election base tables. security_invoker means the base-table RLS
-- policies apply unchanged — the views add zero authorization of their
-- own and cannot widen access. View grants mirror the base-table grants
-- (0014/0018). pu_reports/election_incidents remain client-insertable
-- THROUGH THE VIEW exactly as at the base table; results/votes/history
-- remain RPC-only; political_parties remains platform-managed.
-- =====================================================================

-- Election configuration (admin-writable via set_active_election RPC;
-- direct row writes flow RLS admin policies, as at the base table)
CREATE OR REPLACE VIEW public.election_cycles
  WITH (security_invoker = true) AS SELECT * FROM politicore.election_cycles;
CREATE OR REPLACE VIEW public.election_contests
  WITH (security_invoker = true) AS SELECT * FROM politicore.election_contests;
CREATE OR REPLACE VIEW public.election_candidates
  WITH (security_invoker = true) AS SELECT * FROM politicore.election_candidates;
CREATE OR REPLACE VIEW public.election_settings
  WITH (security_invoker = true) AS SELECT * FROM politicore.election_settings;

-- Platform party master (platform-admin-writable; tenants read only)
CREATE OR REPLACE VIEW public.political_parties
  WITH (security_invoker = true) AS SELECT * FROM politicore.political_parties;

-- Operational surfaces the application reads and (reports/incidents)
-- inserts into; election_results/votes/history stay RPC-only at the
-- base tables, so the history view is deliberately SELECT-only.
CREATE OR REPLACE VIEW public.pu_reports
  WITH (security_invoker = true) AS SELECT * FROM politicore.pu_reports;
CREATE OR REPLACE VIEW public.election_incidents
  WITH (security_invoker = true) AS SELECT * FROM politicore.election_incidents;
CREATE OR REPLACE VIEW public.election_result_history
  WITH (security_invoker = true) AS SELECT * FROM politicore.election_result_history;

-- View grants mirror the base-table grants (0014 lines 553-566,
-- 0018 lines 118-119). RLS remains the authorization boundary.
GRANT SELECT ON public.election_cycles, public.election_contests,
  public.election_candidates, public.election_settings,
  public.political_parties, public.election_result_history
  TO anon, authenticated, service_role;
GRANT SELECT, INSERT, UPDATE, DELETE ON public.pu_reports,
  public.election_incidents TO authenticated, service_role;
-- election_cycles/contests/candidates/settings: admin writes flow the
-- base RLS policies (no new privilege — authenticated already holds
-- INSERT/UPDATE/DELETE on the base tables; policies decide).
GRANT INSERT, UPDATE, DELETE ON public.election_cycles,
  public.election_contests, public.election_candidates,
  public.election_settings TO authenticated, service_role;
