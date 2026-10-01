-- ============================================================================
-- 0062 — HOMEPAGE BUILDER (Phase 24)
-- ============================================================================
-- Control Center — configuration-driven homepage composition.
--
-- Architecture: docs/Control-Center-Architecture-Gate.md (§7 Homepage
-- Builder boundary) and the Phase 22/23 configuration foundation. ZERO new
-- tables — the existing politicore.public_site_settings.homepage jsonb
-- area remains the sole substrate. The application owns the section
-- REGISTRY (typed code); the database stores declarative section
-- instances only and validates them against the same allowlist discipline
-- as Phase 23:
--
--   A. HOMEPAGE VALIDATOR   cc_validate_homepage — composition allowlist:
--                           ordered sections[] with stable ids, known
--                           section types, validated per-type configs,
--                           media + link walkers, module-enum service
--                           dependencies, unique stable ids, bounded
--                           section count.
--   B. ROLLBACK RPC         rollback_site_config(area, revision) —
--                           promotes a HISTORY entry through the normal
--                           validated draft path (no destructive history
--                           mutation; bounded 10-entry archive kept).
--   C. PREVIEW EXTENSION    get_site_config_preview accepts 'homepage'
--                           (Phase 23 gated it to branding/seo).
--   D. PUBLIC WRAPPER       public.get_published_homepage(slug) —
--                           published-only composition for the section
--                           engine.
-- ============================================================================

-- ───────────────────────────────────────────────────────────────────────────
-- A. HOMEPAGE VALIDATOR — the composition contract (§5, §7, §8, §10).
--    Section types are the REGISTRY allowlist (checked in SQL against a
--    fixed set mirroring src/lib/homepage/registry.ts); per-type configs
--    are validated here for persistence safety (unknown keys/values can
--    never enter storage), while richer per-field rules also live in the
--    TypeScript registry (fail-safe skipping for stored outliving types).
-- ───────────────────────────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION politicore.cc_validate_homepage(p_sections jsonb)
RETURNS jsonb
LANGUAGE plpgsql
STABLE
SET search_path = politicore, pg_temp
AS $$
DECLARE
  v_sec      jsonb;
  v_count    integer := 0;
  v_key      text;
  v_cfg      jsonb;
  v_ids      text[];
  v_orders   integer[];
  v_sid      text;
  v_allowed  text[] := ARRAY[
    -- Content-backed
    'news','events','biography','manifesto','gallery',
    'governance_projects','governance_commitments','governance_updates',
    'public_accountability','public_participation','election_countdown',
    'contact_cta',
    -- Presentation / marketing
    'hero','rich_text','image_text','feature_cards','statistics',
    'cta','quote','video','link_cards','divider'
  ];
  v_cfg_keys text[];
  v_k        text;
