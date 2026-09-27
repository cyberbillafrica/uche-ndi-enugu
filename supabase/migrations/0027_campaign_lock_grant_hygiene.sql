-- =====================================================================
-- 0027: FINAL CAMPAIGN LOCK GATE — GRANT HYGIENE (§21)
--
-- The Final Campaign Lock Gate's hosted privilege audit (§21) found
-- pre-existing public view grants that exceed the intended surface:
--
--   * public.politicore_profiles — anon/authenticated hold INSERT,
--     UPDATE, DELETE and TRUNCATE-class grants from 0009. Profile
--     identity rows are Core-owned: writes must never flow from
--     clients through this view. (RLS currently neutralizes the
--     exposure, but the grants are a standing hazard: any future
--     RLS relaxation silently becomes client-writable.)
--   * public.campaign_issues — anonymous callers hold blanket write
--     privileges (a 0007-provisioning-era grant that later grants never
--     narrowed, since grants are additive). Anonymous users cannot pass
--     the INSERT policy's authenticated checks, but anonymous write
--     surface on a workflow table is never intended: issue creation is
--     an authenticated, permission-gated path (INSERT policy) and
--     further lifecycle mutation is RPC-only by design.
--
-- Narrow both to the intended shape: politicore_profiles becomes
-- SELECT-only for application roles; campaign_issues loses every anon
-- write privilege (ALL revoked, SELECT re-granted). No policies change;
-- no data changes; base-table grants are untouched. This is the
-- recurring "stale grants survive CREATE OR REPLACE VIEW" defect class
-- (previously found on organizational_assignments in Phase E), closed
-- at the lock gate.
--
-- Campaign tables/views/RPCs otherwise keep the grants ratified by
-- 0021–0026: campaign_activities view writes mirror the base-table
-- manage-activity path by design; assignments/reports/participants
-- views are already SELECT-only.
-- =====================================================================

-- 1. politicore_profiles: identity writes are Core operations.
REVOKE INSERT, UPDATE, DELETE, TRUNCATE ON public.politicore_profiles FROM anon, authenticated;
GRANT SELECT ON public.politicore_profiles TO anon, authenticated;

-- service_role keeps full access for server-side provisioning/ops.
GRANT SELECT, INSERT, UPDATE, DELETE ON public.politicore_profiles TO service_role;

-- 2. campaign_issues: no anonymous write surface on a workflow table.
--    (0007 provisioning granted ALL; grants are additive, so revoke ALL
--    then re-grant the intended SELECT.)
REVOKE ALL ON public.campaign_issues FROM anon;
GRANT SELECT ON public.campaign_issues TO anon;

-- 3. Campaign views: restore the exact grant matrix ratified by 0021.
--    The 0007 provisioning-era grants (ALL to anon and authenticated,
--    including TRUNCATE) survived on every campaign view because grants
--    are additive and 0021 only ADDED its intended grants. All are
--    inert behind FORCE RLS today, but the intended shape is:
--      * campaign_activities — anon: SELECT; authenticated:
--        SELECT/INSERT/UPDATE/DELETE (the base-table manage path);
--      * participants / assignments / field_reports — SELECT-only for
--        application roles (writes are RPC-only by architecture);
--      * campaign_issues — anon: SELECT; authenticated: SELECT/INSERT
--        (member-reportable INSERT policy); lifecycle via RPCs only;
--      * TRUNCATE is never granted to application roles (PostgREST
--        cannot exercise it, and no workflow needs it).
--    service_role keeps full access for server-side operations.
REVOKE ALL ON public.campaign_activities FROM anon, authenticated;
GRANT SELECT ON public.campaign_activities TO anon, authenticated;
GRANT INSERT, UPDATE, DELETE ON public.campaign_activities TO authenticated, service_role;

REVOKE ALL ON public.campaign_activity_participants FROM anon, authenticated;
GRANT SELECT ON public.campaign_activity_participants TO anon, authenticated;

REVOKE ALL ON public.campaign_assignments FROM anon, authenticated;
-- 0024's ratified DELETE grant for the service delete path is restored
-- after the blanket ALL revoke (the base-table DELETE policy — module
-- gate, tenant, create_assignment permission, non-terminal — remains
-- the boundary):
GRANT SELECT, DELETE ON public.campaign_assignments TO authenticated;

REVOKE ALL ON public.campaign_field_reports FROM anon, authenticated;
GRANT SELECT ON public.campaign_field_reports TO anon, authenticated;

REVOKE ALL ON public.campaign_issues FROM authenticated;
GRANT SELECT, INSERT ON public.campaign_issues TO authenticated;

GRANT ALL ON public.campaign_activities, public.campaign_activity_participants,
  public.campaign_assignments, public.campaign_field_reports, public.campaign_issues
  TO service_role;

-- ---------------------------------------------------------------------
-- Verification (hosted applier signature): the two hygiene invariants
-- must hold for 0027 to count as applied.
-- ---------------------------------------------------------------------
DO $verify$
BEGIN
  IF EXISTS (
    SELECT 1 FROM information_schema.role_table_grants
    WHERE table_schema = 'public' AND table_name = 'politicore_profiles'
      AND grantee IN ('anon', 'authenticated')
      AND privilege_type IN ('INSERT', 'UPDATE', 'DELETE', 'TRUNCATE')
  ) THEN
    RAISE EXCEPTION '0027 verification failed: politicore_profiles still writable by application roles';
  END IF;

  IF EXISTS (
    SELECT 1 FROM information_schema.role_table_grants
    WHERE table_schema = 'public' AND table_name = 'campaign_issues'
      AND grantee = 'anon' AND privilege_type IN ('INSERT', 'UPDATE', 'DELETE', 'TRUNCATE')
  ) THEN
    RAISE EXCEPTION '0027 verification failed: campaign_issues still carries anon write grants';
  END IF;

  -- No application role may hold TRUNCATE or anon DML on any campaign view.
  IF EXISTS (
    SELECT 1 FROM information_schema.role_table_grants
    WHERE table_schema = 'public' AND table_name LIKE 'campaign%'
      AND grantee IN ('anon', 'authenticated')
      AND privilege_type = 'TRUNCATE'
  ) THEN
    RAISE EXCEPTION '0027 verification failed: application roles still hold TRUNCATE on campaign views';
  END IF;

  IF EXISTS (
    SELECT 1 FROM information_schema.role_table_grants
    WHERE table_schema = 'public'
      AND table_name IN ('campaign_activity_participants', 'campaign_field_reports')
      AND grantee IN ('anon', 'authenticated')
      AND privilege_type IN ('INSERT', 'UPDATE', 'DELETE', 'TRUNCATE')
  ) THEN
    RAISE EXCEPTION '0027 verification failed: RPC-only campaign views still writable by application roles';
  END IF;
END
$verify$;
