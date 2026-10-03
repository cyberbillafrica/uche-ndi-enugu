-- ============================================================================
-- 0063 — SITE CHROME: HEADER / FOOTER / NAVIGATION (Phase 25)
-- ============================================================================
-- Control Center — configuration-driven header, footer and public navigation.
--
-- Architecture: docs/Control-Center-Architecture-Gate.md §12 (Header is
-- global chrome, rendered by src/components/layout/Header.tsx from
-- configuration), §13 (Footer composition + canonical contact/social
-- bindings), §14 (public navigation builder — presentation, never
-- authorization), §18–20 (draft/preview/publish/history over the EXISTING
-- public_site_settings columns). Phase 25 prompt §3–§24.
--
-- ZERO new tables/roles/permissions. The existing
-- politicore.public_site_settings.navigation / .footer jsonb areas are the
-- sole substrate (cc_is_site_config_area already admits both). Validators
-- are strict allowlists like cc_validate_branding/seo/homepage; unknown
-- keys, types, schemes and vocabulary values never enter storage.
--
--   A. CHROME VALIDATORS  cc_validate_chrome_link / _item / _header_cta,
--                         cc_validate_navigation, cc_validate_footer —
--                         declarative structure only (no executable config,
--                         no arbitrary CSS/HTML/JS, bounded arrays/nesting).
--   B. LIFECYCLE WIRING   save_site_config_draft / publish_site_config
--                         validate the navigation/footer areas (restated
--                         bodies, same merge-safe save semantics as 0062 —
--                         a post-publish draft save never blanks the live
--                         chrome or the bounded history).
--   C. ROLLBACK/HISTORY/  the three admin RPCs admit 'navigation' and
--      PREVIEW AREAS      'footer' (Phase 22 pattern).
--   D. PUBLIC CHROME      get_public_site_chrome extended: published-only
--                         navigation (server-side eligibility: enabled +
--                         service_dependency activated) + footer + canonical
--                         contact/social passthrough. Draft/history/publisher
--                         internals never leave the server.
-- ============================================================================

-- ───────────────────────────────────────────────────────────────────────────
-- A1. LINK VALIDATOR — one destination contract for nav items, children,
--     footer links, legal links and the CTA (§7). Reuses the homepage
--     scheme discipline: internal path / #fragment / http(s) URL only;
--     javascript:/data:/vbscript:/file:/about: never enter storage.
-- ───────────────────────────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION politicore.cc_validate_chrome_link(
  p_link jsonb,
  p_ctx  text
) RETURNS void
LANGUAGE plpgsql
STABLE
SET search_path = politicore, pg_temp
AS $$
DECLARE
  v_key   text;
  v_href  text;
  v_label text;
  v_rel   text;
BEGIN
  IF p_link IS NULL OR jsonb_typeof(p_link) <> 'object' THEN
    RAISE EXCEPTION '% link must be a JSON object.', p_ctx;
  END IF;
  FOR v_key IN SELECT jsonb_object_keys(p_link) LOOP
    IF v_key NOT IN ('label', 'href', 'rel') THEN
      RAISE EXCEPTION '% link has an unknown field "%".', p_ctx, v_key;
    END IF;
  END LOOP;

  v_label := p_link ->> 'label';
  IF v_label IS NULL OR length(btrim(v_label)) = 0 OR length(v_label) > 120 THEN
    RAISE EXCEPTION '% link label must be 1..120 characters.', p_ctx;
  END IF;

  v_href := p_link ->> 'href';
  IF v_href IS NULL OR length(btrim(v_href)) = 0 THEN
    RAISE EXCEPTION '% link href is required.', p_ctx;
  END IF;
  PERFORM politicore.cc_assert_safe_href(v_href, p_ctx);

  -- External links must open safely; internal/anchors must not carry rel.
  v_rel := NULLIF(p_link ->> 'rel', '');
  IF v_href ~* '^https?://' THEN
    IF v_rel IS DISTINCT FROM 'noopener noreferrer' THEN
      RAISE EXCEPTION '% external link must declare rel "noopener noreferrer".', p_ctx;
    END IF;
  ELSIF v_rel IS NOT NULL THEN
    RAISE EXCEPTION '% internal link must not declare rel.', p_ctx;
  END IF;