BEGIN
  IF p_sections IS NULL THEN
    RETURN '[]'::jsonb;
  END IF;
  IF jsonb_typeof(p_sections) <> 'array' THEN
    RAISE EXCEPTION 'Homepage composition must be a JSON array of sections.';
  END IF;
  IF jsonb_array_length(p_sections) > 30 THEN
    RAISE EXCEPTION 'Homepage composition exceeds the 30-section maximum.';
  END IF;

  FOR v_sec IN SELECT * FROM jsonb_array_elements(p_sections) LOOP
    v_count := v_count + 1;
    IF jsonb_typeof(v_sec) <> 'object' THEN
      RAISE EXCEPTION 'Homepage section % must be an object.', v_count;
    END IF;

    -- ── Allowed instance keys (declarative only — no executable fields).
    FOR v_key IN SELECT jsonb_object_keys(v_sec) LOOP
      IF v_key NOT IN ('stable_id','section_type','display_order','enabled',
                       'config','service_dependency','presentation') THEN
        RAISE EXCEPTION 'Unknown homepage section field "%".', v_key;
      END IF;
    END LOOP;

    -- stable_id: required, bounded, unique.
    IF NOT v_sec ? 'stable_id'
       OR jsonb_typeof(v_sec->'stable_id') <> 'string'
       OR length(v_sec->>'stable_id') NOT BETWEEN 1 AND 64
       OR (v_sec->>'stable_id') !~ '^[a-zA-Z0-9_-]+$' THEN
      RAISE EXCEPTION
        'Homepage section % requires a stable_id of 1..64 url-safe characters.', v_count;
    END IF;
    v_sid := v_sec->>'stable_id';
    IF v_sid = ANY(v_ids) THEN
      RAISE EXCEPTION 'Duplicate homepage section stable_id "%".', v_sid;
    END IF;
    v_ids := v_ids || v_sid;

    -- section_type: registry allowlist.
    IF NOT v_sec ? 'section_type'
       OR NOT ((v_sec->>'section_type') = ANY (v_allowed)) THEN
      RAISE EXCEPTION 'Unknown homepage section type "%".', v_sec->>'section_type';
    END IF;

    -- display_order: required integer (explicit ordering, §10); must be
    -- unique within the composition (no duplicated ordering positions).
    IF NOT v_sec ? 'display_order'
       OR jsonb_typeof(v_sec->'display_order') <> 'number'
       OR (v_sec->>'display_order')::numeric <> floor((v_sec->>'display_order')::numeric) THEN
      RAISE EXCEPTION 'Homepage section "%" requires an integer display_order.', v_sid;
    END IF;
    IF ((v_sec->>'display_order')::integer) = ANY (v_orders) THEN
      RAISE EXCEPTION 'Duplicate homepage section display_order "%".', v_sec->>'display_order';
    END IF;
    v_orders := v_orders || ((v_sec->>'display_order')::integer);

    -- enabled: required boolean.
    IF NOT v_sec ? 'enabled'
       OR jsonb_typeof(v_sec->'enabled') <> 'boolean' THEN
      RAISE EXCEPTION 'Homepage section "%" requires an enabled boolean.', v_sid;
    END IF;

    -- service_dependency: null or an EXISTING module_code_enum value (§12 —
    -- never a fifth module). Validated against the live enum.
    IF v_sec ? 'service_dependency'
       AND NOT (v_sec->'service_dependency') IS NULL THEN
      -- pg_enum rows are unique per type; resolve the type schema-qualified
      -- via regtype INPUT cast. (A pg_namespace join must go through pg_type
      -- — joining n.oid = e.enumtypid is a category error that rejects every
      -- valid dependency.)
      IF jsonb_typeof(v_sec->'service_dependency') <> 'string'
         OR NOT EXISTS (SELECT 1 FROM pg_enum e
                         WHERE e.enumtypid = 'politicore.module_code_enum'::regtype
                           AND e.enumlabel = v_sec->>'service_dependency') THEN
        RAISE EXCEPTION
          'Homepage section "%" has an unsupported service_dependency "%".', v_sid, v_sec->>'service_dependency';
      END IF;
    END IF;

    -- presentation: optional bounded declarative object (§17).
    IF v_sec ? 'presentation' AND NOT (v_sec->'presentation') IS NULL THEN
      IF jsonb_typeof(v_sec->'presentation') <> 'object' THEN
        RAISE EXCEPTION 'Homepage section "%" presentation must be an object.', v_sid;
      END IF;
      FOR v_k IN SELECT jsonb_object_keys(v_sec->'presentation') LOOP
        IF v_k NOT IN ('background_variant','padding','width','align') THEN
          RAISE EXCEPTION 'Unknown homepage presentation option "%" on section "%".', v_k, v_sid;
        END IF;
      END LOOP;
    END IF;

    -- config: per-type allowlists (persistence-safety net; the TypeScript
    -- registry holds the full typed schemas and defaults).
    IF NOT v_sec ? 'config' OR jsonb_typeof(v_sec->'config') <> 'object' THEN
      RAISE EXCEPTION 'Homepage section "%" requires a config object.', v_sid;
    END IF;
    v_cfg := v_sec->'config';
    CASE v_sec->>'section_type'
      WHEN 'hero' THEN
        v_cfg_keys := ARRAY['eyebrow','title','description','primary_cta','secondary_cta','background_variant','alignment'];
      WHEN 'rich_text' THEN
        v_cfg_keys := ARRAY['heading','body','alignment'];
      WHEN 'image_text' THEN
        v_cfg_keys := ARRAY['heading','body','image','image_side','cta'];
      WHEN 'feature_cards' THEN
        v_cfg_keys := ARRAY['heading','cards'];
      WHEN 'statistics' THEN
        v_cfg_keys := ARRAY['heading','items'];
      WHEN 'cta' THEN
        v_cfg_keys := ARRAY['heading','description','primary_cta','secondary_cta','background_variant'];
      WHEN 'quote' THEN
        v_cfg_keys := ARRAY['quote','attribution','alignment'];
      WHEN 'video' THEN
        v_cfg_keys := ARRAY['heading','video_url','poster'];
      WHEN 'link_cards' THEN
        v_cfg_keys := ARRAY['heading','cards'];
      WHEN 'divider' THEN
        v_cfg_keys := ARRAY['style'];
      WHEN 'news' THEN
        v_cfg_keys := ARRAY['heading','item_count','layout','show_excerpt','cta'];
      WHEN 'events' THEN
        v_cfg_keys := ARRAY['heading','item_count','layout','cta'];
      WHEN 'biography' THEN
        v_cfg_keys := ARRAY['heading','body','image','cta'];
      WHEN 'manifesto' THEN
        v_cfg_keys := ARRAY['heading','body','cta'];
      WHEN 'gallery' THEN
        v_cfg_keys := ARRAY['heading','item_count','layout','cta'];
      WHEN 'governance_projects' THEN
        v_cfg_keys := ARRAY['item_count','heading','cta'];
      WHEN 'governance_commitments' THEN
        v_cfg_keys := ARRAY['item_count','heading','cta'];
      WHEN 'governance_updates' THEN
        v_cfg_keys := ARRAY['item_count','heading','cta'];
      WHEN 'public_accountability' THEN
        v_cfg_keys := ARRAY['heading','cta'];
      WHEN 'public_participation' THEN
        v_cfg_keys := ARRAY['heading','cta'];
      WHEN 'election_countdown' THEN
        v_cfg_keys := ARRAY['label'];
      WHEN 'contact_cta' THEN
        v_cfg_keys := ARRAY['heading','description','cta'];
      ELSE
        RAISE EXCEPTION 'Unknown homepage section type "%".', v_sec->>'section_type';
    END CASE;

    FOR v_k IN SELECT jsonb_object_keys(v_cfg) LOOP
      IF NOT (v_k = ANY (v_cfg_keys)) THEN
        RAISE EXCEPTION 'Unknown config key "%" on homepage section "%" (type %).', v_k, v_sid, v_sec->>'section_type';
      END IF;
    END LOOP;

    -- Typed config field checks shared across section types.
    IF v_cfg ? 'item_count'
       AND (jsonb_typeof(v_cfg->'item_count') <> 'number'
            OR (v_cfg->>'item_count')::numeric <> floor((v_cfg->>'item_count')::numeric)
            OR (v_cfg->>'item_count')::numeric NOT BETWEEN 1 AND 12) THEN
      RAISE EXCEPTION 'Homepage section "%" item_count must be an integer 1..12.', v_sid;
    END IF;
    IF v_cfg ? 'layout'
       AND (v_cfg->>'layout') NOT IN ('grid','list','carousel','featured') THEN
      RAISE EXCEPTION 'Homepage section "%" layout must be grid, list, carousel or featured.', v_sid;
    END IF;
    IF v_cfg ? 'alignment'
       AND (v_cfg->>'alignment') NOT IN ('left','center','right') THEN
      RAISE EXCEPTION 'Homepage section "%" alignment must be left, center or right.', v_sid;
    END IF;
    IF v_cfg ? 'image_side'
       AND (v_cfg->>'image_side') NOT IN ('left','right') THEN
      RAISE EXCEPTION 'Homepage section "%" image_side must be left or right.', v_sid;
    END IF;
    IF v_cfg ? 'background_variant'
       AND (v_cfg->>'background_variant') NOT IN ('brand','dark','light','gradient','surface') THEN
      RAISE EXCEPTION 'Homepage section "%" background_variant must be brand, dark, light, gradient or surface.', v_sid;
    END IF;
    IF v_cfg ? 'style' AND (v_cfg->>'style') NOT IN ('space','line','dots') THEN
      RAISE EXCEPTION 'Homepage section "%" style must be space, line or dots.', v_sid;
    END IF;
    IF v_cfg ? 'heading'
       AND (jsonb_typeof(v_cfg->'heading') <> 'string'
            OR length(v_cfg->>'heading') > 160) THEN
      RAISE EXCEPTION 'Homepage section "%" heading must be at most 160 characters.', v_sid;
    END IF;
    IF v_cfg ? 'label'
       AND (jsonb_typeof(v_cfg->'label') <> 'string'
            OR length(v_cfg->>'label') > 160) THEN
      RAISE EXCEPTION 'Homepage section "%" label must be at most 160 characters.', v_sid;
    END IF;
    IF v_cfg ? 'description' OR v_cfg ? 'body'
       OR v_cfg ? 'quote' OR v_cfg ? 'attribution' OR v_cfg ? 'eyebrow' THEN
      FOR v_k IN SELECT unnest(ARRAY['description','body','quote','attribution','eyebrow']) LOOP
        IF v_cfg ? v_k AND (jsonb_typeof(v_cfg->v_k) <> 'string'
                            OR length(v_cfg->>v_k) > 2000) THEN
          RAISE EXCEPTION 'Homepage section "%" text field "%" must be at most 2000 characters.', v_sid, v_k;
        END IF;
      END LOOP;
    END IF;
    IF v_cfg ? 'show_excerpt'
       AND jsonb_typeof(v_cfg->'show_excerpt') <> 'boolean' THEN
      RAISE EXCEPTION 'Homepage section "%" show_excerpt must be a boolean.', v_sid;
    END IF;
    IF v_cfg ? 'cta'
       AND (jsonb_typeof(v_cfg->'cta') <> 'object'
            OR (v_cfg->'cta') ? 'label' = false
            OR (v_cfg->'cta') ? 'href' = false
            OR jsonb_typeof(v_cfg->'cta'->'label') <> 'string'
            OR length(v_cfg->'cta'->>'label') > 80) THEN
      RAISE EXCEPTION 'Homepage section "%" cta must be an object with label and href.', v_sid;
    END IF;

    -- cta/link hrefs: safe internal paths or absolute http(s) (§19).
    IF v_cfg ? 'cta' THEN
      PERFORM politicore.cc_assert_safe_href(v_cfg->'cta'->>'href', v_sid);
    END IF;
    IF v_cfg ? 'primary_cta' THEN
      IF jsonb_typeof(v_cfg->'primary_cta') <> 'object'
         OR length(COALESCE(v_cfg->'primary_cta'->>'label','')) > 80 THEN
        RAISE EXCEPTION 'Homepage section "%" primary_cta must be an object with a short label.', v_sid;
      END IF;
      PERFORM politicore.cc_assert_safe_href(v_cfg->'primary_cta'->>'href', v_sid);
    END IF;
    IF v_cfg ? 'secondary_cta' AND NOT (v_cfg->'secondary_cta') IS NULL THEN
      IF jsonb_typeof(v_cfg->'secondary_cta') <> 'object'
         OR length(COALESCE(v_cfg->'secondary_cta'->>'label','')) > 80 THEN
        RAISE EXCEPTION 'Homepage section "%" secondary_cta must be an object with a short label.', v_sid;
      END IF;
      PERFORM politicore.cc_assert_safe_href(v_cfg->'secondary_cta'->>'href', v_sid);
    END IF;

    -- media: singletons + arrays all flow through the tenancy walker (§18).
    IF v_cfg ? 'image' THEN
      PERFORM politicore.cc_assert_section_media(v_cfg->'image', v_sid, v_count);
    END IF;
    IF v_cfg ? 'poster' THEN
      PERFORM politicore.cc_assert_section_media(v_cfg->'poster', v_sid, v_count);
    END IF;
    IF v_cfg ? 'cards' THEN
      IF jsonb_typeof(v_cfg->'cards') <> 'array'
         OR jsonb_array_length(v_cfg->'cards') > 12 THEN
        RAISE EXCEPTION 'Homepage section "%" cards must be an array of at most 12.', v_sid;
      END IF;
      FOR v_sec IN SELECT * FROM jsonb_array_elements(v_cfg->'cards') LOOP
        FOR v_k IN SELECT jsonb_object_keys(v_sec) LOOP
          IF v_k NOT IN ('title','description','icon','image','href','value','label') THEN
            RAISE EXCEPTION 'Unknown card field "%" in homepage section "%".', v_k, v_sid;
          END IF;
        END LOOP;
        IF v_sec ? 'title' AND (jsonb_typeof(v_sec->'title') <> 'string'
                                OR length(v_sec->>'title') > 160) THEN
          RAISE EXCEPTION 'Card title in homepage section "%" must be at most 160 characters.', v_sid;
        END IF;
        IF v_sec ? 'description' AND (jsonb_typeof(v_sec->'description') <> 'string'
                                      OR length(v_sec->>'description') > 600) THEN
          RAISE EXCEPTION 'Card description in homepage section "%" must be at most 600 characters.', v_sid;
        END IF;
        IF v_sec ? 'image' THEN
          PERFORM politicore.cc_assert_section_media(v_sec->'image', v_sid, v_count);
        END IF;
        IF v_sec ? 'href' THEN
          PERFORM politicore.cc_assert_safe_href(v_sec->>'href', v_sid);
        END IF;
      END LOOP;
      -- Re-arm the outer loop variable (FOR … IN SELECT reuses it).
      v_sec := NULL;
    END IF;
    -- NOTE: the cards sub-loop intentionally reuses v_sec; after the CASE
    -- block finishes the outer FOR continues with the next element, so no
    -- state leaks between iterations.
  END LOOP;

  RETURN p_sections;
