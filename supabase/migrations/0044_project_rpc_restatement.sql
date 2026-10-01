-- =====================================================================
-- POLITICORE — MIGRATION 0044: GOVERNANCE PROJECT RPC RESTATEMENT (P12)
-- ---------------------------------------------------------------------
-- Restates the final 0043 bodies of the functions changed after the
-- first hosted apply, so hosted converges with the canonical 0043:
--   1. update_governance_project        — owner-change notification
--                                         (§22 intent, best-effort)
--   2. set_governance_project_visibility — transaction-scoped GUC gate
--                                         licensing the identity guard
--   3. create_governance_project        — p_scopes jsonb → text (the
--                                         PostgREST-safe overload) and
--                                         removal of the jsonb overload
--   4. public.create_governance_project — thin wrapper follows (text)
-- Hand-written from 0043 verbatim. Safe to re-apply.
-- =====================================================================

CREATE OR REPLACE FUNCTION politicore.update_governance_project(
  p_project uuid,
  p_title text DEFAULT NULL,
  p_description text DEFAULT NULL,
  p_category_label text DEFAULT NULL,
  p_implementing_org text DEFAULT NULL,
  p_owner_profile_id uuid DEFAULT NULL,
  p_planned_start date DEFAULT NULL,
  p_planned_end date DEFAULT NULL,
  p_planned_budget numeric DEFAULT NULL,
  p_currency text DEFAULT NULL,
  p_funding_source text DEFAULT NULL,
  p_beneficiary_summary text DEFAULT NULL,
  p_beneficiaries_estimated integer DEFAULT NULL,
  p_clear_actual_dates boolean DEFAULT false
) RETURNS void AS $$
DECLARE
  v_tenant uuid;
  v_owner_tenant uuid;
  v_old_owner uuid;
BEGIN
  v_tenant := politicore.assert_project_authority(p_project);

  IF p_owner_profile_id IS NOT NULL THEN
    SELECT tenant_id INTO v_owner_tenant FROM politicore.profiles WHERE id = p_owner_profile_id;
    IF v_owner_tenant IS NULL OR v_owner_tenant <> v_tenant THEN
      RAISE EXCEPTION 'governance: owner must belong to the same tenant';
    END IF;
  END IF;

  -- Owner change? Resolve the PREVIOUS owner first for the notification.
  IF p_owner_profile_id IS NOT NULL THEN
    SELECT owner_profile_id INTO v_old_owner
      FROM politicore.governance_projects WHERE id = p_project;
  END IF;

  UPDATE politicore.governance_projects SET
    title                   = COALESCE(p_title, title),
    description             = COALESCE(p_description, description),
    category_label          = COALESCE(p_category_label, category_label),
    implementing_org        = COALESCE(p_implementing_org, implementing_org),
    owner_profile_id        = COALESCE(p_owner_profile_id, owner_profile_id),
    planned_start           = COALESCE(p_planned_start, planned_start),
    planned_end             = COALESCE(p_planned_end, planned_end),
    planned_budget          = COALESCE(p_planned_budget, planned_budget),
    currency                = COALESCE(p_currency, currency),
    funding_source          = COALESCE(p_funding_source, funding_source),
    beneficiary_summary     = COALESCE(p_beneficiary_summary, beneficiary_summary),
    beneficiaries_estimated = COALESCE(p_beneficiaries_estimated, beneficiaries_estimated),
    actual_start = CASE WHEN p_clear_actual_dates THEN NULL ELSE actual_start END,
    actual_end   = CASE WHEN p_clear_actual_dates THEN NULL ELSE actual_end END
  WHERE id = p_project;

  -- §22 notification intent: the one implemented workflow that warrants a
  -- notification — a staff member becomes accountable for a project.
  -- Best-effort (0036 precedent): never fails the business action.
  IF p_owner_profile_id IS NOT NULL AND v_old_owner IS DISTINCT FROM p_owner_profile_id THEN
    PERFORM politicore.governance_notify_project_owner(p_project, p_owner_profile_id, auth.uid());
  END IF;

  INSERT INTO politicore.system_audits
    (tenant_id, actor_id, action, affected_resource, resource_id)
  VALUES (v_tenant, auth.uid(), 'governance_project:update',
          'governance_projects', p_project::text);
