-- =====================================================================
-- 0002: AUTHORIZATION FUNCTIONS + ROW LEVEL SECURITY (Phase 1A)
--
-- Centralized, database-side authorization. Replaces the Firestore
-- user_access index + rules helpers. Every helper is STABLE so RLS
-- can inline it. Tenant identity NEVER comes from client payloads —
-- only from the auth shim / Supabase JWT.
-- =====================================================================

-- ---------------------------------------------------------------------
-- Identity context helpers
-- auth.uid() is defined in 0000 (shim locally; Supabase's real one in prod).
-- These lookups are SECURITY DEFINER so the identity row can be read
-- without recursing into the very RLS policies that consult them
-- (the standard Supabase helper pattern). They only ever expose the
-- caller's own profile or derived booleans.
-- ---------------------------------------------------------------------
CREATE OR REPLACE FUNCTION politicore.current_profile()
RETURNS politicore.profiles AS $$
  SELECT * FROM politicore.profiles WHERE id = auth.uid();
$$ LANGUAGE sql STABLE SECURITY DEFINER SET search_path = politicore, auth, pg_temp;

CREATE OR REPLACE FUNCTION politicore.current_tenant_id()
RETURNS uuid AS $$
  SELECT tenant_id FROM politicore.profiles WHERE id = auth.uid();
$$ LANGUAGE sql STABLE SECURITY DEFINER SET search_path = politicore, auth, pg_temp;

CREATE OR REPLACE FUNCTION politicore.current_access_role()
RETURNS politicore.access_role_enum AS $$
  SELECT access_role FROM politicore.profiles WHERE id = auth.uid();
$$ LANGUAGE sql STABLE SECURITY DEFINER SET search_path = politicore, auth, pg_temp;

CREATE OR REPLACE FUNCTION politicore.is_platform_admin()
RETURNS boolean AS $$
  SELECT politicore.current_access_role() = 'platform_super_admin';
$$ LANGUAGE sql STABLE;

CREATE OR REPLACE FUNCTION politicore.is_tenant_admin()
RETURNS boolean AS $$
  SELECT politicore.current_access_role() IN ('admin', 'tenant_super_admin');
$$ LANGUAGE sql STABLE;

CREATE OR REPLACE FUNCTION politicore.is_admin()
RETURNS boolean AS $$
  SELECT politicore.is_platform_admin() OR politicore.is_tenant_admin();
$$ LANGUAGE sql STABLE;

CREATE OR REPLACE FUNCTION politicore.is_election_officer()
RETURNS boolean AS $$
  SELECT politicore.current_access_role() = 'election_officer';
$$ LANGUAGE sql STABLE;

-- membership check (membership ≠ authority — gates eligibility surfaces only)
CREATE OR REPLACE FUNCTION politicore.has_membership(m politicore.membership_type_enum)
RETURNS boolean AS $$
  SELECT m IN (
    SELECT unnest(p.membership_types) FROM politicore.profiles p WHERE p.id = auth.uid()
  );
$$ LANGUAGE sql STABLE;

-- module gate: tenant has enabled the module
CREATE OR REPLACE FUNCTION politicore.module_enabled(m politicore.module_code_enum)
RETURNS boolean AS $$
  SELECT EXISTS (
    SELECT 1 FROM politicore.tenant_modules tm
    WHERE tm.tenant_id = politicore.current_tenant_id()
      AND tm.module = m
      AND tm.enabled
  );
$$ LANGUAGE sql STABLE SECURITY DEFINER SET search_path = politicore, auth, pg_temp;

-- ---------------------------------------------------------------------
-- Geographic scope resolution (replaces user_access materialization)
-- ---------------------------------------------------------------------
-- Resolves the ancestor chain of a scope: (scope_type, scope_id) ->
-- all (type, id) pairs from the scope itself up to state, plus 'campaign'.
CREATE OR REPLACE FUNCTION politicore.scope_chain(
  p_type politicore.scope_type_enum,
  p_id text
) RETURNS TABLE (scope_type politicore.scope_type_enum, scope_id text) AS $$
  WITH chain AS (
    -- polling_unit: PU -> ward -> lga -> zone -> state
    SELECT 'polling_unit'::politicore.scope_type_enum AS st, p_id AS sid
    WHERE p_type = 'polling_unit'
    UNION ALL
    SELECT 'ward', w.id FROM politicore.polling_units pu
      JOIN politicore.wards w ON w.id = pu.ward_id WHERE p_type='polling_unit' AND pu.id = p_id
    UNION ALL
    SELECT 'lga', pu.lga_id FROM politicore.polling_units pu WHERE p_type='polling_unit' AND pu.id = p_id
    UNION ALL
    SELECT 'senatorial_zone', lg.zone_id FROM politicore.polling_units pu
      JOIN politicore.lgas lg ON lg.id = pu.lga_id WHERE p_type='polling_unit' AND pu.id = p_id
    UNION ALL
    SELECT 'state', lg.state_id FROM politicore.polling_units pu
      JOIN politicore.lgas lg ON lg.id = pu.lga_id WHERE p_type='polling_unit' AND pu.id = p_id

    -- ward: ward -> lga -> zone -> state
    UNION ALL
    SELECT 'ward', p_id WHERE p_type = 'ward'
    UNION ALL
    SELECT 'lga', w.lga_id FROM politicore.wards w WHERE p_type='ward' AND w.id = p_id
    UNION ALL
    SELECT 'senatorial_zone', lg.zone_id FROM politicore.wards w
      JOIN politicore.lgas lg ON lg.id = w.lga_id WHERE p_type='ward' AND w.id = p_id
    UNION ALL
    SELECT 'state', lg.state_id FROM politicore.wards w
      JOIN politicore.lgas lg ON lg.id = w.lga_id WHERE p_type='ward' AND w.id = p_id

    -- lga: lga -> zone -> state
    UNION ALL
    SELECT 'lga', p_id WHERE p_type = 'lga'
    UNION ALL
    SELECT 'senatorial_zone', lg.zone_id FROM politicore.lgas lg WHERE p_type='lga' AND lg.id = p_id
    UNION ALL
    SELECT 'state', lg.state_id FROM politicore.lgas lg WHERE p_type='lga' AND lg.id = p_id

    -- senatorial_zone: zone -> state
    UNION ALL
    SELECT 'senatorial_zone', p_id WHERE p_type = 'senatorial_zone'
    UNION ALL
    SELECT 'state', z.state_id FROM politicore.senatorial_zones z WHERE p_type='senatorial_zone' AND z.id = p_id

    -- state
    UNION ALL
    SELECT 'state', p_id WHERE p_type = 'state'

    -- campaign covers everything (legacy scope)
    UNION ALL
    SELECT 'campaign'::politicore.scope_type_enum, ''::text
  )
  SELECT st AS scope_type, sid AS scope_id FROM chain;
$$ LANGUAGE sql STABLE;

-- Does a source scope COVER a target scope? (hierarchical: ward -> its PUs, etc.)
-- A source covers a target when the source is an ancestor-or-self of the target:
--   scope_covers('ward','W', 'polling_unit','P') == scope_chain('polling_unit','P') contains ('ward','W')
-- State and campaign scopes cover everything (legacy semantics preserved).
CREATE OR REPLACE FUNCTION politicore.scope_covers(
  src_type politicore.scope_type_enum,
  src_id text,
  tgt_type politicore.scope_type_enum,
  tgt_id text
) RETURNS boolean AS $$
  SELECT src_type IN ('campaign', 'state')
      OR (src_type, src_id) IN (
        SELECT c.scope_type, c.scope_id
        FROM politicore.scope_chain(tgt_type, tgt_id) c
      );
$$ LANGUAGE sql STABLE;

-- All scopes a user's ACTIVE assignments cover.
CREATE OR REPLACE FUNCTION politicore.my_scopes()
RETURNS TABLE (position_name text, scope_type politicore.scope_type_enum, scope_id text) AS $$
  SELECT a.position, a.scope_type, a.scope_id
  FROM politicore.organizational_assignments a
  WHERE a.user_id = auth.uid() AND a.status = 'active'
    AND (a.ends_at IS NULL OR a.ends_at > now())
    AND (a.starts_at IS NULL OR a.starts_at <= now());
$$ LANGUAGE sql STABLE;

-- ---------------------------------------------------------------------
-- Central permission resolver (mirrors src/lib/permissions.ts semantics)
--   1. admins: everything (tenant- and platform-scoped respectively)
--   2. election_officer: fixed election-domain set
--   3. explicit grants (deny wins) — scoped or global
--   4. position defaults at a covering scope
-- ---------------------------------------------------------------------
CREATE OR REPLACE FUNCTION politicore.has_permission(
  p_permission text,
  p_scope_type politicore.scope_type_enum DEFAULT NULL,
  p_scope_id text DEFAULT NULL
) RETURNS boolean AS $$
  WITH ctx AS (SELECT * FROM politicore.current_profile())
  SELECT
    CASE
      WHEN (SELECT access_role FROM ctx) IN ('admin','tenant_super_admin','platform_super_admin')
        THEN true
      WHEN (SELECT access_role FROM ctx) = 'election_officer'
        THEN p_permission IN ('view_dashboard','submit_election_pu_report',
             'submit_election_incident','upload_election_result','view_election_dashboard')
      ELSE
        -- Explicit grants (mirrors src/lib/permissions.ts):
        --   any covering DENY  => false (deny wins over everything)
        --   else any covering ALLOW => true
        --   else fall through to position defaults at a covering scope
        CASE
          WHEN EXISTS (
            SELECT 1 FROM politicore.permission_grants g
            WHERE g.user_id = auth.uid() AND g.permission = p_permission
              AND g.granted = false
              AND (g.scope_type IS NULL OR
                   (p_scope_type IS NOT NULL AND politicore.scope_covers(g.scope_type, g.scope_id, p_scope_type, p_scope_id)))
          ) THEN false
          WHEN EXISTS (
            SELECT 1 FROM politicore.permission_grants g
            WHERE g.user_id = auth.uid() AND g.permission = p_permission
              AND g.granted = true
              AND (g.scope_type IS NULL OR
                   (p_scope_type IS NOT NULL AND politicore.scope_covers(g.scope_type, g.scope_id, p_scope_type, p_scope_id)))
          ) THEN true
          ELSE
            EXISTS (
              SELECT 1 FROM politicore.my_scopes() s
              JOIN politicore.position_permissions pp ON pp.position = s.position_name
              WHERE pp.permission = p_permission
                AND (p_scope_type IS NULL OR politicore.scope_covers(s.scope_type, s.scope_id, p_scope_type, p_scope_id))
            )
        END
    END;
$$ LANGUAGE sql STABLE;

-- Any-assignment coverage test (no permission involved) for row policies
-- that authorize by "operates at this scope" regardless of permission.
CREATE OR REPLACE FUNCTION politicore.has_assignment_at(
  p_scope_type politicore.scope_type_enum,
  p_scope_id text
) RETURNS boolean AS $$
  SELECT EXISTS (
    SELECT 1 FROM politicore.my_scopes() s
    WHERE (p_scope_type IS NULL OR
           politicore.scope_covers(s.scope_type, s.scope_id, p_scope_type, p_scope_id))
  );
$$ LANGUAGE sql STABLE;

-- ---------------------------------------------------------------------
-- Enable RLS on every table
-- ---------------------------------------------------------------------
ALTER TABLE politicore.tenants                    ENABLE ROW LEVEL SECURITY;
ALTER TABLE politicore.tenants                    FORCE ROW LEVEL SECURITY;
ALTER TABLE politicore.tenant_modules             ENABLE ROW LEVEL SECURITY;
ALTER TABLE politicore.tenant_modules             FORCE ROW LEVEL SECURITY;
ALTER TABLE politicore.platform_settings          ENABLE ROW LEVEL SECURITY;
ALTER TABLE politicore.platform_settings          FORCE ROW LEVEL SECURITY;
ALTER TABLE politicore.tenant_settings            ENABLE ROW LEVEL SECURITY;
ALTER TABLE politicore.tenant_settings            FORCE ROW LEVEL SECURITY;
ALTER TABLE politicore.public_site_settings       ENABLE ROW LEVEL SECURITY;
ALTER TABLE politicore.public_site_settings       FORCE ROW LEVEL SECURITY;
ALTER TABLE politicore.profiles                   ENABLE ROW LEVEL SECURITY;
ALTER TABLE politicore.profiles                   FORCE ROW LEVEL SECURITY;
ALTER TABLE politicore.positions                  ENABLE ROW LEVEL SECURITY;
ALTER TABLE politicore.positions                  FORCE ROW LEVEL SECURITY;
ALTER TABLE politicore.permissions                ENABLE ROW LEVEL SECURITY;
ALTER TABLE politicore.permissions                FORCE ROW LEVEL SECURITY;
ALTER TABLE politicore.position_permissions       ENABLE ROW LEVEL SECURITY;
ALTER TABLE politicore.position_permissions       FORCE ROW LEVEL SECURITY;
ALTER TABLE politicore.organizational_assignments ENABLE ROW LEVEL SECURITY;
ALTER TABLE politicore.organizational_assignments FORCE ROW LEVEL SECURITY;
ALTER TABLE politicore.permission_grants          ENABLE ROW LEVEL SECURITY;
ALTER TABLE politicore.permission_grants          FORCE ROW LEVEL SECURITY;
ALTER TABLE politicore.states                     ENABLE ROW LEVEL SECURITY;
ALTER TABLE politicore.states                     FORCE ROW LEVEL SECURITY;
ALTER TABLE politicore.senatorial_zones           ENABLE ROW LEVEL SECURITY;
ALTER TABLE politicore.senatorial_zones           FORCE ROW LEVEL SECURITY;
ALTER TABLE politicore.lgas                       ENABLE ROW LEVEL SECURITY;
ALTER TABLE politicore.lgas                       FORCE ROW LEVEL SECURITY;
ALTER TABLE politicore.wards                      ENABLE ROW LEVEL SECURITY;
ALTER TABLE politicore.wards                      FORCE ROW LEVEL SECURITY;
ALTER TABLE politicore.polling_units              ENABLE ROW LEVEL SECURITY;
ALTER TABLE politicore.polling_units              FORCE ROW LEVEL SECURITY;
ALTER TABLE politicore.media_assets               ENABLE ROW LEVEL SECURITY;
ALTER TABLE politicore.media_assets               FORCE ROW LEVEL SECURITY;
ALTER TABLE politicore.system_audits              ENABLE ROW LEVEL SECURITY;
ALTER TABLE politicore.system_audits              FORCE ROW LEVEL SECURITY;
ALTER TABLE politicore.notifications              ENABLE ROW LEVEL SECURITY;
ALTER TABLE politicore.notifications              FORCE ROW LEVEL SECURITY;

-- ---------------------------------------------------------------------
-- Policies — general patterns:
--   * reference/geography: world-readable, admin-writable (platform admin)
--   * tenant-owned: tenant isolation, no cross-tenant anything
--   * default-deny for roles with no policy (service_role bypasses via role)
-- ---------------------------------------------------------------------

-- tenants: platform admin full; tenant admin reads own; members read own
CREATE POLICY tenants_platform_admin ON politicore.tenants
  FOR ALL USING (politicore.is_platform_admin());
CREATE POLICY tenants_read_own ON politicore.tenants
  FOR SELECT USING (id = politicore.current_tenant_id());

-- tenant_modules: members read own tenant's; tenant admin manage
CREATE POLICY tenant_modules_read ON politicore.tenant_modules
  FOR SELECT USING (tenant_id = politicore.current_tenant_id() OR politicore.is_platform_admin());
CREATE POLICY tenant_modules_admin ON politicore.tenant_modules
  FOR ALL USING (tenant_id = politicore.current_tenant_id() AND politicore.is_tenant_admin());

-- platform_settings: platform admin only
CREATE POLICY platform_settings_admin ON politicore.platform_settings
  FOR ALL USING (politicore.is_platform_admin());

-- tenant_settings: admin manage own; members read
CREATE POLICY tenant_settings_read ON politicore.tenant_settings
  FOR SELECT USING (tenant_id = politicore.current_tenant_id() OR politicore.is_platform_admin());
CREATE POLICY tenant_settings_admin ON politicore.tenant_settings
  FOR ALL USING (tenant_id = politicore.current_tenant_id() AND politicore.is_tenant_admin());

-- public_site_settings: public read (anon + authed); tenant admin write
CREATE POLICY public_site_settings_read ON politicore.public_site_settings
  FOR SELECT USING (true);
CREATE POLICY public_site_settings_admin ON politicore.public_site_settings
  FOR ALL USING (tenant_id = politicore.current_tenant_id() AND politicore.is_tenant_admin());

-- profiles: self + tenant admins + same-tenant members (directory).
-- Self-update restricted by trigger to non-privilege fields.
CREATE POLICY profiles_read ON politicore.profiles
  FOR SELECT USING (
    id = auth.uid()
    OR tenant_id = politicore.current_tenant_id()
    OR politicore.is_platform_admin()
  );
CREATE POLICY profiles_insert_admin ON politicore.profiles
  FOR INSERT WITH CHECK (tenant_id = politicore.current_tenant_id() AND politicore.is_tenant_admin());
CREATE POLICY profiles_update_self_or_admin ON politicore.profiles
  FOR UPDATE USING (
    id = auth.uid()
    OR (tenant_id = politicore.current_tenant_id() AND politicore.is_tenant_admin())
  );
CREATE POLICY profiles_delete_admin ON politicore.profiles
  FOR DELETE USING (tenant_id = politicore.current_tenant_id() AND politicore.is_tenant_admin());

-- Authorization reference data: readable by authenticated users; platform-admin writable
CREATE POLICY positions_read ON politicore.positions FOR SELECT USING (true);
CREATE POLICY positions_admin ON politicore.positions FOR ALL USING (politicore.is_platform_admin());
CREATE POLICY permissions_read ON politicore.permissions FOR SELECT USING (true);
CREATE POLICY permissions_admin ON politicore.permissions FOR ALL USING (politicore.is_platform_admin());
CREATE POLICY position_permissions_read ON politicore.position_permissions FOR SELECT USING (true);
CREATE POLICY position_permissions_admin ON politicore.position_permissions FOR ALL USING (politicore.is_platform_admin());

-- organizational_assignments: own + tenant admins
CREATE POLICY assignments_read ON politicore.organizational_assignments
  FOR SELECT USING (
    user_id = auth.uid()
    OR (tenant_id = politicore.current_tenant_id() AND politicore.is_tenant_admin())
    OR politicore.is_platform_admin()
  );
CREATE POLICY assignments_admin ON politicore.organizational_assignments
  FOR ALL USING (tenant_id = politicore.current_tenant_id() AND politicore.is_tenant_admin());

-- permission_grants: own + tenant admins
CREATE POLICY grants_read ON politicore.permission_grants
  FOR SELECT USING (
    user_id = auth.uid()
    OR (tenant_id = politicore.current_tenant_id() AND politicore.is_tenant_admin())
    OR politicore.is_platform_admin()
  );
CREATE POLICY grants_admin ON politicore.permission_grants
  FOR ALL USING (tenant_id = politicore.current_tenant_id() AND politicore.is_tenant_admin());

-- Geography: world-readable (public reference), platform-admin writable
CREATE POLICY states_read ON politicore.states FOR SELECT USING (true);
CREATE POLICY states_admin ON politicore.states FOR ALL USING (politicore.is_platform_admin());
CREATE POLICY zones_read ON politicore.senatorial_zones FOR SELECT USING (true);
CREATE POLICY zones_admin ON politicore.senatorial_zones FOR ALL USING (politicore.is_platform_admin());
CREATE POLICY lgas_read ON politicore.lgas FOR SELECT USING (true);
CREATE POLICY lgas_admin ON politicore.lgas FOR ALL USING (politicore.is_platform_admin());
CREATE POLICY wards_read ON politicore.wards FOR SELECT USING (true);
CREATE POLICY wards_admin ON politicore.wards FOR ALL USING (politicore.is_platform_admin());
CREATE POLICY pus_read ON politicore.polling_units FOR SELECT USING (true);
CREATE POLICY pus_admin ON politicore.polling_units FOR ALL USING (politicore.is_platform_admin());

-- media_assets: tenant isolation; visibility column is a registry hint —
-- actual object access is via Media Service signed/public URLs.
CREATE POLICY media_read ON politicore.media_assets
  FOR SELECT USING (tenant_id = politicore.current_tenant_id() OR politicore.is_platform_admin());
CREATE POLICY media_write ON politicore.media_assets
  FOR INSERT WITH CHECK (tenant_id = politicore.current_tenant_id());
CREATE POLICY media_update ON politicore.media_assets
  FOR UPDATE USING (tenant_id = politicore.current_tenant_id());
CREATE POLICY media_delete ON politicore.media_assets
  FOR DELETE USING (tenant_id = politicore.current_tenant_id() AND politicore.is_tenant_admin());

-- system_audits: admin read-only; writes go through SECURITY DEFINER only.
-- No INSERT policy => inserts by authenticated/anon roles are denied (default deny).
CREATE POLICY audits_read ON politicore.system_audits
  FOR SELECT USING (tenant_id = politicore.current_tenant_id() OR politicore.is_platform_admin());

-- notifications: strictly per-user rows
CREATE POLICY notifications_user ON politicore.notifications
  FOR SELECT USING (user_id = auth.uid() OR politicore.is_platform_admin());
CREATE POLICY notifications_insert_admin ON politicore.notifications
  FOR INSERT WITH CHECK (
    tenant_id = politicore.current_tenant_id() AND politicore.is_tenant_admin()
  );
CREATE POLICY notifications_update_own ON politicore.notifications
  FOR UPDATE USING (user_id = auth.uid());

-- ---------------------------------------------------------------------
-- Profile self-update guard: users can never change their own tenant,
-- access_role, membership_types, lifecycle_status, points (authority
-- fields). Tenant admins bypass via admin policies.
-- ---------------------------------------------------------------------
CREATE OR REPLACE FUNCTION politicore.guard_profile_self_update()
RETURNS trigger AS $$
BEGIN
  IF NEW.id = auth.uid() AND NOT politicore.is_tenant_admin() THEN
    IF NEW.tenant_id       <> OLD.tenant_id
    OR NEW.access_role     <> OLD.access_role
    OR NEW.membership_types <> OLD.membership_types
    OR NEW.lifecycle_status <> OLD.lifecycle_status
    OR NEW.points          <> OLD.points
    OR NEW.rank            <> OLD.rank THEN
      RAISE EXCEPTION 'self-update of authority fields is not permitted';
    END IF;
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER SET search_path = politicore, auth, pg_temp;

CREATE TRIGGER trg_profiles_guard_update
  BEFORE UPDATE ON politicore.profiles
  FOR EACH ROW EXECUTE FUNCTION politicore.guard_profile_self_update();

-- ---------------------------------------------------------------------
-- Audit trigger: tenant-admin writes to authority tables land in
-- system_audits (server-side — fixes client-writes-audit latent bug).
-- ---------------------------------------------------------------------
CREATE OR REPLACE FUNCTION politicore.audit_authority_change()
RETURNS trigger AS $$
DECLARE
  v_old jsonb; v_new jsonb; v_tenant uuid; v_actor uuid;
BEGIN
  v_actor := auth.uid();
  IF TG_OP = 'DELETE' THEN v_old := to_jsonb(OLD); v_new := NULL;
  ELSE v_old := to_jsonb(OLD); v_new := to_jsonb(NEW); END IF;
  v_tenant := COALESCE(v_new->>'tenant_id', v_old->>'tenant_id')::uuid;
  INSERT INTO politicore.system_audits
    (tenant_id, actor_id, action, affected_resource, resource_id, old_value, new_value)
  VALUES
    (v_tenant, v_actor,
     TG_TABLE_NAME || ':' || lower(TG_OP),
     TG_TABLE_NAME,
     COALESCE(v_new->>'id', v_old->>'id'),
     v_old, v_new);
  RETURN NULL;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER SET search_path = politicore, auth, pg_temp;

CREATE TRIGGER trg_audit_assignments
  AFTER INSERT OR UPDATE OR DELETE ON politicore.organizational_assignments
  FOR EACH ROW EXECUTE FUNCTION politicore.audit_authority_change();
CREATE TRIGGER trg_audit_grants
  AFTER INSERT OR UPDATE OR DELETE ON politicore.permission_grants
  FOR EACH ROW EXECUTE FUNCTION politicore.audit_authority_change();
CREATE TRIGGER trg_audit_profiles
  AFTER UPDATE OF access_role, membership_types, lifecycle_status ON politicore.profiles
  FOR EACH ROW EXECUTE FUNCTION politicore.audit_authority_change();