END;
$$;

-- Safe href: relative internal paths or absolute http(s) URLs only (§19).
CREATE OR REPLACE FUNCTION politicore.cc_assert_safe_href(
  p_href text,
  p_sid  text
)
RETURNS void
LANGUAGE plpgsql
STABLE
SET search_path = politicore, pg_temp
AS $$
BEGIN
  IF p_href IS NULL OR length(p_href) = 0 THEN
    RETURN; -- empty href = no link (allowed)
  END IF;
  IF length(p_href) > 2000 THEN
    RAISE EXCEPTION 'Homepage section "%" href exceeds 2000 characters.', p_sid;
  END IF;
  IF p_href ~* '^\s*(javascript|data|vbscript|file|about):' THEN
    RAISE EXCEPTION 'Homepage section "%" href uses a forbidden scheme.', p_sid;
  END IF;
  IF LEFT(p_href, 1) IN ('/', '#')
     OR p_href ~* '^https?://[^\s]+$' THEN
    RETURN;
  END IF;
  RAISE EXCEPTION
    'Homepage section "%" href must be an internal path or an http(s) URL.', p_sid;
END;
$$;

-- Media walker: a single {asset_id} object or an array of them; each must
-- reference an EXISTING PUBLIC media_assets row of the caller's tenant (§18).
CREATE OR REPLACE FUNCTION politicore.cc_assert_section_media(
  p_media jsonb,
  p_sid   text,
  p_idx   integer
)
RETURNS void
LANGUAGE plpgsql
STABLE
SET search_path = politicore, pg_temp
AS $$
DECLARE
  v_el    jsonb;
  v_asset uuid;
  v_tenant uuid := politicore.current_tenant_id();
