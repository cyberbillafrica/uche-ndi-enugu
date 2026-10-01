-- ============================================================================
-- 0061 — WEBSITE EXPERIENCE CONFIGURATION (Phase 23)
-- ============================================================================
-- Control Center — Website Experience: Branding, Theme & SEO.
--
-- Architecture: docs/Control-Center-Architecture-Gate.md (§15–§20) and the
-- Phase 22 configuration foundation (0060). Zero new tables — the existing
-- politicore.public_site_settings areas `branding` and `seo` remain the sole
-- substrate, extended ONLY through the established RPC pattern:
--
--   A. VALIDATORS      cc_validate_branding / cc_validate_seo — strict
--                      allowlists; unknown keys and unsupported values are
--                      rejected (never an arbitrary JSONB extension surface).
--   B. MEDIA BINDING   logo/favicon reference politicore.media_assets by id;
--                      the reference must be the tenant's own PUBLIC asset
--                      (Core Media stays the canonical source; no provider
--                      URLs are stored as architectural truth).
--   C. RESTATED RPCs   save_site_config_draft / publish_site_config gain
--                      validation for the branding/seo areas (same bodies,
--                      same revision/conflict semantics, same Core Audit).
--   D. PUBLIC CHROME   get_public_site_chrome(p_tenant_slug) — one published-
--                      only projection of branding + seo for public rendering
--                      (draft/history/audit keys never leave the server).
--   E. ADMIN PREVIEW   get_site_config_preview(p_area) — is_tenant_admin-
--                      gated draft read for authenticated preview surfaces.
-- ============================================================================

-- ───────────────────────────────────────────────────────────────────────────
-- A. BRANDING VALIDATOR — strict allowlist (gate §5, §9)
--    tokens: the §7 semantic vocabulary; hex colors only.
--    typography: heading/body ∈ (sans, serif, mono); radius ∈ fixed set.
--    preset: apc | pdp | ndc | custom — a VISUAL bundle label only (§8).
-- ───────────────────────────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION politicore.cc_validate_branding(p_config jsonb)
RETURNS jsonb
LANGUAGE plpgsql
STABLE
SET search_path = politicore, pg_temp
AS $$
DECLARE
  v_key    text;
  v_tokens jsonb;
  v_t      jsonb;
  v_typo   jsonb;
  v_tk     text;
