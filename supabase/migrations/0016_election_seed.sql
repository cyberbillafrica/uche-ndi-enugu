-- =====================================================================
-- 0016: ELECTION SEED — PLATFORM POLITICAL PARTIES (Phase 1C-Implementation)
--
-- Seeds politicore.political_parties from the project's authoritative
-- legacy source (src/lib/firebase/election-seed.ts →
-- INEC_2027_POLITICAL_PARTIES, 17 parties). No party data is invented.
--
-- Per approved design §14 and brief §40: Election is modular and
-- generic — tenant Election cycles/contests are created by tenant
-- admins on activation (or a later seed phase), NOT automatically for
-- every tenant here.
--
-- Idempotent: ON CONFLICT DO UPDATE keeps acronym stable (the FK target
-- for tracked_parties and votes) while refreshing descriptive fields.
-- =====================================================================

INSERT INTO politicore.political_parties (acronym, name, color, inec_registered, is_active) VALUES
  ('APC',  'All Progressives Congress',        '#1B4F72', true, true),
  ('PDP',  'Peoples Democratic Party',         '#27AE60', true, true),
  ('LP',   'Labour Party',                     '#D35400', true, true),
  ('APGA', 'All Progressives Grand Alliance',  '#8E44AD', true, true),
  ('NNPP', 'New Nigeria Peoples Party',        '#C0392B', true, true),
  ('ADC',  'African Democratic Congress',      '#F39C12', true, true),
  ('SDP',  'Social Democratic Party',          '#16A085', true, true),
  ('YPP',  'Young Progressives Party',         '#2980B9', true, true),
  ('AA',   'Action Alliance',                  '#7F8C8D', true, true),
  ('AAC',  'African Action Congress',          '#E67E22', true, true),
  ('ADP',  'Action Democratic Party',          '#34495E', true, true),
  ('APM',  'All Allied Peoples Movement',      '#16A085', true, true),
  ('APP',  'Action Peoples Party',             '#9B59B6', true, true),
  ('BP',   'Boot Party',                       '#95A5A6', true, true),
  ('NRM',  'National Rescue Movement',         '#D35400', true, true),
  ('PRP',  'People''s Redemption Party',       '#C0392B', true, true),
  ('ZLP',  'Zenith Labour Party',              '#27AE60', true, true)
ON CONFLICT (acronym) DO UPDATE SET
  name            = EXCLUDED.name,
  color           = EXCLUDED.color,
  inec_registered = EXCLUDED.inec_registered,
  is_active       = EXCLUDED.is_active,
  updated_at      = now();

-- Sanity: the platform party set must be complete (17 from the seed source)
DO $$
BEGIN
  IF (SELECT count(*) FROM politicore.political_parties) < 17 THEN
    RAISE EXCEPTION 'political party seed incomplete';
  END IF;
END $$;
