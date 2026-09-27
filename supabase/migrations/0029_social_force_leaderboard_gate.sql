-- =====================================================================
-- 0029 — SOCIAL FORCE PHASE D: leaderboard module gate
-- =====================================================================
-- Social Force Architecture Gate Phase D (§16): every Social surface
-- must fail closed when module_enabled('social') = false.
--
-- The Phase A leaderboard projection (public.social_leaderboard) is a
-- security_invoker view over politicore.profiles, whose tenant-wide
-- SELECT policy (0002 profiles_read) predates the Social module gate.
-- Effect: with Social disabled, members could still read the tenant's
-- leaderboard rows — an ungated Social surface. This migration layers
-- the Social module gate onto the view DEFINITION (PostgreSQL RLS
-- policies do not apply to views; the Phase A security_invoker pattern
-- is the correct mechanism) WITHOUT weakening the Core profiles policy
-- (Core ownership boundaries preserved):
--
--   * the view's WHERE gains module_enabled('social') plus Social
--     authority (admin / social member) predicates — module off →
--     zero rows for everyone; anon keeps its grant but, holding no
--     membership, still sees nothing (prior fail-closed behavior
--     preserved AND now also enforced for module-off tenants);
--   * profiles RLS continues to apply underneath (invoker rights), so
--     tenant isolation is unchanged.
--
-- Also (Phase D §10/§24 read-model support): a bounded admin read RPC
-- for the review-adjacent visibility the verify RPC already implies —
-- admin can read member awards within their own tenant only
-- (security invoker semantics inside; definer only to pin search_path).
--
-- DOES NOT touch: Campaign (locked), Election (locked), Core
-- authorization semantics, social_point_awards RLS (already gated),
-- the profiles projection update path.
-- =====================================================================

-- ---------------------------------------------------------------------
-- 1. Leaderboard module gate (view definition — RLS does not apply to views)
-- ---------------------------------------------------------------------
-- Re-assert the Phase A projection verbatim (reduced fields, position
-- ranking, points > 0) with the Social module + authority gate added.
CREATE OR REPLACE VIEW public.social_leaderboard
  WITH (security_invoker = true) AS
SELECT
  p.id,
  p.tenant_id,
  p.full_name,
  p.points,
  p.rank,
  p.ward_id,
  w.name  AS ward_name,
  w.lga_id,
  l.zone_id,
  ROW_NUMBER() OVER (
    PARTITION BY p.tenant_id
    ORDER BY p.points DESC, p.full_name ASC, p.id ASC
  ) AS position
FROM politicore.profiles p
LEFT JOIN politicore.wards w ON w.id = p.ward_id
LEFT JOIN politicore.lgas  l ON l.id = w.lga_id
WHERE p.points > 0
  AND politicore.module_enabled('social')
  AND (
    politicore.is_admin()
    OR politicore.has_membership('social_member')
  );

-- ---------------------------------------------------------------------
-- 2. Bounded admin award-history read (Phase D §10)
-- ---------------------------------------------------------------------
-- The existing product has no tenant-wide Admin accounting module; the
-- only admin award visibility Phase A granted was inside the verify
-- RPC. Phase D keeps that posture: admins read awards through this
-- bounded, tenant-pinned RPC (same authority checks as the verify RPC)
-- rather than through any broad award-download surface.
CREATE OR REPLACE FUNCTION politicore.social_admin_award_history(
  p_recipient uuid,
  p_limit integer DEFAULT 50
) RETURNS TABLE (
  id            uuid,
  recipient_id  uuid,
  submission_id uuid,
  points        integer,
  source        text,
  awarded_by    uuid,
  awarded_at    timestamptz
) AS $$
BEGIN
  IF politicore.current_tenant_id() IS NULL THEN
    RAISE EXCEPTION 'unauthenticated';
  END IF;
  IF NOT politicore.module_enabled('social') THEN
    RAISE EXCEPTION 'social module is not enabled';
  END IF;
  IF NOT politicore.is_admin() THEN
    RAISE EXCEPTION 'award history requires admin authority';
  END IF;

  RETURN QUERY
  SELECT a.id, a.recipient_id, a.submission_id, a.points,
         a.source, a.awarded_by, a.awarded_at
  FROM politicore.social_point_awards a
  WHERE a.tenant_id = politicore.current_tenant_id()
    AND (p_recipient IS NULL OR a.recipient_id = p_recipient)
  ORDER BY a.awarded_at DESC
  LIMIT GREATEST(1, LEAST(COALESCE(p_limit, 50), 200));
END;
$$ LANGUAGE plpgsql SECURITY DEFINER SET search_path = politicore, auth, pg_temp;

-- ---------------------------------------------------------------------
-- 3. Public wrapper + ratified grants (0027 hygiene standard)
-- ---------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.social_admin_award_history(
  p_recipient uuid DEFAULT NULL,
  p_limit integer DEFAULT 50
) RETURNS TABLE (
  id            uuid,
  recipient_id  uuid,
  submission_id uuid,
  points        integer,
  source        text,
  awarded_by    uuid,
  awarded_at    timestamptz
) AS $$
  SELECT * FROM politicore.social_admin_award_history(p_recipient, p_limit);
$$ LANGUAGE sql;

REVOKE ALL ON FUNCTION public.social_admin_award_history(uuid, integer) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.social_admin_award_history(uuid, integer) TO authenticated;
-- (Existing wrappers keep their ratified default-PUBLIC EXECUTE +
-- in-function-guard design — see the Phase B hosted G5 check; the
-- database guard remains the boundary, not the grant.)