BEGIN
  IF p_config IS NULL OR p_config = 'null'::jsonb THEN
    RETURN '{}'::jsonb;
  END IF;
  IF jsonb_typeof(p_config) <> 'object' THEN
    RAISE EXCEPTION 'Branding configuration must be a JSON object.';
  END IF;

  -- Unknown top-level keys are rejected — no silent extension mechanism.
  FOR v_key IN SELECT jsonb_object_keys(p_config) LOOP
    IF v_key NOT IN ('site_name','preset','tokens','typography','radius',
                     'logo','favicon') THEN
      RAISE EXCEPTION 'Unknown branding configuration key "%".', v_key;
    END IF;
  END LOOP;

  IF p_config ? 'site_name' THEN
    IF jsonb_typeof(p_config->'site_name') <> 'string'
       OR length(p_config->>'site_name') = 0
       OR length(p_config->>'site_name') > 120 THEN
      RAISE EXCEPTION 'Branding site_name must be a string of 1..120 characters.';
    END IF;
  END IF;

  IF p_config ? 'preset' THEN
    IF (p_config->>'preset') NOT IN ('apc','pdp','ndc','custom') THEN
      RAISE EXCEPTION 'Unknown branding preset "%".', p_config->>'preset';
    END IF;
  END IF;

  -- Tokens: exactly the semantic vocabulary, each a strict #rrggbb color.
  IF p_config ? 'tokens' THEN
    v_tokens := p_config->'tokens';
    IF jsonb_typeof(v_tokens) <> 'object' THEN
      RAISE EXCEPTION 'Branding tokens must be a JSON object.';
    END IF;
    FOR v_key IN SELECT jsonb_object_keys(v_tokens) LOOP
      IF v_key NOT IN ('primary','secondary','accent','surface','background',
                       'text','muted','border') THEN
        RAISE EXCEPTION 'Unknown branding token "%".', v_key;
      END IF;
      v_t := v_tokens -> v_key;
      IF jsonb_typeof(v_t) <> 'string'
         OR v_t #>> '{}' !~ '^#[0-9a-fA-F]{6}$' THEN
        RAISE EXCEPTION 'Branding token "%" must be a #rrggbb color.', v_key;
      END IF;
    END LOOP;
  END IF;

  -- Typography: supported preference values only (no arbitrary CSS).
  IF p_config ? 'typography' THEN
    v_typo := p_config->'typography';
    IF jsonb_typeof(v_typo) <> 'object' THEN
      RAISE EXCEPTION 'Branding typography must be a JSON object.';
    END IF;
    FOR v_tk IN SELECT jsonb_object_keys(v_typo) LOOP
      IF v_tk NOT IN ('heading','body') THEN
        RAISE EXCEPTION 'Unknown typography preference "%".', v_tk;
      END IF;
      IF (v_typo->>v_tk) NOT IN ('sans','serif','mono') THEN
        RAISE EXCEPTION 'Typography preference "%" must be sans, serif or mono.', v_tk;
      END IF;
    END LOOP;
  END IF;

  IF p_config ? 'radius' THEN
    IF (p_config->>'radius') NOT IN ('none','sm','md','lg','xl','full') THEN
      RAISE EXCEPTION 'Branding radius must be none, sm, md, lg, xl or full.';
    END IF;
  END IF;

  -- Logo / favicon: canonical Core Media asset identity (§6). Structure is
  -- validated here; existence/tenancy/visibility of the asset is enforced
  -- against media_assets in cc_assert_brandable_media (below).
  IF p_config ? 'logo' THEN
    IF jsonb_typeof(p_config->'logo') <> 'object'
       OR p_config->'logo' ? 'asset_id' = false
       OR jsonb_typeof(p_config->'logo'->'asset_id') <> 'string'
       OR (p_config->'logo'->>'asset_id') !~ '^[0-9a-fA-F-]{36}$' THEN
      RAISE EXCEPTION 'Branding logo must reference a media asset id.';
    END IF;
    IF p_config->'logo' ? 'alt'
       AND (jsonb_typeof(p_config->'logo'->'alt') <> 'string'
            OR length(p_config->'logo'->>'alt') > 200) THEN
      RAISE EXCEPTION 'Branding logo alt text must be at most 200 characters.';
    END IF;
  END IF;

  IF p_config ? 'favicon' THEN
    IF jsonb_typeof(p_config->'favicon') <> 'object'
       OR p_config->'favicon' ? 'asset_id' = false
       OR jsonb_typeof(p_config->'favicon'->'asset_id') <> 'string'
       OR (p_config->'favicon'->>'asset_id') !~ '^[0-9a-fA-F-]{36}$' THEN
      RAISE EXCEPTION 'Branding favicon must reference a media asset id.';
    END IF;
  END IF;

  RETURN p_config;
END;
$$;

-- Media binding: the referenced asset must EXIST, belong to THIS tenant and
-- be PUBLIC (a logo/favicon renders on the anonymous public site). This is
-- the cross-tenant media guard (gate §16) — references cannot cross tenant
-- boundaries because the asset row itself is the authority.
CREATE OR REPLACE FUNCTION politicore.cc_assert_brandable_media(
  p_branding jsonb,
  p_tenant   uuid
)
RETURNS void
LANGUAGE plpgsql
STABLE
SET search_path = politicore, pg_temp
AS $$
DECLARE
  v_asset uuid;
