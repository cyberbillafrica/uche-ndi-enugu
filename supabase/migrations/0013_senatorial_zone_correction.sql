-- =====================================================================
-- 0013: SENATORIAL ZONE CORRECTION — Enugu West (geography defect fix)
--
-- The original geography seed (0003 as first generated and applied)
-- named the third senatorial zone "Enugu South" (id enugu-south-zone,
-- code ES). That is factually wrong: Enugu South is an LGA of the
-- Enugu East zone. The canonical Enugu State senatorial zones are:
--
--   Enugu North (6): Igbo Etiti, Igbo Eze North, Igbo Eze South,
--                    Nsukka, Udenu, Uzo-Uwani
--   Enugu East (6):  Enugu East, Enugu North, Enugu South, Isi Uzo,
--                    Nkanu East, Nkanu West
--   Enugu West (5):  Aninri, Awgu, Ezeagu, Oji River, Udi
--
-- The LGA memberships were always correct; only the third zone's
-- identity was wrong. 0003's source has been corrected (fresh databases
-- seed the right zone directly). This migration repairs databases that
-- were already seeded with the erroneous zone: it creates the canonical
-- Enugu West zone, re-points its five LGAs, and removes the bogus zone.
-- Idempotent: no-ops if enugu-south-zone does not exist.
-- =====================================================================

DO $fix$
BEGIN
  IF EXISTS (SELECT 1 FROM politicore.senatorial_zones WHERE id = 'enugu-south-zone') THEN
    -- 1. Canonical zone row (matches corrected 0003 exactly).
    INSERT INTO politicore.senatorial_zones (id, state_id, name, code)
    VALUES ('enugu-west-zone', 'enugu-state', 'Enugu West', 'EW')
    ON CONFLICT (id) DO NOTHING;

    -- 2. Re-point the five Enugu West LGAs.
    UPDATE politicore.lgas
    SET zone_id = 'enugu-west-zone'
    WHERE zone_id = 'enugu-south-zone';

    -- 3. Remove the erroneous zone.
    DELETE FROM politicore.senatorial_zones WHERE id = 'enugu-south-zone';

    RAISE NOTICE '0013: corrected senatorial zone Enugu South -> Enugu West';
  ELSE
    RAISE NOTICE '0013: no enugu-south-zone present — nothing to correct';
  END IF;
END
$fix$;

-- Final integrity assertion: canonical geography must hold after repair.
DO $verify$
DECLARE
  zones int; lgas int; wards int; pus int; orphans int;
BEGIN
  SELECT (SELECT count(*) FROM politicore.senatorial_zones),
         (SELECT count(*) FROM politicore.lgas),
         (SELECT count(*) FROM politicore.wards),
         (SELECT count(*) FROM politicore.polling_units),
         (SELECT count(*) FROM politicore.lgas l
          LEFT JOIN politicore.senatorial_zones z ON z.id = l.zone_id
          WHERE z.id IS NULL)
  INTO zones, lgas, wards, pus, orphans;

  IF zones <> 3 OR lgas <> 17 OR wards <> 260 OR pus <> 4145 OR orphans <> 0 THEN
    RAISE EXCEPTION '0013 verification failed: zones=% lgas=% wards=% pus=% orphans=%',
      zones, lgas, wards, pus, orphans;
  END IF;
  IF EXISTS (SELECT 1 FROM politicore.senatorial_zones WHERE name = 'Enugu South' AND code = 'ES' AND id LIKE '%zone') THEN
    RAISE EXCEPTION '0013 verification failed: bogus Enugu South zone still present';
  END IF;
END
$verify$;