BEGIN
  IF p_media IS NULL THEN
    RETURN;
  END IF;
  IF jsonb_typeof(p_media) = 'object' THEN
    v_el := jsonb_build_array(p_media);
  ELSIF jsonb_typeof(p_media) = 'array' THEN
    IF jsonb_array_length(p_media) > 12 THEN
      RAISE EXCEPTION 'Homepage section "%" media array exceeds 12 items.', p_sid;
    END IF;
    v_el := p_media;
  ELSE
    RAISE EXCEPTION 'Homepage section "%" media must be an object or array.', p_sid;
  END IF;

  FOR v_el IN SELECT * FROM jsonb_array_elements(v_el) LOOP
    IF jsonb_typeof(v_el) <> 'object'
       OR v_el ? 'asset_id' = false
       OR (v_el->>'asset_id') !~ '^[0-9a-fA-F-]{36}$' THEN
      RAISE EXCEPTION
        'Homepage section "%" media must reference a media asset id ({"asset_id": ...}).', p_sid;
    END IF;
    v_asset := (v_el->>'asset_id')::uuid;
    IF NOT EXISTS (SELECT 1 FROM politicore.media_assets
                    WHERE id = v_asset
                      AND tenant_id = COALESCE(v_tenant, '00000000-0000-0000-0000-000000000000'::uuid)
                      AND visibility = 'public') THEN
      RAISE EXCEPTION
        'Homepage section "%" media does not reference a public media asset of this tenant.', p_sid;
    END IF;
  END LOOP;