BEGIN
  IF p_branding ? 'logo' THEN
    v_asset := (p_branding->'logo'->>'asset_id')::uuid;
    IF NOT EXISTS (SELECT 1 FROM politicore.media_assets
                    WHERE id = v_asset
                      AND tenant_id = p_tenant
                      AND visibility = 'public') THEN
      RAISE EXCEPTION
        'Branding logo does not reference a public media asset of this tenant.';
    END IF;
  END IF;
  IF p_branding ? 'favicon' THEN
    v_asset := (p_branding->'favicon'->>'asset_id')::uuid;
    IF NOT EXISTS (SELECT 1 FROM politicore.media_assets
                    WHERE id = v_asset
                      AND tenant_id = p_tenant
                      AND visibility = 'public') THEN
      RAISE EXCEPTION
        'Branding favicon does not reference a public media asset of this tenant.';
    END IF;
  END IF;
END;
$$;

-- ───────────────────────────────────────────────────────────────────────────
-- A2. SEO VALIDATOR — tenant-level website metadata only (gate §11, §19).
--     No per-page SEO infrastructure, no arbitrary keys.
-- ───────────────────────────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION politicore.cc_validate_seo(p_config jsonb)
RETURNS jsonb
LANGUAGE plpgsql
STABLE
SET search_path = politicore, pg_temp
AS $$
DECLARE
  v_key  text;
  v_kws  jsonb;
  v_kw   jsonb;
