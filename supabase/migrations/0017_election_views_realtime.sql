-- =====================================================================
-- 0017: ELECTION VIEWS + REALTIME (Phase 1C-Implementation)
--
-- 1. politicore.election_results_current — result rows joined to
--    contest/cycle metadata and party labels resolved from IDs (the
--    legacy party-name-string join dies here). Plain SQL view in the
--    politicore schema; RLS of election_results does NOT automatically
--    apply to views, so a SECURITY DEFINER-free exposure to the hosted
--    data API goes through a security-invoker public view whose base
--    table policies apply to the querying role (0009 pattern).
--
-- 2. public.election_results_current — security-invoker exposure for
--    PostgREST (hosted data API exposes public.* only). RLS applies to
--    the querying role; social-only/module-disabled callers see nothing.
--
-- 3. Realtime: election_results, pu_reports, election_incidents added
--    to the supabase_realtime publication (guarded, 0009 pattern).
--    Realtime payloads honor RLS for the subscriber, so this never
--    becomes a way around row security. election_settings deliberately
--    NOT added (refetch-on-change; approved design §10).
-- =====================================================================

-- ---------------------------------------------------------------------
-- Current-results view (politicore schema; used by the public exposure
-- and by any SQL consumer). Party labels resolved from vote party_ids.
-- ---------------------------------------------------------------------
CREATE OR REPLACE VIEW politicore.election_results_current
  WITH (security_invoker = true) AS
SELECT
  r.id                    AS result_id,
  r.tenant_id,
  r.election_cycle_id,
  c.election_cycle_id     AS cycle_ref,
  cy.name                 AS cycle_name,
  cy.year                 AS cycle_year,
  r.contest_id,
  c.name                  AS contest_name,
  c.contest_type,
  c.scope_type            AS contest_scope_type,
  c.scope_id              AS contest_scope_id,
  r.polling_unit_id,
  r.ward_id,
  r.lga_id,
  r.votes,
  r.status,
  r.verified,
  r.reviewed_by,
  r.review_notes,
  r.reviewed_at,
  r.evidence_asset_id,
  r.submitted_by,
  r.created_at,
  r.updated_at,
  (
    SELECT jsonb_agg(
             jsonb_build_object(
               'party_id',  pp.id,
               'acronym',   pp.acronym,
               'name',      pp.name,
               'color',     pp.color,
               'votes',     (v->>'votes')::int
             ) ORDER BY (v->>'votes')::int DESC
           )
    FROM jsonb_array_elements(r.votes) v
    JOIN politicore.political_parties pp ON pp.id = (v->>'party_id')::uuid
  ) AS vote_details
FROM politicore.election_results r
JOIN politicore.election_contests c ON c.id = r.contest_id
JOIN politicore.election_cycles  cy ON cy.id = r.election_cycle_id;

-- ---------------------------------------------------------------------
-- Public exposure for the hosted data API — SECURITY INVOKER so the
-- election_results RLS policies (tenant, module, social-only, scope)
-- apply to the querying role exactly as they do to direct SELECTs.
-- ---------------------------------------------------------------------
CREATE OR REPLACE VIEW public.election_results_current
  WITH (security_invoker = true) AS
  SELECT * FROM politicore.election_results_current;

GRANT SELECT ON public.election_results_current TO authenticated, service_role;

-- ---------------------------------------------------------------------
-- Realtime publication (guarded; 0009 pattern — publication may not
-- exist locally, and reruns must not fail on already-added tables).
-- ---------------------------------------------------------------------
DO $pub$
DECLARE
  t text;
BEGIN
  IF EXISTS (SELECT 1 FROM pg_publication WHERE pubname = 'supabase_realtime') THEN
    FOREACH t IN ARRAY ARRAY['election_results','pu_reports','election_incidents'] LOOP
      IF NOT EXISTS (
        SELECT 1 FROM pg_publication_tables
        WHERE pubname = 'supabase_realtime'
          AND schemaname = 'politicore'
          AND tablename = t
      ) THEN
        EXECUTE format('ALTER PUBLICATION supabase_realtime ADD TABLE politicore.%I', t);
      END IF;
    END LOOP;
  END IF;
END
$pub$;