END;
$$;

-- ───────────────────────────────────────────────────────────────────────────
-- C. PREVIEW EXTENSION — homepage joins branding/seo in the admin preview
--    RPC (is_tenant_admin re-gated inside the definer).
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
  ELSIF p_area = 'homepage' THEN
    SELECT homepage INTO v_row FROM politicore.public_site_settings WHERE tenant_id = v_tenant;
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
-- B/C2. RESTATED SAVE + PUBLISH — identical Phase 23 bodies + homepage
--       validation (the promoted composition must satisfy the validator at
--       publish time too). Static per-area branches preserved.
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

  IF p_area = 'branding' THEN
    p_draft := politicore.cc_validate_branding(p_draft);
    PERFORM politicore.cc_assert_brandable_media(p_draft, v_tenant);
  ELSIF p_area = 'seo' THEN
    p_draft := politicore.cc_validate_seo(p_draft);
  ELSIF p_area = 'homepage' THEN
    PERFORM politicore.cc_validate_homepage(COALESCE(p_draft->'sections', '[]'::jsonb));
  END IF;

  EXECUTE format(
    'SELECT COALESCE((SELECT (%I ->> %L)::integer
                       FROM politicore.public_site_settings WHERE tenant_id = $1), 0)',
    p_area, 'revision') INTO v_current USING v_tenant;

  IF v_current <> p_base_revision THEN
    RAISE EXCEPTION 'Configuration conflict: expected revision %, current is %.', p_base_revision, v_current;
  END IF;

  -- Atomic upsert. MERGE, not replace: the payload only carries revision/
  -- draft/provenance so a post-publish draft save PRESERVES 'published' and
  -- 'history' (the public wrapper filters on ? 'published' — replace
  -- semantics would blank the live homepage between publish cycles and
  -- destroy bounded history, violating §21/§26). The conditional DO UPDATE
  -- still matches zero rows when a concurrent writer advanced the revision.
  -- (Handles the not-yet-provisioned settings row as revision 0.)
  EXECUTE format(
    'INSERT INTO politicore.public_site_settings (tenant_id, %I)
     VALUES ($1, $2)
     ON CONFLICT (tenant_id) DO UPDATE
       SET %I = COALESCE(politicore.public_site_settings.%I, ''{}''::jsonb) || $2,
           updated_at = now()
       WHERE COALESCE((politicore.public_site_settings.%I ->> ''revision'')::integer, 0) = $3
     RETURNING 1',
    p_area, p_area, p_area, p_area)
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

  -- Validated areas: the promoted payload must still satisfy the allowlists
  -- at publish time (a config can be invalid if rules tightened since draft).
  IF p_area = 'branding' THEN
    PERFORM politicore.cc_validate_branding(v_row -> 'draft');
    PERFORM politicore.cc_assert_brandable_media(v_row -> 'draft', v_tenant);
  ELSIF p_area = 'seo' THEN
    PERFORM politicore.cc_validate_seo(v_row -> 'draft');
  ELSIF p_area = 'homepage' THEN
    PERFORM politicore.cc_validate_homepage(COALESCE(v_row->'draft'->'sections', '[]'::jsonb));
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
-- B. ROLLBACK — promotes a HISTORY entry to DRAFT through the normal
--    validated save path, then the admin publishes it via publish_site_config.
--    History is never destructively mutated; the rollback itself is audited.
-- ───────────────────────────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION politicore.rollback_site_config(
  p_area           text,
  p_history_revision integer
) RETURNS integer
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = politicore, auth, pg_temp
AS $$
DECLARE
  v_tenant uuid := politicore.current_tenant_id();
  v_row    jsonb;
  v_entry  jsonb;
  v_target jsonb;
  v_current integer;
  v_newrev  integer;