BEGIN
  IF p_config IS NULL OR p_config = 'null'::jsonb THEN
    RETURN '{}'::jsonb;
  END IF;
  IF jsonb_typeof(p_config) <> 'object' THEN
    RAISE EXCEPTION 'SEO configuration must be a JSON object.';
  END IF;

  FOR v_key IN SELECT jsonb_object_keys(p_config) LOOP
    IF v_key NOT IN ('title','description','og_title','og_description',
                     'keywords','canonical_url','robots') THEN
      RAISE EXCEPTION 'Unknown SEO configuration key "%".', v_key;
    END IF;
  END LOOP;

  IF p_config ? 'title' AND (jsonb_typeof(p_config->'title') <> 'string'
     OR length(p_config->>'title') = 0 OR length(p_config->>'title') > 120) THEN
    RAISE EXCEPTION 'SEO title must be a string of 1..120 characters.';
  END IF;

  IF p_config ? 'description' AND (jsonb_typeof(p_config->'description') <> 'string'
     OR length(p_config->>'description') > 300) THEN
    RAISE EXCEPTION 'SEO description must be at most 300 characters.';
  END IF;

  IF p_config ? 'og_title' AND (jsonb_typeof(p_config->'og_title') <> 'string'
     OR length(p_config->>'og_title') > 120) THEN
    RAISE EXCEPTION 'SEO og_title must be at most 120 characters.';
  END IF;

  IF p_config ? 'og_description' AND (jsonb_typeof(p_config->'og_description') <> 'string'
     OR length(p_config->>'og_description') > 300) THEN
    RAISE EXCEPTION 'SEO og_description must be at most 300 characters.';
  END IF;

  IF p_config ? 'keywords' THEN
    v_kws := p_config->'keywords';
    IF jsonb_typeof(v_kws) <> 'array' OR jsonb_array_length(v_kws) > 20 THEN
      RAISE EXCEPTION 'SEO keywords must be an array of at most 20 strings.';
    END IF;
    FOR v_kw IN SELECT * FROM jsonb_array_elements(v_kws) LOOP
      IF jsonb_typeof(v_kw) <> 'string' OR length(v_kw #>> '{}') = 0
         OR length(v_kw #>> '{}') > 60 THEN
        RAISE EXCEPTION 'SEO keywords must be strings of 1..60 characters.';
      END IF;
    END LOOP;
  END IF;

  IF p_config ? 'canonical_url' THEN
    IF jsonb_typeof(p_config->'canonical_url') <> 'string'
       OR length(p_config->>'canonical_url') > 2000
       OR (p_config->>'canonical_url') !~ '^https?://[^\s]+$' THEN
      RAISE EXCEPTION 'SEO canonical_url must be an absolute http(s) URL.';
    END IF;
  END IF;

  IF p_config ? 'robots'
     AND (p_config->>'robots') NOT IN ('index,follow','noindex,nofollow',
                                       'index,nofollow','noindex,follow') THEN
    RAISE EXCEPTION 'SEO robots must be a supported directive.';
  END IF;

  RETURN p_config;
END;
$$;

-- ───────────────────────────────────────────────────────────────────────────
-- C. RESTATED SAVE — identical Phase 22 body + branding/seo validation.
--    (Convergence restatement: same signature, same audit, same revision
--    semantics; the two validated areas run their allowlist first.)
-- ───────────────────────────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION politicore.save_site_config_draft(
  p_area         text,
  p_draft        jsonb,
  p_base_revision integer
) RETURNS integer
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = politicore, auth, pg_temp
AS $$
DECLARE
  v_tenant  uuid := politicore.current_tenant_id();
  v_current integer;
  v_ok      integer;
BEGIN
  IF v_tenant IS NULL THEN
    RAISE EXCEPTION 'Tenant context could not be resolved for the current session.';
  END IF;
  IF NOT politicore.is_tenant_admin() THEN
    RAISE EXCEPTION 'Tenant administration authority is required for configuration writes.';
  END IF;
  IF NOT politicore.cc_is_site_config_area(p_area) THEN
    RAISE EXCEPTION 'Unknown configuration area %.', p_area;
  END IF;
  IF jsonb_typeof(p_draft) <> 'object' THEN
    RAISE EXCEPTION 'Configuration draft must be a JSON object.';
  END IF;

  -- Phase 23: validated configuration areas (strict allowlists; §5/§9/§11).
  IF p_area = 'branding' THEN
    p_draft := politicore.cc_validate_branding(p_draft);
    PERFORM politicore.cc_assert_brandable_media(p_draft, v_tenant);
  ELSIF p_area = 'seo' THEN
    p_draft := politicore.cc_validate_seo(p_draft);
  END IF;

  EXECUTE format(
    'SELECT COALESCE((SELECT (%I ->> %L)::integer
                       FROM politicore.public_site_settings WHERE tenant_id = $1), 0)',
    p_area, 'revision') INTO v_current USING v_tenant;

  IF v_current <> p_base_revision THEN
    RAISE EXCEPTION 'Configuration conflict: expected revision %, current is %.', p_base_revision, v_current;
  END IF;

  EXECUTE format(
    'INSERT INTO politicore.public_site_settings (tenant_id, %I)
     VALUES ($1, $2)
     ON CONFLICT (tenant_id) DO UPDATE
       SET %I = EXCLUDED.%I,
           updated_at = now()
       WHERE COALESCE((politicore.public_site_settings.%I ->> ''revision'')::integer, 0) = $3
     RETURNING 1',
    p_area, p_area, p_area, p_area, p_area)
  INTO v_ok
  USING v_tenant,
        jsonb_build_object('revision', v_current + 1, 'draft', p_draft,
                           'updated_at', to_jsonb(now()),
                           'updated_by', to_jsonb(auth.uid())),
        p_base_revision;

  IF v_ok IS NULL THEN
    RAISE EXCEPTION 'Configuration conflict: area % was modified concurrently.', p_area;
  END IF;

  INSERT INTO politicore.system_audits
    (tenant_id, actor_id, action, affected_resource, resource_id, new_value)
  VALUES
    (v_tenant, auth.uid(),
     'site_config:' || p_area || ':draft_saved',
     'public_site_settings', v_tenant::text,
     jsonb_build_object('area', p_area, 'revision', v_current + 1));

  RETURN v_current + 1;
END;
$$;

