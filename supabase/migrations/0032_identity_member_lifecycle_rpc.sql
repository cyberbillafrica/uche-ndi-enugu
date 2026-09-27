-- POLITICORE — MIGRATION 0032: IDENTITY MEMBER LIFECYCLE RPC.
--
-- Core Identity/Auth migration sequence, Member Directory cutover (Phase 3).
-- The admin member-directory cutover moves the lifecycle status control
-- (suspend / deactivate / reactivate) from the legacy Firebase
-- updateUserLifecycleStatus helper to the canonical Supabase substrate.
--
-- 0027 grant hygiene intentionally made public.politicore_profiles
-- SELECT-only for application roles: profile identity rows must never
-- flow client writes through the view. Lifecycle is an authority field
-- (0002 trg_audit_profiles audits UPDATE OF lifecycle_status), so the
-- write must be a server-side authority operation, not a client UPDATE.
--
-- This migration restores the directory's lifecycle contract WITHOUT
-- reopening the view, mirroring the 0031 enrichment RPC exactly:
--
--   * actor is server-resolved (auth.uid()); no caller argument reaches
--     the WHERE clause beyond the target profile id;
--   * the caller must be a same-tenant tenant admin (resolved inside);
--     everyone else fails closed with an exception;
--   * the ONLY writable field is lifecycle_status (+ status_reason —
--     the documented companion field the directory UI collects);
--   * the target must be a same-tenant profile;
--   * the write lands in system_audits through the existing 0002 audit
--     trigger (UPDATE OF lifecycle_status).
--
-- No view grant changes. No RLS changes. No new authorization resolver.

CREATE OR REPLACE FUNCTION politicore.admin_set_member_lifecycle(
  p_profile_id uuid,
  p_lifecycle_status politicore.lifecycle_status_enum,
  p_status_reason text DEFAULT NULL
)
RETURNS uuid
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = politicore, pg_temp
AS $$
DECLARE
  v_actor uuid := auth.uid();
  v_actor_is_admin boolean;
  v_tenant uuid;
  v_updated uuid;
BEGIN
  IF v_actor IS NULL THEN
    RAISE EXCEPTION 'admin_set_member_lifecycle: unauthenticated caller';
  END IF;

  SELECT access_role = 'admin' OR access_role = 'tenant_super_admin', tenant_id
    INTO v_actor_is_admin, v_tenant
    FROM politicore.profiles WHERE id = v_actor;

  IF v_actor_is_admin IS NOT TRUE THEN
    RAISE EXCEPTION 'admin_set_member_lifecycle: caller is not a tenant admin';
  END IF;

  UPDATE politicore.profiles AS p SET
    lifecycle_status = p_lifecycle_status,
    status_reason    = p_status_reason,
    updated_at       = now()
  WHERE p.id = p_profile_id
    AND p.tenant_id = v_tenant          -- same-tenant bound (server-resolved)
  RETURNING p.id INTO v_updated;

  IF v_updated IS NULL THEN
    RAISE EXCEPTION 'admin_set_member_lifecycle: target profile not found in caller tenant';
  END IF;

  RETURN v_updated;
END;
$$;

-- PostgREST surface: authenticated callers may execute; the function
-- itself rejects everyone who is not a same-tenant tenant admin.
GRANT EXECUTE ON FUNCTION politicore.admin_set_member_lifecycle(
  uuid, politicore.lifecycle_status_enum, text)
TO authenticated;

-- Wrapper for the public data API (the hosted PostgREST path).
CREATE OR REPLACE FUNCTION public.admin_set_member_lifecycle(
  p_profile_id uuid,
  p_lifecycle_status politicore.lifecycle_status_enum,
  p_status_reason text DEFAULT NULL
)
RETURNS uuid
LANGUAGE sql
SET search_path = politicore, pg_temp
AS $$
  SELECT politicore.admin_set_member_lifecycle(p_profile_id, p_lifecycle_status, p_status_reason);
$$;

REVOKE ALL ON FUNCTION public.admin_set_member_lifecycle(
  uuid, politicore.lifecycle_status_enum, text) FROM anon, authenticated;
GRANT EXECUTE ON FUNCTION public.admin_set_member_lifecycle(
  uuid, politicore.lifecycle_status_enum, text)
TO authenticated;
