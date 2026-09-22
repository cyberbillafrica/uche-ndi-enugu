-- =====================================================================
-- 0005: RPC WRAPPERS
-- Client-callable authorization helpers. SECURITY INVOKER (default) so
-- RLS still applies to everything the caller can see; the wrappers only
-- provide a stable RPC surface with named arguments.
-- =====================================================================

CREATE OR REPLACE FUNCTION politicore.politicore_has_permission(
  p_permission text,
  p_scope_type politicore.scope_type_enum DEFAULT NULL,
  p_scope_id text DEFAULT NULL
) RETURNS boolean AS $$ -- SECURITY INVOKER: caller's own RLS applies
  SELECT politicore.has_permission(p_permission, p_scope_type, p_scope_id);
$$ LANGUAGE sql STABLE;

CREATE OR REPLACE FUNCTION politicore.my_tenant_id() RETURNS uuid AS $$
  SELECT politicore.current_tenant_id();
$$ LANGUAGE sql STABLE;

CREATE OR REPLACE FUNCTION politicore.my_access_role() RETURNS politicore.access_role_enum AS $$
  SELECT politicore.current_access_role();
$$ LANGUAGE sql STABLE;

CREATE OR REPLACE FUNCTION politicore.my_module_enabled(m politicore.module_code_enum) RETURNS boolean AS $$
  SELECT politicore.module_enabled(m);
$$ LANGUAGE sql STABLE;

CREATE OR REPLACE FUNCTION politicore.my_scopes_rpc()
RETURNS TABLE (position_name text, scope_type politicore.scope_type_enum, scope_id text) AS $$
  SELECT * FROM politicore.my_scopes();
$$ LANGUAGE sql STABLE;
