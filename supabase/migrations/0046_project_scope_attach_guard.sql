-- =====================================================================
-- POLITICORE — MIGRATION 0046: PROJECT SCOPE-ATTACH GUARD FIX (P12)
-- ---------------------------------------------------------------------
-- add_governance_project_scope previously delegated to
-- assert_project_authority, which (a) deadlocks on a new project's FIRST
-- scope (zero existing scope rows → no geo authority) and (b) would have
-- let a holder of ANY project scope attach an UNRELATED scope. The
-- correct rule (§10/§28): the caller must hold manage_projects for the
-- scope being attached (or be an admin). Restates the final body.
-- =====================================================================

CREATE OR REPLACE FUNCTION politicore.add_governance_project_scope(
  p_project uuid,
  p_scope_type politicore.scope_type_enum,
  p_state_id text DEFAULT NULL,
  p_zone_id text DEFAULT NULL,
  p_lga_id text DEFAULT NULL,
  p_ward_id text DEFAULT NULL,
  p_polling_unit_id text DEFAULT NULL
) RETURNS uuid AS $$
DECLARE
  v_tenant uuid;
  v_project_tenant uuid;
  v_exists boolean;
  v_scope uuid;
  v_scope_id text;
BEGIN
  IF p_scope_type = 'campaign' THEN
    RAISE EXCEPTION 'governance: campaign scope is not valid for governance projects';
  END IF;

  SELECT tenant_id INTO v_project_tenant
    FROM politicore.governance_projects WHERE id = p_project;
  IF v_project_tenant IS NULL OR v_project_tenant <> politicore.current_tenant_id() THEN
    RAISE EXCEPTION 'governance: project not found';
  END IF;
  IF NOT politicore.module_enabled('governance') THEN
    RAISE EXCEPTION 'governance: module is not enabled for this tenant';
  END IF;

  v_scope_id := COALESCE(p_polling_unit_id, p_ward_id, p_lga_id, p_zone_id, p_state_id);

  -- Authority for THIS scope (bootstrap-correct: evaluated on the scope
  -- being attached, never on previously attached rows).
  IF NOT (politicore.is_tenant_admin()
          OR politicore.has_permission('manage_projects', p_scope_type, v_scope_id)) THEN
    RAISE EXCEPTION 'governance: caller may not attach a scope outside their authority';
  END IF;

  -- Core Geography validation (fail closed on unknown ids).
  v_exists :=
       (p_scope_type = 'state'           AND p_state_id IS NOT NULL
          AND EXISTS (SELECT 1 FROM politicore.states WHERE id = p_state_id))
    OR (p_scope_type = 'senatorial_zone' AND p_state_id IS NOT NULL AND p_zone_id IS NOT NULL
          AND EXISTS (SELECT 1 FROM politicore.senatorial_zones
                       WHERE id = p_zone_id AND state_id = p_state_id))
    OR (p_scope_type = 'lga' AND p_state_id IS NOT NULL AND p_zone_id IS NOT NULL AND p_lga_id IS NOT NULL
          AND EXISTS (SELECT 1 FROM politicore.lgas
                       WHERE id = p_lga_id AND zone_id = p_zone_id AND state_id = p_state_id))
    OR (p_scope_type = 'ward' AND p_state_id IS NOT NULL AND p_zone_id IS NOT NULL AND p_lga_id IS NOT NULL AND p_ward_id IS NOT NULL
          AND EXISTS (SELECT 1 FROM politicore.wards
                       WHERE id = p_ward_id AND lga_id = p_lga_id))
    OR (p_scope_type = 'polling_unit' AND p_state_id IS NOT NULL AND p_zone_id IS NOT NULL AND p_lga_id IS NOT NULL AND p_ward_id IS NOT NULL AND p_polling_unit_id IS NOT NULL
          AND EXISTS (SELECT 1 FROM politicore.polling_units
                       WHERE id = p_polling_unit_id AND ward_id = p_ward_id AND lga_id = p_lga_id));
  IF NOT v_exists THEN
    RAISE EXCEPTION 'governance: scope does not match Core Geography';
  END IF;

  INSERT INTO politicore.governance_project_scopes
    (tenant_id, project_id, scope_type, state_id, zone_id, lga_id, ward_id, polling_unit_id)
  VALUES (v_project_tenant, p_project, p_scope_type, p_state_id, p_zone_id,
          p_lga_id, p_ward_id, p_polling_unit_id)
  ON CONFLICT (project_id, scope_type, state_id, zone_id, lga_id, ward_id, polling_unit_id)
  DO NOTHING
  RETURNING id INTO v_scope;

  IF v_scope IS NOT NULL THEN
    INSERT INTO politicore.system_audits
      (tenant_id, actor_id, action, affected_resource, resource_id, new_value)
    VALUES (v_project_tenant, auth.uid(), 'governance_project:scope_add',
            'governance_project_scopes', v_scope::text,
            jsonb_build_object('project', p_project, 'scope_type', p_scope_type::text,
                               'scope_id', v_scope_id));
  END IF;
  RETURN v_scope;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER SET search_path = politicore, auth, pg_temp;

REVOKE EXECUTE ON FUNCTION politicore.add_governance_project_scope(uuid,politicore.scope_type_enum,text,text,text,text,text) FROM PUBLIC, anon;
