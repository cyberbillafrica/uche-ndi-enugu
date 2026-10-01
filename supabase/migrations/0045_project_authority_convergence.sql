-- =====================================================================
-- POLITICORE — MIGRATION 0045: PROJECT AUTHORITY CONVERGENCE (P12)
-- ---------------------------------------------------------------------
-- Converges the final Phase 12 authority semantics on every environment
-- (locally 0043's original bodies are already recorded and immutable;
-- hosted holds the same):
--
--   1. create_governance_project — scope-scoped grantees may create a
--      project when ALL initial scopes lie within their authority; a
--      scoped grantee who supplies no authorized scope aborts (atomic).
--      Unscoped holders (and admins) keep the tenant-wide path.
--   2. guard_governance_project_identity — licenses the RPC-gated
--      visibility mutation via the transaction-scoped GUC set by
--      set_governance_project_visibility (direct-table writes still
--      raise; PostgREST callers cannot set the GUC).
-- =====================================================================

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
  v_unscoped boolean;
  v_scope_count integer;
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

  -- Tenant-wide holders (incl. admins via bypass) OR any manage_projects
  -- grantee; scope-scoped grantees are further constrained below (their
  -- per-scope authority is enforced by add_governance_project_scope).
  v_unscoped := politicore.has_permission('manage_projects');
  IF NOT v_unscoped
     AND NOT EXISTS (
       SELECT 1 FROM politicore.permission_grants g
        WHERE g.user_id = v_caller
          AND g.permission = 'manage_projects'
          AND g.granted = true
     ) THEN
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

  -- A scope-scoped grantee MUST deliver at least one scope within their
  -- authority (otherwise they would mint a tenant-wide project). The
  -- RAISE aborts the transaction: no orphan project survives.
  IF NOT v_unscoped THEN
    SELECT count(*) INTO v_scope_count
      FROM politicore.governance_project_scopes WHERE project_id = v_project;
    IF v_scope_count = 0 THEN
      RAISE EXCEPTION 'governance: manage_projects with a scope within your authority is required';
    END IF;
  END IF;

  INSERT INTO politicore.system_audits
    (tenant_id, actor_id, action, affected_resource, resource_id, new_value)
  VALUES (v_tenant, v_caller, 'governance_project:create',
          'governance_projects', v_project::text,
          jsonb_build_object('title', p_title, 'status', 'planned'));
  RETURN v_project;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER SET search_path = politicore, auth, pg_temp;

CREATE OR REPLACE FUNCTION politicore.guard_governance_project_identity()
RETURNS trigger AS $$
BEGIN
  IF NEW.reference_code <> OLD.reference_code THEN
    RAISE EXCEPTION 'governance: project reference is immutable';
  END IF;
  IF (NEW.is_public <> OLD.is_public OR NEW.published_at IS DISTINCT FROM OLD.published_at)
     AND COALESCE(current_setting('politicore.governance_authority', true), '') <> 'visibility_rpc' THEN
    RAISE EXCEPTION 'governance: project visibility changes require the authority RPC';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql SET search_path = politicore, pg_temp;

-- Hygiene re-assert after restatement.
REVOKE EXECUTE ON FUNCTION politicore.create_governance_project(text,text,text,text,uuid,date,date,numeric,text,text,text,integer,text) FROM PUBLIC, anon;