BEGIN
  IF v_tenant IS NULL THEN
    RAISE EXCEPTION 'Tenant context could not be resolved for the current session.';
  END IF;
  IF NOT politicore.is_tenant_admin() THEN
    RAISE EXCEPTION 'Tenant administration authority is required for configuration rollback.';
  END IF;
  IF NOT politicore.cc_is_site_config_area(p_area) THEN
    RAISE EXCEPTION 'Unknown configuration area %.', p_area;
  END IF;

  IF p_area = 'homepage' THEN
    SELECT homepage INTO v_row FROM politicore.public_site_settings WHERE tenant_id = v_tenant;
  ELSIF p_area = 'branding' THEN
    SELECT branding INTO v_row FROM politicore.public_site_settings WHERE tenant_id = v_tenant;
  ELSIF p_area = 'seo' THEN
    SELECT seo INTO v_row FROM politicore.public_site_settings WHERE tenant_id = v_tenant;
  END IF;

  IF v_row IS NULL THEN
    RAISE EXCEPTION 'No configuration to roll back for area %.', p_area;
  END IF;

  v_entry := (SELECT e FROM jsonb_array_elements(COALESCE(v_row->'history','[]'::jsonb)) e
               WHERE (e->>'revision')::integer = p_history_revision
               ORDER BY 1 DESC LIMIT 1);
  IF v_entry IS NULL THEN
    RAISE EXCEPTION 'History revision % not found for area %.', p_history_revision, p_area;
  END IF;
  v_target := v_entry -> 'published';

  -- Promote the historical payload to DRAFT through the normal validated
  -- path (current revision; conflict-checked atomically inside save).
  v_current := COALESCE((v_row->>'revision')::integer, 0);
  v_newrev := politicore.save_site_config_draft(p_area, v_target, v_current);

  INSERT INTO politicore.system_audits
    (tenant_id, actor_id, action, affected_resource, resource_id, new_value)
  VALUES
    (v_tenant, auth.uid(),
     'site_config:' || p_area || ':rollback',
     'public_site_settings', v_tenant::text,
     jsonb_build_object('area', p_area, 'from_revision', p_history_revision,
                        'draft_revision', v_newrev));

  RETURN v_newrev;
