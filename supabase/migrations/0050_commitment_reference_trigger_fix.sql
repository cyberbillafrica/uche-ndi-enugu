-- =====================================================================
-- POLITICORE — MIGRATION 0050: COMMITMENT REFERENCE TRIGGER FIX (P13)
-- ---------------------------------------------------------------------
-- 0048's make_governance_commitment_reference assigned NEW.reference_code
-- inside the LOOP before the EXIT, so the trigger returned NEW with the
-- column still NULL and every insert failed the NOT NULL constraint.
-- Restates the canonical 0043-shaped body: pick a candidate, EXIT when
-- unique, assign once after the loop. 0048's recorded text is corrected
-- in-repository; hosted convergence flows through this migration.
-- Safe to re-apply.
-- =====================================================================

CREATE OR REPLACE FUNCTION politicore.make_governance_commitment_reference()
RETURNS trigger AS $$
DECLARE
  v_ref text;
BEGIN
  IF NEW.reference_code IS NULL OR NEW.reference_code = '' THEN
    LOOP
      v_ref := 'GC-' || upper(substring(md5(random()::text || clock_timestamp()::text) from 1 for 8));
      EXIT WHEN NOT EXISTS (
        SELECT 1 FROM politicore.governance_commitments WHERE reference_code = v_ref
      );
    END LOOP;
    NEW.reference_code := v_ref;
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql SET search_path = politicore, pg_temp;