-- ───────────────────────────────────────────────────────────────────────────
-- C2. RESTATED PUBLISH — identical Phase 22 body + validation of the draft
--     being promoted (static per-area branches preserved).
-- ───────────────────────────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION politicore.publish_site_config(
  p_area          text,
  p_base_revision integer
) RETURNS TABLE (revision integer, published_at timestamptz)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = politicore, auth, pg_temp
AS $$
DECLARE
  v_tenant uuid := politicore.current_tenant_id();
  v_row    jsonb;
  v_rev    integer;
  v_prev   jsonb;
  v_hist   jsonb;
  v_new    jsonb;
BEGIN
  IF v_tenant IS NULL THEN
    RAISE EXCEPTION 'Tenant context could not be resolved for the current session.';
  END IF;
  IF NOT politicore.is_tenant_admin() THEN
    RAISE EXCEPTION 'Tenant administration authority is required for configuration publication.';
  END IF;
  IF NOT politicore.cc_is_site_config_area(p_area) THEN
    RAISE EXCEPTION 'Unknown configuration area %.', p_area;
  END IF;

  IF p_area = 'branding' THEN
    SELECT branding INTO v_row FROM politicore.public_site_settings WHERE tenant_id = v_tenant;
  ELSIF p_area = 'navigation' THEN
    SELECT navigation INTO v_row FROM politicore.public_site_settings WHERE tenant_id = v_tenant;
  ELSIF p_area = 'footer' THEN
    SELECT footer INTO v_row FROM politicore.public_site_settings WHERE tenant_id = v_tenant;
  ELSIF p_area = 'homepage' THEN
    SELECT homepage INTO v_row FROM politicore.public_site_settings WHERE tenant_id = v_tenant;
  ELSIF p_area = 'contact' THEN
    SELECT contact INTO v_row FROM politicore.public_site_settings WHERE tenant_id = v_tenant;
  ELSIF p_area = 'social_links' THEN
    SELECT social_links INTO v_row FROM politicore.public_site_settings WHERE tenant_id = v_tenant;
  ELSIF p_area = 'seo' THEN
    SELECT seo INTO v_row FROM politicore.public_site_settings WHERE tenant_id = v_tenant;
  END IF;

  IF v_row IS NULL THEN
    RAISE EXCEPTION 'No draft configuration to publish for area %.', p_area;
  END IF;
  v_rev := COALESCE(v_row ->> 'revision', '0')::integer;
  IF v_rev <> p_base_revision THEN
    RAISE EXCEPTION 'Configuration conflict: expected revision %, current is %.', p_base_revision, v_rev;
  END IF;
  IF v_row ? 'draft' = false THEN
    RAISE EXCEPTION 'No draft configuration to publish for area %.', p_area;
  END IF;

  -- Phase 23: the promoted draft must still satisfy the area allowlists and
  -- (branding) reference this tenant's own public media at publish time.
  IF p_area = 'branding' THEN
    PERFORM politicore.cc_validate_branding(v_row -> 'draft');
    PERFORM politicore.cc_assert_brandable_media(v_row -> 'draft', v_tenant);
  ELSIF p_area = 'seo' THEN
    PERFORM politicore.cc_validate_seo(v_row -> 'draft');
  END IF;

  v_prev := v_row -> 'published';

  v_hist := COALESCE(v_row -> 'history', '[]'::jsonb) || jsonb_build_array(
              jsonb_build_object('revision', v_rev, 'published', v_prev,
                                 'published_at', v_row -> 'published_at'));
  IF jsonb_array_length(v_hist) > 10 THEN
    v_hist := (SELECT jsonb_agg(e ORDER BY ord DESC)
                 FROM (SELECT e, ord FROM jsonb_array_elements(v_hist)
                         WITH ORDINALITY AS t(e, ord) LIMIT 10) s);
  END IF;

  v_new := jsonb_build_object('revision', v_rev + 1,
                              'draft', v_row -> 'draft',
                              'published', v_row -> 'draft',
                              'published_at', to_jsonb(now()),
                              'published_by', to_jsonb(auth.uid()),
                              'history', v_hist);

  IF p_area = 'branding' THEN
    UPDATE politicore.public_site_settings SET branding = v_new, updated_at = now()
     WHERE tenant_id = v_tenant AND COALESCE(branding ->> 'revision', '0')::integer = p_base_revision;
  ELSIF p_area = 'navigation' THEN
    UPDATE politicore.public_site_settings SET navigation = v_new, updated_at = now()
     WHERE tenant_id = v_tenant AND COALESCE(navigation ->> 'revision', '0')::integer = p_base_revision;
  ELSIF p_area = 'footer' THEN
    UPDATE politicore.public_site_settings SET footer = v_new, updated_at = now()
     WHERE tenant_id = v_tenant AND COALESCE(footer ->> 'revision', '0')::integer = p_base_revision;
  ELSIF p_area = 'homepage' THEN
    UPDATE politicore.public_site_settings SET homepage = v_new, updated_at = now()
     WHERE tenant_id = v_tenant AND COALESCE(homepage ->> 'revision', '0')::integer = p_base_revision;
  ELSIF p_area = 'contact' THEN
    UPDATE politicore.public_site_settings SET contact = v_new, updated_at = now()
     WHERE tenant_id = v_tenant AND COALESCE(contact ->> 'revision', '0')::integer = p_base_revision;
  ELSIF p_area = 'social_links' THEN
    UPDATE politicore.public_site_settings SET social_links = v_new, updated_at = now()
     WHERE tenant_id = v_tenant AND COALESCE(social_links ->> 'revision', '0')::integer = p_base_revision;
  ELSIF p_area = 'seo' THEN
    UPDATE politicore.public_site_settings SET seo = v_new, updated_at = now()
     WHERE tenant_id = v_tenant AND COALESCE(seo ->> 'revision', '0')::integer = p_base_revision;
  END IF;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'Configuration conflict: area % was modified concurrently.', p_area;
  END IF;

  INSERT INTO politicore.system_audits
    (tenant_id, actor_id, action, affected_resource, resource_id, old_value, new_value)
  VALUES
    (v_tenant, auth.uid(),
     'site_config:' || p_area || ':published',
     'public_site_settings', v_tenant::text,
     jsonb_build_object('revision', v_rev),
     jsonb_build_object('revision', v_rev + 1, 'area', p_area));

  RETURN QUERY SELECT v_rev + 1, now();