END;
$$;

-- ───────────────────────────────────────────────────────────────────────────
-- C2. HISTORY READ — bounded published-revision list for the Builder's
--     rollback UI (titles/labels only; payloads stay inside the row).
-- ───────────────────────────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION politicore.get_site_config_history(p_area text)
RETURNS TABLE (revision integer, published_at timestamptz)
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
    RAISE EXCEPTION 'Tenant administration authority is required for configuration history.';
  END IF;
  IF NOT politicore.cc_is_site_config_area(p_area) THEN
    RAISE EXCEPTION 'Unknown configuration area %.', p_area;
  END IF;

  IF p_area = 'branding' THEN
    SELECT branding INTO v_row FROM politicore.public_site_settings WHERE tenant_id = v_tenant;
  ELSIF p_area = 'homepage' THEN
    SELECT homepage INTO v_row FROM politicore.public_site_settings WHERE tenant_id = v_tenant;
  ELSIF p_area = 'seo' THEN
    SELECT seo INTO v_row FROM politicore.public_site_settings WHERE tenant_id = v_tenant;
  ELSE
    RAISE EXCEPTION 'History is not exposed for area %.', p_area;
  END IF;
  IF v_row IS NULL THEN
    RETURN;
  END IF;

  RETURN QUERY
  SELECT (e ->> 'revision')::integer, (e ->> 'published_at')::timestamptz
    FROM jsonb_array_elements(COALESCE(v_row -> 'history', '[]'::jsonb)) e;