END;
$$ LANGUAGE plpgsql SECURITY DEFINER SET search_path = politicore, auth, pg_temp;

CREATE OR REPLACE FUNCTION politicore.set_governance_project_visibility(
  p_project uuid,
  p_is_public boolean
) RETURNS void AS $$
DECLARE
  v_tenant uuid; v_old boolean;
BEGIN
  v_tenant := politicore.assert_project_authority(p_project);
  SELECT is_public INTO v_old FROM politicore.governance_projects WHERE id = p_project;

  -- License the identity guard for this transaction-scoped, RPC-only
  -- visibility mutation (session GUCs cannot be set through PostgREST).
  PERFORM set_config('politicore.governance_authority', 'visibility_rpc', true);

  UPDATE politicore.governance_projects
     SET is_public = p_is_public,
         published_at = CASE WHEN p_is_public THEN now() ELSE NULL END
   WHERE id = p_project;
  PERFORM set_config('politicore.governance_authority', '', true);

  INSERT INTO politicore.system_audits
    (tenant_id, actor_id, action, affected_resource, resource_id,
     old_value, new_value)
  VALUES (v_tenant, auth.uid(), 'governance_project:visibility',
          'governance_projects', p_project::text,
          jsonb_build_object('is_public', v_old),
          jsonb_build_object('is_public', p_is_public));
END;
$$ LANGUAGE plpgsql SECURITY DEFINER SET search_path = politicore, auth, pg_temp;

-- p_scopes must cross PostgREST as text (jsonb is not in the JDBC/PG
-- text-mode parameter map). Create the text overload, then remove the
-- jsonb overload where it exists (early hosted apply).
DROP FUNCTION IF EXISTS politicore.create_governance_project(
  text, text, text, text, uuid, date, date, numeric, text, text, text, integer, jsonb);

CREATE OR REPLACE FUNCTION politicore.create_governance_project(
  p_title text,
  p_description text DEFAULT '',
  p_category_label text DEFAULT '',
  p_implementing_org text DEFAULT '',
  p_owner_profile_id uuid DEFAULT NULL,
  p_planned_start date DEFAULT NULL,
  p_planned_end date DEFAULT NULL,
  p_planned_budget numeric DEFAULT NULL,
  p_currency text DEFAULT 'NGN',
  p_funding_source text DEFAULT '',
  p_beneficiary_summary text DEFAULT '',
  p_beneficiaries_estimated integer DEFAULT NULL,
  p_scopes text DEFAULT '[]'
) RETURNS uuid AS $$
DECLARE
  v_tenant uuid;
  v_caller uuid := auth.uid();
  v_project uuid;
  v_s jsonb;
  v_owner_tenant uuid;
