-- =====================================================================
-- 0001: POLITICORE CORE SCHEMA (Phase 1A)
-- Shared-schema multi-tenancy. Target: Supabase Postgres 15+.
-- Applied locally for tests against an `auth` schema shim that
-- mirrors Supabase's auth schema (see 0000 note in apply-migrations.ts).
-- =====================================================================

CREATE SCHEMA IF NOT EXISTS politicore;
CREATE SCHEMA IF NOT EXISTS auth; -- shim locally; on Supabase the real auth schema already exists

-- ---------------------------------------------------------------------
-- Enums (vocabularies preserved from the current application)
-- ---------------------------------------------------------------------
CREATE TYPE politicore.access_role_enum AS ENUM (
  'member', 'election_officer', 'admin', 'tenant_super_admin', 'platform_super_admin'
);

CREATE TYPE politicore.membership_type_enum AS ENUM ('campaign_member', 'social_member');

CREATE TYPE politicore.lifecycle_status_enum AS ENUM ('active', 'suspended', 'deactivated');

CREATE TYPE politicore.position_enum AS ENUM (
  'campaign_member', 'ward_coordinator', 'lga_coordinator', 'zone_coordinator',
  'state_coordinator', 'campaign_manager', 'council_chairman'
);

CREATE TYPE politicore.scope_type_enum AS ENUM (
  'polling_unit', 'ward', 'lga', 'senatorial_zone', 'state', 'campaign'
);

CREATE TYPE politicore.assignment_status_enum AS ENUM ('active', 'inactive', 'suspended', 'expired');

CREATE TYPE politicore.module_code_enum AS ENUM ('social', 'campaign', 'election', 'governance');

-- ---------------------------------------------------------------------
-- Platform & tenancy
-- ---------------------------------------------------------------------
CREATE TABLE politicore.tenants (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  slug          text NOT NULL UNIQUE CHECK (slug ~ '^[a-z0-9]+(-[a-z0-9]+)*$'),
  name          text NOT NULL CHECK (length(name) BETWEEN 2 AND 120),
  -- Generic tenant config (PolitiCore is NOT campaign-only). Political/
  -- campaign-specific configuration lives in module config, not here.
  primary_state_id text,                       -- nullable FK added after geography exists
  status        text NOT NULL DEFAULT 'active' CHECK (status IN ('active','suspended','cancelled')),
  created_by    uuid,                          -- platform admin (nullable during bootstrap)
  created_at    timestamptz NOT NULL DEFAULT now(),
  updated_at    timestamptz NOT NULL DEFAULT now()
);

-- Module subscriptions: tenant-level activation of the four first-class
-- modules. NOT user roles. A module being enabled ≠ users authorized.
CREATE TABLE politicore.tenant_modules (
  tenant_id    uuid NOT NULL REFERENCES politicore.tenants(id) ON DELETE CASCADE,
  module       politicore.module_code_enum NOT NULL,
  enabled      boolean NOT NULL DEFAULT false,
  config       jsonb NOT NULL DEFAULT '{}'::jsonb,   -- module-level configuration (Control Center)
  enabled_at   timestamptz,
  created_at   timestamptz NOT NULL DEFAULT now(),
  updated_at   timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, module)
);