END;
$$;

-- ───────────────────────────────────────────────────────────────────────────
-- A2. HEADER CTA VALIDATOR — bounded presentation object (§5).
-- ───────────────────────────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION politicore.cc_validate_chrome_header_cta(
  p_cta jsonb
) RETURNS void
LANGUAGE plpgsql
STABLE
SET search_path = politicore, pg_temp
AS $$
DECLARE
  v_key  text;
  v_on   boolean;
BEGIN
  IF p_cta IS NULL OR jsonb_typeof(p_cta) <> 'object' THEN
    RAISE EXCEPTION 'Header CTA must be a JSON object.';
  END IF;
  FOR v_key IN SELECT jsonb_object_keys(p_cta) LOOP
    IF v_key NOT IN ('enabled', 'label', 'href') THEN
      RAISE EXCEPTION 'Header CTA has an unknown field "%".', v_key;
    END IF;
  END LOOP;
  v_on := COALESCE((p_cta ->> 'enabled')::boolean, false);
  IF v_on THEN
    IF p_cta ->> 'label' IS NULL
       OR length(btrim(p_cta ->> 'label')) = 0
       OR length(p_cta ->> 'label') > 60 THEN
      RAISE EXCEPTION 'Header CTA label must be 1..60 characters when enabled.';
    END IF;
    IF p_cta ->> 'href' IS NULL OR length(btrim(p_cta ->> 'href')) = 0 THEN
      RAISE EXCEPTION 'Header CTA href is required when enabled.';
    END IF;
    PERFORM politicore.cc_assert_safe_href(p_cta ->> 'href', 'header CTA');
  END IF;
END;
$$;

-- ───────────────────────────────────────────────────────────────────────────
-- A3. NAVIGATION ITEM VALIDATOR — the item vocabulary (§6, §8, §9):
--     id (stable), label, href, type (internal|external|anchor), ordering is
--     array position in the DRAFT (items are reordered, never positional
--     identity), visibility (public|authenticated — presentation ONLY, never
--     authorization), optional service_dependency (module_code_enum), bounded
--     presentation variants, and ONE bounded child level for dropdown groups.
-- ───────────────────────────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION politicore.cc_validate_chrome_item(
  p_item  jsonb,
  p_depth integer
) RETURNS void
LANGUAGE plpgsql
STABLE
SET search_path = politicore, pg_temp
AS $$
DECLARE
  v_key    text;
  v_id     text;
  v_label  text;
  v_type   text;
  v_vis    text;
  v_dep    text;
  v_child  jsonb;
  v_style  text;
  v_n      integer := 0;