BEGIN
  IF p_title IS NULL OR length(btrim(p_title)) = 0 THEN
    RAISE EXCEPTION 'governance: title is required';
  END IF;
  SELECT tenant_id INTO v_tenant FROM politicore.profiles WHERE id = v_caller;
  IF v_tenant IS NULL THEN
    RAISE EXCEPTION 'governance: caller has no tenant';
  END IF;
  IF NOT politicore.module_enabled('governance') THEN
    RAISE EXCEPTION 'governance: module is not enabled for this tenant';
  END IF;
  IF NOT politicore.has_permission('manage_projects') THEN
    RAISE EXCEPTION 'governance: manage_projects required';
  END IF;

  IF p_owner_profile_id IS NOT NULL THEN
    SELECT tenant_id INTO v_owner_tenant FROM politicore.profiles WHERE id = p_owner_profile_id;
    IF v_owner_tenant IS NULL OR v_owner_tenant <> v_tenant THEN
      RAISE EXCEPTION 'governance: owner must belong to the same tenant';
    END IF;
  END IF;

  INSERT INTO politicore.governance_projects
    (tenant_id, title, description, category_label, owner_profile_id,
     implementing_org, planned_start, planned_end, planned_budget,
     currency, funding_source, beneficiary_summary, beneficiaries_estimated,
     created_by)
  VALUES
    (v_tenant, btrim(p_title), p_description, p_category_label,
     p_owner_profile_id, p_implementing_org, p_planned_start, p_planned_end,
     p_planned_budget, p_currency, p_funding_source,
     p_beneficiary_summary, p_beneficiaries_estimated, v_caller)
  RETURNING id INTO v_project;

  IF p_scopes IS NOT NULL AND jsonb_typeof(p_scopes::jsonb) = 'array' THEN
    FOR v_s IN SELECT * FROM jsonb_array_elements(p_scopes::jsonb) LOOP
      PERFORM politicore.add_governance_project_scope(v_project,
        (v_s->>'scope_type')::politicore.scope_type_enum,
        v_s->>'state_id', v_s->>'zone_id', v_s->>'lga_id',
        v_s->>'ward_id', v_s->>'polling_unit_id');
    END LOOP;
  END IF;

  INSERT INTO politicore.system_audits
    (tenant_id, actor_id, action, affected_resource, resource_id, new_value)
  VALUES (v_tenant, v_caller, 'governance_project:create',
          'governance_projects', v_project::text,
          jsonb_build_object('title', p_title, 'status', 'planned'));
  RETURN v_project;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER SET search_path = politicore, auth, pg_temp;

-- Thin public wrapper (0005 convention): follows the text overload.
DROP FUNCTION IF EXISTS public.create_governance_project(jsonb);
DROP FUNCTION IF EXISTS public.create_governance_project(text);

CREATE OR REPLACE FUNCTION public.create_governance_project(
  p_title text,
  p_description text DEFAULT '',
  p_category_label text DEFAULT '',
  p_implementing_org text DEFAULT '',
  p_owner_profile_id uuid DEFAULT NULL,
  p_planned_start date DEFAULT NULL,
  p_planned_end date DEFAULT NULL,
  p_planned_budget numeric DEFAULT NULL,
  p_currency text DEFAULT 'NGN',
  p_funding_source text DEFAULT '',
  p_beneficiary_summary text DEFAULT '',
  p_beneficiaries_estimated integer DEFAULT NULL,
  p_scopes text DEFAULT '[]'
) RETURNS uuid AS $$
  SELECT politicore.create_governance_project(
    p_title, p_description, p_category_label, p_implementing_org,
    p_owner_profile_id, p_planned_start, p_planned_end, p_planned_budget,
    p_currency, p_funding_source, p_beneficiary_summary,
    p_beneficiaries_estimated, p_scopes);
$$ LANGUAGE sql SECURITY DEFINER SET search_path = politicore, auth, pg_temp;

-- Hygiene: authority RPCs are authenticated-only (0007 default grants
-- include anon; re-assert after the restatements above).
REVOKE EXECUTE ON FUNCTION politicore.update_governance_project(uuid,text,text,text,text,uuid,date,date,numeric,text,text,text,integer,boolean) FROM PUBLIC, anon;
REVOKE EXECUTE ON FUNCTION politicore.set_governance_project_visibility(uuid,boolean) FROM PUBLIC, anon;
REVOKE EXECUTE ON FUNCTION politicore.create_governance_project(text,text,text,text,uuid,date,date,numeric,text,text,text,integer,text) FROM PUBLIC, anon;
REVOKE EXECUTE ON FUNCTION public.create_governance_project(text,text,text,text,uuid,date,date,numeric,text,text,text,integer,text) FROM anon;