-- Central Control Center foundations (schema only; UI is out of scope).
CREATE TABLE politicore.platform_settings (
  id           integer PRIMARY KEY DEFAULT 1 CHECK (id = 1),   -- singleton
  settings     jsonb NOT NULL DEFAULT '{}'::jsonb,
  updated_by   uuid,
  created_at   timestamptz NOT NULL DEFAULT now(),
  updated_at   timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE politicore.tenant_settings (
  tenant_id    uuid PRIMARY KEY REFERENCES politicore.tenants(id) ON DELETE CASCADE,
  settings     jsonb NOT NULL DEFAULT '{}'::jsonb,   -- portal/behavior/flags (typed accessors later)
  created_at   timestamptz NOT NULL DEFAULT now(),
  updated_at   timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE politicore.public_site_settings (
  tenant_id     uuid PRIMARY KEY REFERENCES politicore.tenants(id) ON DELETE CASCADE,
  branding      jsonb NOT NULL DEFAULT '{}'::jsonb,
  homepage      jsonb NOT NULL DEFAULT '{}'::jsonb,
  navigation    jsonb NOT NULL DEFAULT '{}'::jsonb,
  footer        jsonb NOT NULL DEFAULT '{}'::jsonb,
  contact       jsonb NOT NULL DEFAULT '{}'::jsonb,
  social_links  jsonb NOT NULL DEFAULT '{}'::jsonb,
  seo           jsonb NOT NULL DEFAULT '{}'::jsonb,
  -- Configurable public participation (audit §12; not one universal model):
  public_participation jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at    timestamptz NOT NULL DEFAULT now(),
  updated_at    timestamptz NOT NULL DEFAULT now()
);

-- ---------------------------------------------------------------------
-- Geography (reference data; national/state scope, not tenant-owned)
-- ---------------------------------------------------------------------
CREATE TABLE politicore.states (
  id    text PRIMARY KEY,
  name  text NOT NULL,
  code  text NOT NULL
);

CREATE TABLE politicore.senatorial_zones (
  id        text PRIMARY KEY,
  state_id  text NOT NULL REFERENCES politicore.states(id),
  name      text NOT NULL,
  code      text NOT NULL,
  UNIQUE (state_id, code)
);

CREATE TABLE politicore.lgas (
  id        text PRIMARY KEY,
  state_id  text NOT NULL REFERENCES politicore.states(id),
  zone_id   text NOT NULL REFERENCES politicore.senatorial_zones(id),
  name      text NOT NULL,
  code      text NOT NULL,
  UNIQUE (state_id, code)
);

CREATE TABLE politicore.wards (
  id      text PRIMARY KEY,
  lga_id  text NOT NULL REFERENCES politicore.lgas(id),
  name    text NOT NULL,
  code    text NOT NULL,
  UNIQUE (lga_id, code)
);

CREATE TABLE politicore.polling_units (
  id       text PRIMARY KEY,
  ward_id  text NOT NULL REFERENCES politicore.wards(id),
  lga_id   text NOT NULL REFERENCES politicore.lgas(id),  -- denormalized for RLS locality
  name     text NOT NULL,
  code     text NOT NULL,
  is_new   boolean NOT NULL DEFAULT false,
  UNIQUE (ward_id, code)
);

ALTER TABLE politicore.tenants
  ADD CONSTRAINT tenants_primary_state_fk
  FOREIGN KEY (primary_state_id) REFERENCES politicore.states(id);

-- ---------------------------------------------------------------------
-- Identity & authorization
-- ---------------------------------------------------------------------
-- Profiles: PolitiCore application identity, 1:1 with Supabase auth users.
CREATE TABLE politicore.profiles (
  id                uuid PRIMARY KEY REFERENCES auth.users(id) ON DELETE CASCADE,
  tenant_id         uuid NOT NULL REFERENCES politicore.tenants(id),
  email             text NOT NULL,
  full_name         text NOT NULL,
  phone             text,
  gender            text CHECK (gender IN ('male','female') OR gender IS NULL),
  -- Registered location (its own authorization path, distinct from assignments)
  lga_id            text REFERENCES politicore.lgas(id),
  ward_id           text REFERENCES politicore.wards(id),
  polling_unit_id   text REFERENCES politicore.polling_units(id),
  access_role       politicore.access_role_enum NOT NULL DEFAULT 'member',
  membership_types  politicore.membership_type_enum[] NOT NULL DEFAULT '{}',
  lifecycle_status  politicore.lifecycle_status_enum NOT NULL DEFAULT 'active',
  status_reason     text,
  -- Social handles (Social Force module data; optional, non-authorizing)
  facebook_name     text, facebook_url text,
  x_name            text, x_url text,
  instagram_name    text, instagram_url text,
  tiktok_name       text, tiktok_url text,
  -- Social engagement metrics (Social Force foundation; leaderboard port target)
  points            integer NOT NULL DEFAULT 0 CHECK (points >= 0),
  rank              text NOT NULL DEFAULT 'Volunteer',
  created_at        timestamptz NOT NULL DEFAULT now(),
  updated_at        timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, email)
);

CREATE INDEX profiles_tenant_idx ON politicore.profiles (tenant_id);
CREATE INDEX profiles_tenant_membership_idx ON politicore.profiles USING gin (membership_types);
CREATE INDEX profiles_ward_idx ON politicore.profiles (ward_id);
CREATE INDEX profiles_lga_idx ON politicore.profiles (lga_id);

-- Positions: organizational positions are NOT access roles. Reference data.
CREATE TABLE politicore.positions (
  name        text PRIMARY KEY,
  description text NOT NULL DEFAULT '',
  grants_authority boolean NOT NULL DEFAULT true  -- campaign_manager/council_chairman=false
);

-- Permission vocabulary: all permissions the platform knows.
CREATE TABLE politicore.permissions (
  name        text PRIMARY KEY,
  domain      text NOT NULL DEFAULT 'general',
  description text NOT NULL DEFAULT ''
);

-- Position default permission matrix (was POSITION_DEFAULT_PERMISSIONS in code).
CREATE TABLE politicore.position_permissions (
  position     text NOT NULL REFERENCES politicore.positions(name),
  permission   text NOT NULL REFERENCES politicore.permissions(name),
  PRIMARY KEY (position, permission)
);

-- Organizational assignments: where a person operates + what position they hold.
CREATE TABLE politicore.organizational_assignments (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id    uuid NOT NULL REFERENCES politicore.tenants(id),
  user_id      uuid NOT NULL REFERENCES politicore.profiles(id),
  position     text NOT NULL REFERENCES politicore.positions(name),
  scope_type   politicore.scope_type_enum NOT NULL,
  scope_id     text NOT NULL,
  status       politicore.assignment_status_enum NOT NULL DEFAULT 'active',
  assigned_by  uuid REFERENCES politicore.profiles(id),
  starts_at    timestamptz,
  ends_at      timestamptz,
  created_at   timestamptz NOT NULL DEFAULT now(),
  updated_at   timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX org_assignments_user_idx ON politicore.organizational_assignments (user_id, status);
CREATE INDEX org_assignments_tenant_idx ON politicore.organizational_assignments (tenant_id, status);
CREATE INDEX org_assignments_scope_idx ON politicore.organizational_assignments (scope_type, scope_id);

-- Permission grants: explicit grant/deny with optional scope.
-- granted=false = explicit denial — semantics preserved from the current model.
CREATE TABLE politicore.permission_grants (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id    uuid NOT NULL REFERENCES politicore.tenants(id),
  user_id      uuid NOT NULL REFERENCES politicore.profiles(id),
  permission   text NOT NULL REFERENCES politicore.permissions(name),
  granted      boolean NOT NULL,
  scope_type   politicore.scope_type_enum,
  scope_id     text,
  granted_by   uuid REFERENCES politicore.profiles(id),
  created_at   timestamptz NOT NULL DEFAULT now(),
  updated_at   timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, user_id, permission, scope_type, scope_id)
);

CREATE INDEX perm_grants_user_idx ON politicore.permission_grants (user_id, permission);

-- ---------------------------------------------------------------------
-- Media (provider-agnostic foundation; R2 is the target provider)
-- ---------------------------------------------------------------------
CREATE TABLE politicore.media_assets (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id     uuid NOT NULL REFERENCES politicore.tenants(id),
  provider      text NOT NULL DEFAULT 'r2' CHECK (provider IN ('r2','supabase','s3','local')),
  bucket        text NOT NULL,
  object_key    text NOT NULL,
  visibility    text NOT NULL DEFAULT 'private' CHECK (visibility IN ('public','private')),
  content_type  text,
  size_bytes    bigint CHECK (size_bytes IS NULL OR size_bytes >= 0),
  checksum      text,
  uploaded_by   uuid REFERENCES politicore.profiles(id),
  purpose       text,                                   -- e.g. 'election_evidence','cms_news'
  metadata      jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at    timestamptz NOT NULL DEFAULT now(),
  updated_at    timestamptz NOT NULL DEFAULT now(),
  UNIQUE (provider, bucket, object_key)
);

CREATE INDEX media_assets_tenant_idx ON politicore.media_assets (tenant_id, created_at DESC);

-- ---------------------------------------------------------------------
-- Audit & notifications
-- ---------------------------------------------------------------------
-- Server-written audit trail (fixes the client-writes-audit latent bug).
CREATE TABLE politicore.system_audits (
  id                  bigserial PRIMARY KEY,
  tenant_id           uuid REFERENCES politicore.tenants(id),   -- nullable: platform-level events
  actor_id            uuid,
  actor_name          text,
  actor_email         text,
  action              text NOT NULL,
  affected_resource   text NOT NULL,
  resource_id         text,
  old_value           jsonb,
  new_value           jsonb,
  reason_notes        text,
  organizational_scope text,
  occurred_at         timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX system_audits_tenant_time_idx ON politicore.system_audits (tenant_id, occurred_at DESC);

-- Notifications: per-user rows (redesign of the tenant-wide scan defect).
CREATE TABLE politicore.notifications (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id    uuid NOT NULL REFERENCES politicore.tenants(id),
  user_id      uuid NOT NULL REFERENCES politicore.profiles(id),
  type         text NOT NULL CHECK (type IN (
                 'task','assignment','activity','election','system','announcement')),
  title        text NOT NULL,
  message      text NOT NULL,
  link_url     text,
  read_at      timestamptz,
  created_by   uuid REFERENCES politicore.profiles(id),
  created_at   timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX notifications_user_idx ON politicore.notifications (user_id, created_at DESC);
CREATE INDEX notifications_user_unread_idx ON politicore.notifications (user_id)
  WHERE read_at IS NULL;

-- ---------------------------------------------------------------------
-- updated_at maintenance trigger
-- ---------------------------------------------------------------------
CREATE OR REPLACE FUNCTION politicore.set_updated_at() RETURNS trigger AS $$
BEGIN
  NEW.updated_at := now();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER trg_tenants_updated BEFORE UPDATE ON politicore.tenants
  FOR EACH ROW EXECUTE FUNCTION politicore.set_updated_at();
CREATE TRIGGER trg_tenant_modules_updated BEFORE UPDATE ON politicore.tenant_modules
  FOR EACH ROW EXECUTE FUNCTION politicore.set_updated_at();
CREATE TRIGGER trg_profiles_updated BEFORE UPDATE ON politicore.profiles
  FOR EACH ROW EXECUTE FUNCTION politicore.set_updated_at();
CREATE TRIGGER trg_assignments_updated BEFORE UPDATE ON politicore.organizational_assignments
  FOR EACH ROW EXECUTE FUNCTION politicore.set_updated_at();
CREATE TRIGGER trg_grants_updated BEFORE UPDATE ON politicore.permission_grants
  FOR EACH ROW EXECUTE FUNCTION politicore.set_updated_at();
CREATE TRIGGER trg_media_updated BEFORE UPDATE ON politicore.media_assets
  FOR EACH ROW EXECUTE FUNCTION politicore.set_updated_at();
CREATE TRIGGER trg_tenant_settings_updated BEFORE UPDATE ON politicore.tenant_settings
  FOR EACH ROW EXECUTE FUNCTION politicore.set_updated_at();
CREATE TRIGGER trg_site_settings_updated BEFORE UPDATE ON politicore.public_site_settings
  FOR EACH ROW EXECUTE FUNCTION politicore.set_updated_at();