END;
$$;

-- ───────────────────────────────────────────────────────────────────────────
-- D. PUBLIC CHROME — one published-only projection for public rendering.
--    Resolved by the established slug seam. Drafts, history and audit keys
--    never leave the server; a tenant with NO configuration receives empty
--    objects (fallback defaults are applied client-side, gate §15).
-- ───────────────────────────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION politicore.get_public_site_chrome(p_tenant_slug text)
RETURNS jsonb
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = politicore, public, pg_temp
AS $$
DECLARE
  v_tenant uuid;
  -- Scalar-subquery forms: a bare SELECT … INTO that matches zero rows
  -- leaves its target NULL (the Phase 22 finding), so the COALESCE never
  -- runs. These forms always yield one row with '{}' for unconfigured
  -- tenants (gate §15 fallback safety).
  v_brand  jsonb := COALESCE((SELECT s.branding -> 'published'
                                FROM politicore.public_site_settings s
                               WHERE s.tenant_id = (SELECT id FROM politicore.tenants
                                                     WHERE slug = p_tenant_slug)),
                             '{}'::jsonb);
  v_seo    jsonb := COALESCE((SELECT s.seo -> 'published'
                                FROM politicore.public_site_settings s
                               WHERE s.tenant_id = (SELECT id FROM politicore.tenants
                                                     WHERE slug = p_tenant_slug)),
                             '{}'::jsonb);
BEGIN
  SELECT id INTO v_tenant FROM politicore.tenants WHERE slug = p_tenant_slug;
  IF v_tenant IS NULL THEN
    RETURN jsonb_build_object('branding', '{}'::jsonb, 'seo', '{}'::jsonb);
  END IF;

  RETURN jsonb_build_object('branding', v_brand, 'seo', v_seo);
