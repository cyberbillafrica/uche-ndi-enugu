-- =====================================================================
-- POLITICORE — MIGRATION 0049: COMMITMENT AUTHORITY CONVERGENCE (P13)
-- ---------------------------------------------------------------------
-- Mirrors the Phase 12 (0045) create semantics for commitments:
--
--   create_governance_commitment — scope-scoped grantees may create a
--   commitment when ALL initial scopes lie within their authority; a
--   scoped grantee who supplies no authorized scope aborts (atomic).
--   Unscoped holders (and admins) keep the tenant-wide path.
--
-- 0048's original body required the tenant-wide has_permission result,
-- wrongly rejecting ward-scoped manage_projects holders at creation.
-- Restates the final body. Safe to re-apply.
-- =====================================================================

CREATE OR REPLACE FUNCTION politicore.create_governance_commitment(
  p_title text,
  p_details text DEFAULT '',
  p_category_label text DEFAULT '',
  p_source_type text DEFAULT 'independent',
  p_source_ref text DEFAULT NULL,
  p_owner_profile_id uuid DEFAULT NULL,
  p_target_description text DEFAULT '',
  p_planned_start date DEFAULT NULL,
  p_target_date date DEFAULT NULL,
  p_scopes text DEFAULT '[]'
) RETURNS uuid AS $$
DECLARE
  v_tenant uuid;
  v_caller uuid := auth.uid();
  v_commitment uuid;
  v_s jsonb;
  v_owner_tenant uuid;
  v_source politicore.governance_commitment_source_type;
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
  -- per-scope authority is enforced by add_governance_commitment_scope).
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

  v_source := p_source_type::politicore.governance_commitment_source_type;

  INSERT INTO politicore.governance_commitments
    (tenant_id, title, details, category_label, source_type, source_ref,
     owner_profile_id, target_description, planned_start, target_date,
     created_by)
  VALUES
    (v_tenant, btrim(p_title), COALESCE(p_details,''), COALESCE(p_category_label,''),
     v_source, p_source_ref, p_owner_profile_id, COALESCE(p_target_description,''),
     p_planned_start, p_target_date, v_caller)
  RETURNING id INTO v_commitment;

  IF p_scopes IS NOT NULL AND jsonb_typeof(p_scopes::jsonb) = 'array' THEN
    FOR v_s IN SELECT * FROM jsonb_array_elements(p_scopes::jsonb) LOOP
      PERFORM politicore.add_governance_commitment_scope(v_commitment,
        (v_s->>'scope_type')::politicore.scope_type_enum,
        v_s->>'state_id', v_s->>'zone_id', v_s->>'lga_id',
        v_s->>'ward_id', v_s->>'polling_unit_id');
    END LOOP;
  END IF;

  -- A scope-scoped grantee MUST deliver at least one scope within their
  -- authority (otherwise they would mint a tenant-wide commitment). The
  -- RAISE aborts the transaction: no orphan commitment survives.
  IF NOT v_unscoped THEN
    SELECT count(*) INTO v_scope_count
      FROM politicore.governance_commitment_scopes WHERE commitment_id = v_commitment;
    IF v_scope_count = 0 THEN
      RAISE EXCEPTION 'governance: manage_projects with a scope within your authority is required';
    END IF;
  END IF;

  INSERT INTO politicore.system_audits
    (tenant_id, actor_id, action, affected_resource, resource_id, new_value)
  VALUES (v_tenant, v_caller, 'governance_commitment:create',
          'governance_commitments', v_commitment::text,
          jsonb_build_object('title', p_title, 'status', 'declared',
                             'source_type', v_source::text));

  -- Owner-assignment notification intent (§19, best-effort, Core pattern).
  IF p_owner_profile_id IS NOT NULL THEN
    PERFORM politicore.governance_notify_commitment_owner(v_commitment, p_owner_profile_id, v_caller);
  END IF;

  RETURN v_commitment;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER SET search_path = politicore, auth, pg_temp;

-- Hygiene re-assert after restatement.
REVOKE EXECUTE ON FUNCTION politicore.create_governance_commitment(text,text,text,text,text,uuid,text,date,date,text) FROM PUBLIC, anon;