END;
$$;

-- ───────────────────────────────────────────────────────────────────────────
-- D. PUBLIC WRAPPERS + grants
-- ───────────────────────────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION public.get_published_homepage(p_tenant_slug text)
RETURNS TABLE (revision integer, sections jsonb, published_at timestamptz)
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = politicore, public, pg_temp
AS $$
DECLARE
  v_row      jsonb;
  v_sections jsonb;
  v_mods     jsonb;
  v_out      jsonb;
  v_sec      jsonb;
  v_dep      text;
BEGIN
  -- §12/§26: the public projection evaluates ELIGIBILITY server-side —
  -- disabled sections, and enabled sections whose service_dependency's
  -- module is not activated, are suppressed from the PUBLIC composition.
  -- The stored configuration is never mutated (§11/§35: re-enabling the
  -- service makes the section eligible again with no config change).
  SELECT p.homepage INTO v_row
    FROM politicore.public_site_settings p
    JOIN politicore.tenants t ON t.id = p.tenant_id
   WHERE t.slug = p_tenant_slug
     AND p.homepage ? 'published';
  IF v_row IS NULL THEN
    RETURN;
  END IF;

  v_sections := COALESCE(v_row #> '{published,sections}', '[]'::jsonb);
  IF jsonb_typeof(v_sections) <> 'array' THEN
    v_sections := '[]'::jsonb; -- §20: malformed legacy payload fails safe, never 500
  END IF;
  SELECT jsonb_object_agg(module, enabled) INTO v_mods
    FROM politicore.tenant_modules
   WHERE tenant_id = (SELECT t.id FROM politicore.tenants t WHERE t.slug = p_tenant_slug);

  v_out := '[]'::jsonb;
  FOR v_sec IN SELECT * FROM jsonb_array_elements(v_sections) LOOP
    v_dep := NULLIF(v_sec->>'service_dependency', '');
    -- String compare (no boolean cast) so a malformed enabled value is
    -- simply not eligible rather than an exception.
    IF COALESCE(v_sec->>'enabled', 'true') = 'true'
       AND (v_dep IS NULL OR COALESCE((v_mods ->> v_dep)::boolean, false)) THEN
      v_out := v_out || v_sec;
    END IF;
  END LOOP;

  RETURN QUERY
  SELECT COALESCE((v_row ->> 'revision')::integer, 0), v_out,
         (v_row ->> 'published_at')::timestamptz;
END;
$$;

CREATE OR REPLACE FUNCTION public.rollback_site_config(
  p_area text, p_history_revision integer)
RETURNS integer LANGUAGE sql VOLATILE SECURITY INVOKER
SET search_path = politicore, public, pg_temp
AS $$ SELECT politicore.rollback_site_config($1, $2); $$;

CREATE OR REPLACE FUNCTION public.get_site_config_history(p_area text)
RETURNS TABLE (revision integer, published_at timestamptz)
LANGUAGE sql STABLE SECURITY INVOKER
SET search_path = politicore, public, pg_temp
AS $$ SELECT * FROM politicore.get_site_config_history($1); $$;

GRANT EXECUTE ON FUNCTION public.get_published_homepage(text) TO anon, authenticated;
GRANT EXECUTE ON FUNCTION public.rollback_site_config(text, integer) TO authenticated;
GRANT EXECUTE ON FUNCTION public.get_site_config_history(text) TO authenticated;
GRANT EXECUTE ON FUNCTION politicore.get_site_config_history(text) TO authenticated;

REVOKE ALL ON FUNCTION public.rollback_site_config(text, integer) FROM anon, PUBLIC;
REVOKE ALL ON FUNCTION public.get_site_config_history(text) FROM anon, PUBLIC;
REVOKE ALL ON FUNCTION politicore.get_site_config_history(text) FROM anon, PUBLIC;
