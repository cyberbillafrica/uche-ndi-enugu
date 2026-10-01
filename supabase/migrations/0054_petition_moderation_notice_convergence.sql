-- =====================================================================
-- POLITICORE — MIGRATION 0054: PETITION MODERATION NOTICE CONVERGENCE (P15)
-- =====================================================================
-- Convergence for a genuine 0052 defect, disclosed per the phase rules:
--
--   DEFECT: governance_notify_petition_submitted filtered its fanout with
--   politicore.has_permission('manage_participation'), which evaluates the
--   CALLER's authority (JWT), not each recipient's. When a member
--   originates a community proposal (the normal intake — members hold no
--   permission by design), the predicate is false for every row and NO
--   moderation notice is sent. Caught by hosted acceptance (J12b).
--
--   FIX: resolve recipients purely from data — tenant admins
--   (profiles.access_role = 'admin') plus every holder of a
--   manage_participation grant (any scope — ward/LGA managers are the
--   natural reviewers of geo-targeted proposals; gate §4: moderation is
--   the control for participant-originated intake). No caller-relative
--   predicate remains.
--
--   IDEMPOTENCE: CREATE OR REPLACE is naturally idempotent; the hosted-
--   applier signature probes the body for the permission_grants clause.
-- ---------------------------------------------------------------------

CREATE OR REPLACE FUNCTION politicore.governance_notify_petition_submitted(
  p_petition uuid,
  p_actor uuid
) RETURNS void AS $$
DECLARE
  v_tenant uuid;
  v_title text;
  v_ref text;
BEGIN
  SELECT tenant_id, title, reference_code
    INTO v_tenant, v_title, v_ref
    FROM politicore.governance_petitions WHERE id = p_petition;

  INSERT INTO politicore.notifications
    (tenant_id, user_id, type, title, message, link_url, created_by)
  SELECT DISTINCT v_tenant, p.id, 'system',
         'Community proposal awaiting review',
         '"' || v_title || '" (ref ' || v_ref || ') was submitted and awaits moderation.',
         '/portal/governance/participation/' || p_petition::text,
         p_actor
    FROM politicore.profiles p
   WHERE p.tenant_id = v_tenant
     AND (
       p.access_role = 'admin'
       OR EXISTS (
         SELECT 1 FROM politicore.permission_grants g
          WHERE g.user_id = p.id
            AND g.permission = 'manage_participation'
            AND g.granted = true
       )
     );
EXCEPTION WHEN OTHERS THEN
  RAISE WARNING 'governance petition moderation notification failed: %', SQLERRM;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER SET search_path = politicore, auth, pg_temp;
