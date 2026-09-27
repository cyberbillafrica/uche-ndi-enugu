-- POLITICORE — MIGRATION 0031: IDENTITY ADMIN PROFILE-ENRICHMENT RPC.
--
-- Core Identity/Auth Phase 1 prerequisite. The Campaign Final Lock Gate's
-- grant hygiene (0027) correctly narrowed public.politicore_profiles to
-- SELECT-only for application roles — profile identity rows must never
-- flow client writes through the view. That narrowing also removed the
-- only transport an authenticated tenant admin had to enrich a member
-- profile after provisioning (the established admin member-add contract:
-- signup provisions the plain profile, then the admin applies the
-- member's phone/location/handles/memberships/access_role).
--
-- This migration restores that contract WITHOUT reopening the view:
-- a SECURITY DEFINER RPC that performs the exact same guarded UPDATE
-- the 0002 admin policy already authorizes, server-side:
--
--   * actor is server-resolved (auth.uid()); no caller arguments reach
--     the WHERE clause beyond the target profile id;
--   * the function sets is_tenant_admin() context internally — a
--     non-admin caller produces zero updated rows (fail closed);
--   * authority fields (tenant_id, points, rank, lifecycle) are NOT in
--     the writable set; the 0002 self-update guard still backs the
--     base-table trigger even for admins;
--   * the target must be a same-tenant profile (implicit via the
--     actor's own tenant resolution);
--   * the write lands in system_audits through the existing 0002 audit
--     trigger (UPDATE OF access_role/membership_types).
--
-- No view grant changes. No RLS changes. No new authorization resolver.

CREATE OR REPLACE FUNCTION politicore.admin_enrich_member_profile(
  p_profile_id uuid,
  p_phone text DEFAULT NULL,
  p_lga_id text DEFAULT NULL,
  p_ward_id text DEFAULT NULL,
  p_polling_unit_id text DEFAULT NULL,
  p_membership_types politicore.membership_type_enum[] DEFAULT NULL,
  p_access_role politicore.access_role_enum DEFAULT NULL,
  p_facebook_name text DEFAULT NULL,
  p_facebook_url text DEFAULT NULL,
  p_x_name text DEFAULT NULL,
  p_x_url text DEFAULT NULL,
  p_instagram_name text DEFAULT NULL,
  p_instagram_url text DEFAULT NULL,
  p_tiktok_name text DEFAULT NULL,
  p_tiktok_url text DEFAULT NULL
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
    RAISE EXCEPTION 'admin_enrich_member_profile: unauthenticated caller';
  END IF;

  SELECT access_role = 'admin' OR access_role = 'tenant_super_admin', tenant_id
    INTO v_actor_is_admin, v_tenant
    FROM politicore.profiles WHERE id = v_actor;

  IF v_actor_is_admin IS NOT TRUE THEN
    RAISE EXCEPTION 'admin_enrich_member_profile: caller is not a tenant admin';
  END IF;

  -- Fail closed when the caller passes nothing to set.
  IF p_phone IS NULL AND p_lga_id IS NULL AND p_ward_id IS NULL
     AND p_polling_unit_id IS NULL AND p_membership_types IS NULL
     AND p_access_role IS NULL
     AND p_facebook_name IS NULL AND p_facebook_url IS NULL
     AND p_x_name IS NULL AND p_x_url IS NULL
     AND p_instagram_name IS NULL AND p_instagram_url IS NULL
     AND p_tiktok_name IS NULL AND p_tiktok_url IS NULL THEN
    RAISE EXCEPTION 'admin_enrich_member_profile: no fields to update';
  END IF;

  UPDATE politicore.profiles AS p SET
    phone             = COALESCE(p_phone, p.phone),
    lga_id            = COALESCE(p_lga_id, p.lga_id),
    ward_id           = COALESCE(p_ward_id, p.ward_id),
    polling_unit_id   = COALESCE(p_polling_unit_id, p.polling_unit_id),
    membership_types  = COALESCE(p_membership_types, p.membership_types),
    access_role       = COALESCE(p_access_role, p.access_role),
    facebook_name     = COALESCE(p_facebook_name, p.facebook_name),
    facebook_url      = COALESCE(p_facebook_url, p.facebook_url),
    x_name            = COALESCE(p_x_name, p.x_name),
    x_url             = COALESCE(p_x_url, p.x_url),
    instagram_name    = COALESCE(p_instagram_name, p.instagram_name),
    instagram_url     = COALESCE(p_instagram_url, p.instagram_url),
    tiktok_name       = COALESCE(p_tiktok_name, p.tiktok_name),
    tiktok_url        = COALESCE(p_tiktok_url, p.tiktok_url),
    updated_at        = now()
  WHERE p.id = p_profile_id
    AND p.tenant_id = v_tenant          -- same-tenant bound (server-resolved)
  RETURNING p.id INTO v_updated;

  IF v_updated IS NULL THEN
    RAISE EXCEPTION 'admin_enrich_member_profile: target profile not found in caller tenant';
  END IF;

  RETURN v_updated;
END;
$$;

-- PostgREST surface: authenticated callers may execute; the function
-- itself rejects everyone who is not a same-tenant tenant admin.
GRANT EXECUTE ON FUNCTION politicore.admin_enrich_member_profile(
  uuid, text, text, text, text,
  politicore.membership_type_enum[], politicore.access_role_enum,
  text, text, text, text, text, text, text, text)
TO authenticated;

-- Wrapper for the public data API (the hosted PostgREST path).
CREATE OR REPLACE FUNCTION public.admin_enrich_member_profile(
  p_profile_id uuid,
  p_phone text DEFAULT NULL,
  p_lga_id text DEFAULT NULL,
  p_ward_id text DEFAULT NULL,
  p_polling_unit_id text DEFAULT NULL,
  p_membership_types politicore.membership_type_enum[] DEFAULT NULL,
  p_access_role politicore.access_role_enum DEFAULT NULL,
  p_facebook_name text DEFAULT NULL,
  p_facebook_url text DEFAULT NULL,
  p_x_name text DEFAULT NULL,
  p_x_url text DEFAULT NULL,
  p_instagram_name text DEFAULT NULL,
  p_instagram_url text DEFAULT NULL,
  p_tiktok_name text DEFAULT NULL,
  p_tiktok_url text DEFAULT NULL
)
RETURNS uuid
LANGUAGE sql
SET search_path = politicore, pg_temp
AS $$
  SELECT politicore.admin_enrich_member_profile(
    p_profile_id, p_phone, p_lga_id, p_ward_id, p_polling_unit_id,
    p_membership_types, p_access_role,
    p_facebook_name, p_facebook_url, p_x_name, p_x_url,
    p_instagram_name, p_instagram_url, p_tiktok_name, p_tiktok_url);
$$;

REVOKE ALL ON FUNCTION public.admin_enrich_member_profile(
  uuid, text, text, text, text,
  politicore.membership_type_enum[], politicore.access_role_enum,
  text, text, text, text, text, text, text, text) FROM anon, authenticated;
GRANT EXECUTE ON FUNCTION public.admin_enrich_member_profile(
  uuid, text, text, text, text,
  politicore.membership_type_enum[], politicore.access_role_enum,
  text, text, text, text, text, text, text, text)
TO authenticated;