BEGIN
  IF p_item IS NULL OR jsonb_typeof(p_item) <> 'object' THEN
    RAISE EXCEPTION 'Navigation item must be a JSON object.';
  END IF;
  FOR v_key IN SELECT jsonb_object_keys(p_item) LOOP
    IF v_key NOT IN ('id', 'label', 'href', 'type', 'visibility', 'enabled',
                     'service_dependency', 'presentation', 'children') THEN
      RAISE EXCEPTION 'Navigation item has an unknown field "%".', v_key;
    END IF;
  END LOOP;

  IF p_item #> '{enabled}' IS NOT NULL
     AND jsonb_typeof(p_item #> '{enabled}') <> 'boolean' THEN
    RAISE EXCEPTION 'Navigation item "%" enabled must be a boolean.', p_item ->> 'id';
  END IF;

  v_id := p_item ->> 'id';
  IF v_id IS NULL
     OR v_id !~ '^[A-Za-z0-9_-]{1,64}$' THEN
    RAISE EXCEPTION 'Navigation item id must match [A-Za-z0-9_-]{1,64}.';
  END IF;

  v_label := p_item ->> 'label';
  IF v_label IS NULL OR length(btrim(v_label)) = 0 OR length(v_label) > 120 THEN
    RAISE EXCEPTION 'Navigation item "%" label must be 1..120 characters.', v_id;
  END IF;

  v_type := COALESCE(p_item ->> 'type', 'internal');
  IF v_type NOT IN ('internal', 'external', 'anchor') THEN
    RAISE EXCEPTION 'Navigation item "%" has an unsupported type "%".', v_id, v_type;
  END IF;

  v_vis := COALESCE(p_item ->> 'visibility', 'public');
  IF v_vis NOT IN ('public', 'authenticated') THEN
    RAISE EXCEPTION 'Navigation item "%" has an unsupported visibility "%".', v_id, v_vis;
  END IF;

  v_dep := NULLIF(p_item ->> 'service_dependency', '');
  IF v_dep IS NOT NULL AND v_dep NOT IN ('social', 'campaign', 'election', 'governance') THEN
    RAISE EXCEPTION 'Navigation item "%" has an unsupported service_dependency.', v_id;
  END IF;

  -- Presentation is a bounded variant vocabulary — never CSS/class strings.
  IF p_item ? 'presentation' THEN
    IF jsonb_typeof(p_item -> 'presentation') <> 'object' THEN
      RAISE EXCEPTION 'Navigation item "%" presentation must be an object.', v_id;
    END IF;
    FOR v_key IN SELECT jsonb_object_keys(p_item -> 'presentation') LOOP
      IF v_key NOT IN ('style', 'emphasis') THEN
        RAISE EXCEPTION 'Navigation item "%" presentation has an unknown field "%".', v_id, v_key;
      END IF;
    END LOOP;
    v_style := p_item #>> '{presentation,style}';
    IF v_style IS NOT NULL AND v_style NOT IN ('default', 'underline', 'pill') THEN
      RAISE EXCEPTION 'Navigation item "%" has an unsupported presentation style.', v_id;
    END IF;
    IF p_item #> '{presentation,emphasis}' IS NOT NULL
       AND jsonb_typeof(p_item #> '{presentation,emphasis}') <> 'boolean' THEN
      RAISE EXCEPTION 'Navigation item "%" presentation.emphasis must be a boolean.', v_id;
    END IF;
  END IF;

  PERFORM politicore.cc_assert_safe_href(p_item ->> 'href', v_id);

  -- Exactly ONE bounded child level (§6: no arbitrary nesting depth).
  IF p_item ? 'children' THEN
    IF p_depth > 0 THEN
      RAISE EXCEPTION 'Navigation item "%" must not nest children deeper than one level.', v_id;
    END IF;
    IF jsonb_typeof(p_item -> 'children') <> 'array' THEN
      RAISE EXCEPTION 'Navigation item "%" children must be an array.', v_id;
    END IF;
    FOR v_child IN SELECT * FROM jsonb_array_elements(p_item -> 'children') LOOP
      v_n := v_n + 1;
      IF v_n > 8 THEN
        RAISE EXCEPTION 'Navigation item "%" exceeds 8 children.', v_id;
      END IF;
      PERFORM politicore.cc_validate_chrome_item(v_child, p_depth + 1);
    END LOOP;
  END IF;
END;
$$;

-- ───────────────────────────────────────────────────────────────────────────
-- A4. NAVIGATION AREA VALIDATOR — { items[], header{...} } (§12/§14/§20 of
--     the Phase 21 gate; prompt §4/§5). Unknown keys rejected. Bounded 12
--     top-level items; unique stable ids; unique labels at the top level
--     (deterministic, accessible navigation).
-- ───────────────────────────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION politicore.cc_validate_navigation(
  p_config jsonb
) RETURNS jsonb
LANGUAGE plpgsql
STABLE
SET search_path = politicore, pg_temp
AS $$
DECLARE
  v_key   text;
  v_item  jsonb;
  v_n     integer := 0;
  v_hdr   jsonb;
  v_hkey  text;
  v_style text;
BEGIN
  IF p_config IS NULL OR p_config = 'null'::jsonb THEN
    RETURN '{}'::jsonb;
  END IF;
  IF jsonb_typeof(p_config) <> 'object' THEN
    RAISE EXCEPTION 'Navigation configuration must be a JSON object.';
  END IF;
  FOR v_key IN SELECT jsonb_object_keys(p_config) LOOP
    IF v_key NOT IN ('items', 'header') THEN
      RAISE EXCEPTION 'Navigation configuration has an unknown field "%".', v_key;
    END IF;
  END LOOP;

  IF p_config ? 'items' THEN
    IF jsonb_typeof(p_config -> 'items') <> 'array' THEN
      RAISE EXCEPTION 'Navigation items must be an array.';
    END IF;
    FOR v_item IN SELECT * FROM jsonb_array_elements(p_config -> 'items') LOOP
      v_n := v_n + 1;
      IF v_n > 12 THEN
        RAISE EXCEPTION 'Navigation configuration exceeds 12 top-level items.';
      END IF;
      PERFORM politicore.cc_validate_chrome_item(v_item, 0);
    END LOOP;
    IF (SELECT count(DISTINCT e ->> 'id')
          FROM jsonb_array_elements(p_config -> 'items') e)
       <> jsonb_array_length(p_config -> 'items') THEN
      RAISE EXCEPTION 'Navigation item ids must be unique.';
    END IF;
    IF (SELECT count(DISTINCT lower(e ->> 'label'))
          FROM jsonb_array_elements(p_config -> 'items') e)
       <> jsonb_array_length(p_config -> 'items') THEN
      RAISE EXCEPTION 'Navigation item labels must be unique.';
    END IF;
  END IF;

  IF p_config ? 'header' THEN
    v_hdr := p_config -> 'header';
    IF jsonb_typeof(v_hdr) <> 'object' THEN
      RAISE EXCEPTION 'Header configuration must be a JSON object.';
    END IF;
    FOR v_hkey IN SELECT jsonb_object_keys(v_hdr) LOOP
      IF v_hkey NOT IN ('show_logo', 'show_site_name', 'show_primary_nav',
                        'cta', 'mobile_menu', 'alignment') THEN
        RAISE EXCEPTION 'Header configuration has an unknown field "%".', v_hkey;
      END IF;
    END LOOP;
    IF v_hdr #> '{show_logo}' IS NOT NULL
       AND jsonb_typeof(v_hdr #> '{show_logo}') <> 'boolean' THEN
      RAISE EXCEPTION 'Header show_logo must be a boolean.';
    END IF;
    IF v_hdr #> '{show_site_name}' IS NOT NULL
       AND jsonb_typeof(v_hdr #> '{show_site_name}') <> 'boolean' THEN
      RAISE EXCEPTION 'Header show_site_name must be a boolean.';
    END IF;
    IF v_hdr #> '{show_primary_nav}' IS NOT NULL
       AND jsonb_typeof(v_hdr #> '{show_primary_nav}') <> 'boolean' THEN
      RAISE EXCEPTION 'Header show_primary_nav must be a boolean.';
    END IF;
    IF v_hdr ? 'cta' THEN
      PERFORM politicore.cc_validate_chrome_header_cta(v_hdr -> 'cta');
    END IF;
    IF v_hdr ? 'mobile_menu' THEN
      v_style := v_hdr ->> 'mobile_menu';
      IF v_style NOT IN ('accordion', 'drawer') THEN
        RAISE EXCEPTION 'Header mobile_menu has an unsupported value.';
      END IF;
    END IF;
    IF v_hdr ? 'alignment' THEN
      v_style := v_hdr ->> 'alignment';
      IF v_style NOT IN ('left', 'center', 'right') THEN
        RAISE EXCEPTION 'Header alignment has an unsupported value.';
      END IF;
    END IF;
  END IF;

  RETURN p_config;
END;
$$;

-- ───────────────────────────────────────────────────────────────────────────
-- A5. FOOTER AREA VALIDATOR — { columns[], legal, social, presentation }
--     (§11/§13/§24 of the prompt). Contact/social DATA is never duplicated —
--     the renderer binds canonical `contact` / `social_links` projections;
--     the footer area only controls placement/presentation.
-- ───────────────────────────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION politicore.cc_validate_footer(
  p_config jsonb
) RETURNS jsonb
LANGUAGE plpgsql
STABLE
SET search_path = politicore, pg_temp
AS $$
DECLARE
  v_key    text;
  v_col    jsonb;
  v_ckey   text;
  v_link   jsonb;
  v_l      integer;
  v_n      integer := 0;
  v_cols   jsonb;
  v_sub    jsonb;
  v_skey   text;
  v_layout text;
BEGIN
  IF p_config IS NULL OR p_config = 'null'::jsonb THEN
    RETURN '{}'::jsonb;
  END IF;
  IF jsonb_typeof(p_config) <> 'object' THEN
    RAISE EXCEPTION 'Footer configuration must be a JSON object.';
  END IF;
  FOR v_key IN SELECT jsonb_object_keys(p_config) LOOP
    IF v_key NOT IN ('columns', 'legal', 'social', 'presentation') THEN
      RAISE EXCEPTION 'Footer configuration has an unknown field "%".', v_key;
    END IF;
  END LOOP;

  IF p_config ? 'columns' THEN
    v_cols := p_config -> 'columns';
    IF jsonb_typeof(v_cols) <> 'array' THEN
      RAISE EXCEPTION 'Footer columns must be an array.';
    END IF;
    FOR v_col IN SELECT * FROM jsonb_array_elements(v_cols) LOOP
      v_n := v_n + 1;
      IF v_n > 4 THEN
        RAISE EXCEPTION 'Footer configuration exceeds 4 columns.';
      END IF;
      IF jsonb_typeof(v_col) <> 'object' THEN
        RAISE EXCEPTION 'Footer column % must be a JSON object.', v_n;
      END IF;
      FOR v_ckey IN SELECT jsonb_object_keys(v_col) LOOP
        IF v_ckey NOT IN ('id', 'heading', 'links') THEN
          RAISE EXCEPTION 'Footer column % has an unknown field "%".', v_n, v_ckey;
        END IF;
      END LOOP;
      IF v_col ->> 'id' IS NULL
         OR v_col ->> 'id' !~ '^[A-Za-z0-9_-]{1,64}$' THEN
        RAISE EXCEPTION 'Footer column % id must match [A-Za-z0-9_-]{1,64}.', v_n;
      END IF;
      IF v_col ->> 'heading' IS NULL
         OR length(btrim(v_col ->> 'heading')) = 0
         OR length(v_col ->> 'heading') > 60 THEN
        RAISE EXCEPTION 'Footer column % heading must be 1..60 characters.', v_n;
      END IF;
      IF v_col ? 'links' THEN
        IF jsonb_typeof(v_col -> 'links') <> 'array' THEN
          RAISE EXCEPTION 'Footer column % links must be an array.', v_n;
        END IF;
        v_l := 0;
        FOR v_link IN SELECT * FROM jsonb_array_elements(v_col -> 'links') LOOP
          v_l := v_l + 1;
          IF v_l > 8 THEN
            RAISE EXCEPTION 'Footer column % exceeds 8 links.', v_n;
          END IF;
          PERFORM politicore.cc_validate_chrome_link(v_link,
            format('Footer column %s link %s', v_n, v_l));
        END LOOP;
      END IF;
    END LOOP;
    IF (SELECT count(DISTINCT e ->> 'id')
          FROM jsonb_array_elements(v_cols) e)
       <> jsonb_array_length(v_cols) THEN
      RAISE EXCEPTION 'Footer column ids must be unique.';
    END IF;
  END IF;

  IF p_config ? 'legal' THEN
    v_sub := p_config -> 'legal';
    IF jsonb_typeof(v_sub) <> 'object' THEN
      RAISE EXCEPTION 'Footer legal must be an object.';
    END IF;
    FOR v_skey IN SELECT jsonb_object_keys(v_sub) LOOP
      IF v_skey NOT IN ('copyright', 'links') THEN
        RAISE EXCEPTION 'Footer legal has an unknown field "%".', v_skey;
      END IF;
    END LOOP;
    IF v_sub ? 'copyright'
       AND (v_sub ->> 'copyright' IS NULL
            OR length(v_sub ->> 'copyright') > 160) THEN
      RAISE EXCEPTION 'Footer legal copyright must be at most 160 characters.';
    END IF;
    IF v_sub ? 'links' THEN
      IF jsonb_typeof(v_sub -> 'links') <> 'array' THEN
        RAISE EXCEPTION 'Footer legal links must be an array.';
      END IF;
      v_l := 0;
      FOR v_link IN SELECT * FROM jsonb_array_elements(v_sub -> 'links') LOOP
        v_l := v_l + 1;
        IF v_l > 6 THEN
          RAISE EXCEPTION 'Footer legal exceeds 6 links.';
        END IF;
        PERFORM politicore.cc_validate_chrome_link(v_link,
          format('Footer legal link %s', v_l));
      END LOOP;
    END IF;
  END IF;

  -- social: placement/presentation ONLY — links come from social_links.
  IF p_config ? 'social' THEN
    v_sub := p_config -> 'social';
    IF jsonb_typeof(v_sub) <> 'object' THEN
      RAISE EXCEPTION 'Footer social must be an object.';
    END IF;
    FOR v_skey IN SELECT jsonb_object_keys(v_sub) LOOP
      IF v_skey NOT IN ('show') THEN
        RAISE EXCEPTION 'Footer social has an unknown field "%".', v_skey;
      END IF;
    END LOOP;
    IF v_sub #> '{show}' IS NOT NULL
       AND jsonb_typeof(v_sub #> '{show}') <> 'boolean' THEN
      RAISE EXCEPTION 'Footer social.show must be a boolean.';
    END IF;
  END IF;

  IF p_config ? 'presentation' THEN
    v_sub := p_config -> 'presentation';
    IF jsonb_typeof(v_sub) <> 'object' THEN
      RAISE EXCEPTION 'Footer presentation must be an object.';
    END IF;
    FOR v_skey IN SELECT jsonb_object_keys(v_sub) LOOP
      IF v_skey NOT IN ('layout', 'show_contact', 'show_cta',
                        'cta_heading', 'cta_label', 'cta_href') THEN
        RAISE EXCEPTION 'Footer presentation has an unknown field "%".', v_skey;
      END IF;
    END LOOP;
    IF v_sub ? 'cta_heading'
       AND (v_sub ->> 'cta_heading' IS NULL
            OR length(btrim(v_sub ->> 'cta_heading')) = 0
            OR length(v_sub ->> 'cta_heading') > 120) THEN
      RAISE EXCEPTION 'Footer presentation cta_heading must be 1..120 characters.';
    END IF;
    IF v_sub ? 'layout' THEN
      v_layout := v_sub ->> 'layout';
      IF v_layout NOT IN ('columns-3', 'columns-4') THEN
        RAISE EXCEPTION 'Footer presentation layout has an unsupported value.';
      END IF;
    END IF;
    IF v_sub #> '{show_contact}' IS NOT NULL
       AND jsonb_typeof(v_sub #> '{show_contact}') <> 'boolean' THEN
      RAISE EXCEPTION 'Footer presentation show_contact must be a boolean.';
    END IF;
    IF v_sub #> '{show_cta}' IS NOT NULL
       AND jsonb_typeof(v_sub #> '{show_cta}') <> 'boolean' THEN
      RAISE EXCEPTION 'Footer presentation show_cta must be a boolean.';
    END IF;
    IF v_sub ? 'cta_label'
       AND (v_sub ->> 'cta_label' IS NULL
            OR length(btrim(v_sub ->> 'cta_label')) = 0
            OR length(v_sub ->> 'cta_label') > 60) THEN
      RAISE EXCEPTION 'Footer presentation cta_label must be 1..60 characters.';
    END IF;
    IF v_sub ? 'cta_href'
       AND (v_sub ->> 'cta_href' IS NULL
            OR length(btrim(v_sub ->> 'cta_href')) = 0) THEN
      RAISE EXCEPTION 'Footer presentation cta_href is required.';
    END IF;
    PERFORM politicore.cc_assert_safe_href(v_sub ->> 'cta_href', 'footer CTA');
  END IF;

  RETURN p_config;
END;
$$;

-- ───────────────────────────────────────────────────────────────────────────
-- B. LIFECYCLE WIRING — restated save/publish with navigation/footer
--    validation branches. Bodies identical to 0062 except the validator
--    dispatch (and the 0062 merge-safe save semantics are preserved:
--    jsonb-shallow-merge upsert, so a draft save never destroys
--    'published'/'history').
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
  ELSIF p_area = 'navigation' THEN
    p_draft := politicore.cc_validate_navigation(p_draft);
  ELSIF p_area = 'footer' THEN
    p_draft := politicore.cc_validate_footer(p_draft);
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
  -- semantics would blank the live chrome between publish cycles and
  -- destroy bounded history, the Phase 24 lesson / prompt §14).
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
  ELSIF p_area = 'navigation' THEN
    PERFORM politicore.cc_validate_navigation(v_row -> 'draft');
  ELSIF p_area = 'footer' THEN
    PERFORM politicore.cc_validate_footer(v_row -> 'draft');
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
-- C. ROLLBACK / HISTORY / PREVIEW — admit navigation + footer (same bodies,
--    extended area dispatch). Rollback still promotes through the validated
--    save path; history is never destructively mutated.
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
  ELSIF p_area = 'navigation' THEN
    SELECT navigation INTO v_row FROM politicore.public_site_settings WHERE tenant_id = v_tenant;
  ELSIF p_area = 'footer' THEN
    SELECT footer INTO v_row FROM politicore.public_site_settings WHERE tenant_id = v_tenant;
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
  ELSIF p_area = 'navigation' THEN
    SELECT navigation INTO v_row FROM politicore.public_site_settings WHERE tenant_id = v_tenant;
  ELSIF p_area = 'footer' THEN
    SELECT footer INTO v_row FROM politicore.public_site_settings WHERE tenant_id = v_tenant;
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
  ELSIF p_area = 'navigation' THEN
    SELECT navigation INTO v_row FROM politicore.public_site_settings WHERE tenant_id = v_tenant;
  ELSIF p_area = 'footer' THEN
    SELECT footer INTO v_row FROM politicore.public_site_settings WHERE tenant_id = v_tenant;
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
-- D. PUBLIC CHROME PROJECTION — published-only, server-side eligibility
--    (prompt §16/§17). Extends the Phase 23 shape with navigation (items
--    filtered: enabled + service_dependency activated; visibility is
--    presentation state consumed by the single renderer), footer, and the
--    canonical contact/social payloads the footer binds (never duplicated).
--    Draft, history, revision internals and publisher identity never leave
--    the server. Malformed stored payloads fail safe to bounded defaults.
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
  v_settings politicore.public_site_settings%ROWTYPE;
  v_nav      jsonb;
  v_items    jsonb;
  v_item     jsonb;
  v_dep      text;
  v_out      jsonb;
  v_mods     jsonb;
BEGIN
  SELECT id INTO v_tenant FROM politicore.tenants WHERE slug = p_tenant_slug;
  IF v_tenant IS NULL THEN
    RETURN jsonb_build_object('branding', '{}'::jsonb, 'seo', '{}'::jsonb,
                              'navigation', '{}'::jsonb, 'footer', '{}'::jsonb,
                              'contact', '{}'::jsonb, 'social_links', '{}'::jsonb);
  END IF;
  SELECT * INTO v_settings FROM politicore.public_site_settings WHERE tenant_id = v_tenant;

  -- Server-side eligibility (Phase 24 §12 semantics): a disabled item, or an
  -- enabled item whose service_dependency module is not activated, is
  -- suppressed from the PUBLIC composition. Stored config is never mutated.
  SELECT jsonb_object_agg(module, enabled) INTO v_mods
    FROM politicore.tenant_modules WHERE tenant_id = v_tenant;

  v_items := COALESCE(v_settings.navigation #> '{published,items}', '[]'::jsonb);
  IF jsonb_typeof(v_items) <> 'array' THEN
    v_items := '[]'::jsonb; -- §17: malformed legacy payload fails safe
  END IF;
  v_out := '[]'::jsonb;
  FOR v_item IN SELECT * FROM jsonb_array_elements(v_items) LOOP
    v_dep := NULLIF(v_item->>'service_dependency', '');
    IF COALESCE(v_item->>'enabled', 'true') = 'true'
       AND (v_dep IS NULL OR COALESCE((v_mods ->> v_dep)::boolean, false)) THEN
      v_out := v_out || v_item;
    END IF;
  END LOOP;
  v_nav := jsonb_build_object('items', v_out,
                              'header', COALESCE(v_settings.navigation #> '{published,header}', '{}'::jsonb));

  RETURN jsonb_build_object(
    'branding',     COALESCE(v_settings.branding     -> 'published', '{}'::jsonb),
    'seo',          COALESCE(v_settings.seo          -> 'published', '{}'::jsonb),
    'navigation',   v_nav,
    'footer',       COALESCE(v_settings.footer       -> 'published', '{}'::jsonb),
    'contact',      COALESCE(v_settings.contact      -> 'published', '{}'::jsonb),
    'social_links', COALESCE(v_settings.social_links -> 'published', '{}'::jsonb)
  );
END;
$$;