END;
$$;

-- ───────────────────────────────────────────────────────────────────────────
-- Brand-asset render authority: resolves a PUBLIC media asset of the tenant
-- identified by the public-site slug (the /api/media/[assetId] render route).
-- Returns only the fields the Media Service needs to resolve the provider
-- URL; cross-tenant or non-public references return no row (404 upstream).
CREATE OR REPLACE FUNCTION public.get_public_brand_asset(
  p_tenant_slug text,
  p_asset_id    uuid
)
RETURNS TABLE (
  id           uuid,
  tenant_id    uuid,
  provider     text,
  bucket       text,
  object_key   text,
  visibility   text,
  content_type text,
  purpose      text
)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = politicore, public, pg_temp
AS $$
  SELECT a.id, a.tenant_id, a.provider, a.bucket, a.object_key,
         a.visibility, a.content_type, a.purpose
    FROM politicore.media_assets a
    JOIN politicore.tenants t ON t.id = a.tenant_id
   WHERE t.slug = p_tenant_slug
     AND a.id = p_asset_id
     AND a.visibility = 'public';
$$;

-- E. ADMIN PREVIEW — the tenant-admin's own DRAFT state for preview UI.
--    is_tenant_admin() is re-gated inside the definer; anon and plain
--    members hold nothing (gate §12 preview authority).
-- ───────────────────────────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION politicore.get_site_config_preview(p_area text)
RETURNS jsonb
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = politicore, auth, pg_temp
AS $$
DECLARE
  v_tenant uuid := politicore.current_tenant_id();
  v_row    jsonb;
BEGIN
  IF v_tenant IS NULL THEN
    RAISE EXCEPTION 'Tenant context could not be resolved for the current session.';
  END IF;
  IF NOT politicore.is_tenant_admin() THEN
    RAISE EXCEPTION 'Tenant administration authority is required for configuration preview.';
  END IF;
  IF NOT politicore.cc_is_site_config_area(p_area) THEN
    RAISE EXCEPTION 'Unknown configuration area %.', p_area;
  END IF;

  IF p_area = 'branding' THEN
    SELECT branding INTO v_row FROM politicore.public_site_settings WHERE tenant_id = v_tenant;
  ELSIF p_area = 'seo' THEN
    SELECT seo INTO v_row FROM politicore.public_site_settings WHERE tenant_id = v_tenant;
  ELSE
    RAISE EXCEPTION 'Preview is not exposed for area %.', p_area;
  END IF;

  IF v_row IS NULL THEN
    RETURN '{}'::jsonb;
  END IF;
  RETURN COALESCE(v_row -> 'draft', v_row -> 'published', '{}'::jsonb);
END;
$$;

-- ───────────────────────────────────────────────────────────────────────────
-- WRAPPERS (0007/0056/0060 convention) + narrowed EXECUTE grants
-- ───────────────────────────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION public.get_public_site_chrome(p_tenant_slug text)
RETURNS jsonb LANGUAGE sql STABLE SECURITY INVOKER
SET search_path = politicore, public, pg_temp
AS $$ SELECT politicore.get_public_site_chrome($1); $$;

CREATE OR REPLACE FUNCTION public.get_site_config_preview(p_area text)
RETURNS jsonb LANGUAGE sql STABLE SECURITY INVOKER
SET search_path = politicore, public, pg_temp
AS $$ SELECT politicore.get_site_config_preview($1); $$;

GRANT EXECUTE ON FUNCTION public.get_public_site_chrome(text) TO anon, authenticated;
GRANT EXECUTE ON FUNCTION public.get_public_brand_asset(text, uuid) TO anon, authenticated;
GRANT EXECUTE ON FUNCTION public.get_site_config_preview(text)  TO authenticated;

REVOKE ALL ON FUNCTION public.get_site_config_preview(text) FROM anon, PUBLIC;
