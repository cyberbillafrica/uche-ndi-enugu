-- =====================================================================
-- POLITICORE — MIGRATION 0053: PETITION SCOPE SHAPE CONVERGENCE (P15)
-- =====================================================================
-- Convergence for a genuine 0052 defect, disclosed per the phase rules:
--
--   DEFECT: the `governance_petition_scope_shape` CHECK's 'ward' branch was
--   transcribed from the consultation table with `ward_id IS NULL` where
--   Core Geography shape semantics require `ward_id IS NOT NULL`. A ward
--   scope (the common targeting case) therefore could not be attached —
--   every add_governance_petition_scope('ward', ...) insert failed the
--   constraint. Both the local PGLite database and hosted carry the broken
--   constraint.
--
--   WHY CONVERGENCE, NOT AN EDIT-ONLY FIX: 0052 is uncommitted in the
--   working tree, so its text is corrected in place for fresh databases;
--   hosted already ran the broken statement, so the constraint must be
--   repaired in place there. Dropping/re-adding a CHECK constraint is a
--   metadata-only operation (no table rewrite, no data risk).
--
--   IDEMPOTENCE: the DO block acts only when the broken branch is present;
--   on a converged database it is a no-op. The discriminator is a regex on
--   the ward branch itself (`scope_type = 'ward'` followed within ~250
--   chars by `ward_id IS NULL`) — it cannot match the corrected constraint,
--   any consultation constraint, or any earlier migration's text.
-- ---------------------------------------------------------------------

DO $$
DECLARE
  v_def text;
BEGIN
  SELECT pg_get_constraintdef(oid) INTO v_def
    FROM pg_constraint
   WHERE conname = 'governance_petition_scope_shape'
     AND conrelid = 'politicore.governance_petition_scopes'::regclass;

  IF v_def IS NOT NULL AND v_def ~ 'scope_type = ''ward''.{0,250}ward_id IS NULL' THEN
    ALTER TABLE politicore.governance_petition_scopes
      DROP CONSTRAINT governance_petition_scope_shape;

    ALTER TABLE politicore.governance_petition_scopes
      ADD CONSTRAINT governance_petition_scope_shape CHECK (
        (scope_type = 'state' AND state_id IS NOT NULL AND zone_id IS NULL AND lga_id IS NULL AND ward_id IS NULL AND polling_unit_id IS NULL)
        OR (scope_type = 'senatorial_zone' AND state_id IS NOT NULL AND zone_id IS NOT NULL AND lga_id IS NULL AND ward_id IS NULL AND polling_unit_id IS NULL)
        OR (scope_type = 'lga' AND state_id IS NOT NULL AND zone_id IS NOT NULL AND lga_id IS NOT NULL AND ward_id IS NULL AND polling_unit_id IS NULL)
        OR (scope_type = 'ward' AND state_id IS NOT NULL AND zone_id IS NOT NULL AND lga_id IS NOT NULL AND ward_id IS NOT NULL AND polling_unit_id IS NULL)
        OR (scope_type = 'polling_unit' AND state_id IS NOT NULL AND zone_id IS NOT NULL AND lga_id IS NOT NULL AND ward_id IS NOT NULL AND polling_unit_id IS NOT NULL)
      );
  END IF;
END;
$$;
