-- POLITICORE — MIGRATION 0030: PUBLIC PERMISSION-GRANTS VIEW.
--
-- Core Identity/Auth Phase 1 prerequisite. The client AuthContext loads
-- the caller's own permission grants through the hosted PostgREST data
-- API, which exposes the public schema only. politicore.permission_grants
-- already has self-read RLS (0002: user_id = auth.uid() OR tenant admin)
-- but had no public security_invoker view — the same gap 0009 closed for
-- profiles. This view mirrors that ratified pattern exactly:
--
--   * security_invoker = true  → RLS decides visibility (own rows only
--     for non-admins; granted:false denials included, never filtered);
--   * SELECT-only grant        → the API surface stays read-only;
--   * anon revoked             → grants are never public.
--
-- Read-only by design: grant administration remains the admin path on
-- the base table (0002 grants_admin). No base-table change. No new
-- authorization resolver — this only exposes the existing RLS contract.

CREATE OR REPLACE VIEW public.permission_grants
  WITH (security_invoker = true) AS SELECT * FROM politicore.permission_grants;

REVOKE ALL ON public.permission_grants FROM anon;
GRANT SELECT ON public.permission_grants TO authenticated;
