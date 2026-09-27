-- POLITICORE — MIGRATION 0033: PUBLIC/CONTENT MODULES (PHASE 4).
--
-- Establishes the canonical Supabase content domains replacing the legacy
-- Firebase/Firestore content stores. Each domain is a FIRST-CLASS table
-- under the existing tenant architecture — most importantly:
--
--   * politicore.events         — PUBLIC website content (draft/published/
--                                 cancelled lifecycle). NOT campaign
--                                 activities, which remain the Campaign
--                                 module's locked domain.
--   * politicore.announcements  — AUTHENTICATED tenant communications
--                                 (draft/published/archived). NOT
--                                 notifications (Core, locked), NOT public
--                                 content. A published announcement is
--                                 still private to authenticated users.
--
-- The historical Firebase model combined events + announcements in one
-- polymorphic document (portal_content.items[] with a `type`
-- discriminator). That representation is OBSOLETE and is deliberately NOT
-- reproduced: separate tables, separate services, separate RLS, separate
-- UIs. No combined `content`/`communications` model exists here.
--
-- Single-row content domains (tenant_id PRIMARY KEY, mirroring the
-- one-tenant-one-document Firebase shape):
--   * politicore.biographies    — public when published
--   * politicore.galleries      — public when published; media stays in the
--                                 images jsonb (URLs produced by the
--                                 provider-agnostic Media Service)
--   * politicore.manifestos     — public when published
--
-- Multi-row domains:
--   * politicore.news_articles  — public published-only reads; full
--                                 draft/scheduled/archived lifecycle for
--                                 tenant admins
--   * politicore.contact_messages — anonymous submissions allowed (public
--                                 contact form); unread/read lifecycle;
--                                 tenant admins read within their tenant
--   * politicore.donations      — PRIVATE admin-only ledger of donations
--                                 received directly by the campaign.
--                                 NOT public collection: no checkout, no
--                                 gateway, no public form. Donors are a
--                                 rolled-up projection maintained by
--                                 triggers (append-only ledger, idempotent
--                                 recomputation).
--
-- Security model (0002 conventions; server-resolved tenant/actor only):
--   * public: published-only reads via policy predicates; zero writes
--   * authenticated: same-tenant reads (announcements gated by membership
--     scope via 0002 has_membership())
--   * tenant admins: same-tenant management (politicore.is_tenant_admin())
--   * donations: tenant-admin ONLY — anonymous and ordinary members denied
--
-- All tables FORCE RLS (owner bypass removed) except where noted.

-- ─────────────────────────────────────────────────────────────────────────
-- EVENTS — public website content (NOT campaign activities)
-- ─────────────────────────────────────────────────────────────────────────
CREATE TABLE politicore.events (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id     uuid NOT NULL REFERENCES politicore.tenants(id) ON DELETE CASCADE,
  title         text NOT NULL,
  description   text NOT NULL DEFAULT '',
  event_date    date NOT NULL,
  event_time    text NOT NULL DEFAULT '10:00',
  venue         text NOT NULL,
  ward_id       text REFERENCES politicore.wards(id),
  status        text NOT NULL DEFAULT 'draft'
                CHECK (status IN ('draft', 'published', 'cancelled')),
  created_by    uuid REFERENCES politicore.profiles(id),
  created_at    timestamptz NOT NULL DEFAULT now(),
  updated_at    timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX events_tenant_status_idx ON politicore.events (tenant_id, status);
CREATE INDEX events_tenant_date_idx   ON politicore.events (tenant_id, event_date);

ALTER TABLE politicore.events ENABLE ROW LEVEL SECURITY;
ALTER TABLE politicore.events FORCE  ROW LEVEL SECURITY;

CREATE POLICY events_read_published ON politicore.events
  FOR SELECT USING (
    status = 'published'
    OR tenant_id = politicore.current_tenant_id()
    OR politicore.is_platform_admin()
  );
CREATE POLICY events_admin ON politicore.events
  FOR ALL USING (tenant_id = politicore.current_tenant_id() AND politicore.is_tenant_admin())
  WITH CHECK (tenant_id = politicore.current_tenant_id() AND politicore.is_tenant_admin());

-- ─────────────────────────────────────────────────────────────────────────
-- ANNOUNCEMENTS — authenticated tenant communications (NOT notifications)
-- ─────────────────────────────────────────────────────────────────────────
CREATE TABLE politicore.announcements (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id     uuid NOT NULL REFERENCES politicore.tenants(id) ON DELETE CASCADE,
  title         text NOT NULL,
  content       text NOT NULL,
  scope         text NOT NULL DEFAULT 'general'
                CHECK (scope IN ('general','campaign_members','social_members',
                                 'election_officers','admins')),
  status        text NOT NULL DEFAULT 'draft'
                CHECK (status IN ('draft', 'published', 'archived')),
  published_at  timestamptz,
  created_by    uuid REFERENCES politicore.profiles(id),
  created_at    timestamptz NOT NULL DEFAULT now(),
  updated_at    timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX announcements_tenant_status_idx ON politicore.announcements (tenant_id, status);

ALTER TABLE politicore.announcements ENABLE ROW LEVEL SECURITY;
ALTER TABLE politicore.announcements FORCE  ROW LEVEL SECURITY;

-- Authenticated same-tenant members read PUBLISHED announcements in their
-- membership scope (admins see all). Anonymous reads nothing: the anon role
-- holds no table grant. Drafts/archives are admin-only. A published
-- announcement is still private to authenticated users.
CREATE POLICY announcements_read ON politicore.announcements
  FOR SELECT USING (
    tenant_id = politicore.current_tenant_id()
    AND status = 'published'
    AND (
      politicore.is_tenant_admin()
      OR scope = 'general'
      OR (scope = 'campaign_members' AND politicore.has_membership('campaign_member'))
      OR (scope = 'social_members'   AND politicore.has_membership('social_member'))
      OR (scope = 'election_officers' AND politicore.current_access_role() = 'election_officer')
    )
  );
CREATE POLICY announcements_admin ON politicore.announcements
  FOR ALL USING (tenant_id = politicore.current_tenant_id() AND politicore.is_tenant_admin())
  WITH CHECK (tenant_id = politicore.current_tenant_id() AND politicore.is_tenant_admin());

-- ─────────────────────────────────────────────────────────────────────────
-- NEWS — public published content; admin lifecycle
-- ─────────────────────────────────────────────────────────────────────────
CREATE TABLE politicore.news_articles (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id      uuid NOT NULL REFERENCES politicore.tenants(id) ON DELETE CASCADE,
  title          text NOT NULL,
  slug           text NOT NULL,
  excerpt        text NOT NULL DEFAULT '',
  content        text NOT NULL DEFAULT '',
  featured_image text,
  category       text,
  status         text NOT NULL DEFAULT 'draft'
                 CHECK (status IN ('draft', 'published', 'scheduled', 'archived')),
  published_at   timestamptz,
  scheduled_at   timestamptz,
  author         text,
  created_by     uuid REFERENCES politicore.profiles(id),
  updated_by     uuid REFERENCES politicore.profiles(id),
  created_at     timestamptz NOT NULL DEFAULT now(),
  updated_at     timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, slug)
);

CREATE INDEX news_tenant_status_idx ON politicore.news_articles (tenant_id, status);
CREATE UNIQUE INDEX news_published_slug_idx
  ON politicore.news_articles (tenant_id, slug) WHERE status = 'published';

ALTER TABLE politicore.news_articles ENABLE ROW LEVEL SECURITY;
ALTER TABLE politicore.news_articles FORCE  ROW LEVEL SECURITY;

CREATE POLICY news_read_published ON politicore.news_articles
  FOR SELECT USING (
    status = 'published'
    OR tenant_id = politicore.current_tenant_id()
    OR politicore.is_platform_admin()
  );
CREATE POLICY news_admin ON politicore.news_articles
  FOR ALL USING (tenant_id = politicore.current_tenant_id() AND politicore.is_tenant_admin())
  WITH CHECK (tenant_id = politicore.current_tenant_id() AND politicore.is_tenant_admin());

-- ─────────────────────────────────────────────────────────────────────────
-- CONTACT — anonymous submissions (public form); admin read lifecycle
-- ─────────────────────────────────────────────────────────────────────────
CREATE TABLE politicore.contact_messages (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id   uuid NOT NULL REFERENCES politicore.tenants(id) ON DELETE CASCADE,
  name        text NOT NULL,
  email       text NOT NULL,
  phone       text,
  message     text NOT NULL,
  status      text NOT NULL DEFAULT 'unread' CHECK (status IN ('unread', 'read')),
  created_at  timestamptz NOT NULL DEFAULT now(),
  updated_at  timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX contact_tenant_status_idx ON politicore.contact_messages (tenant_id, status);

ALTER TABLE politicore.contact_messages ENABLE ROW LEVEL SECURITY;
ALTER TABLE politicore.contact_messages FORCE  ROW LEVEL SECURITY;

-- Anonymous/browser visitors may submit (the public contact form). Writes
-- carry an explicit tenant_id — the form targets the site's own tenant —
-- and cannot touch existing rows (no UPDATE/DELETE grant to anon).
CREATE POLICY contact_insert_public ON politicore.contact_messages
  FOR INSERT TO anon, authenticated
  WITH CHECK (true);
CREATE POLICY contact_read_admin ON politicore.contact_messages
  FOR SELECT USING (tenant_id = politicore.current_tenant_id() AND politicore.is_tenant_admin());
CREATE POLICY contact_update_admin ON politicore.contact_messages
  FOR UPDATE USING (tenant_id = politicore.current_tenant_id() AND politicore.is_tenant_admin())
  WITH CHECK (tenant_id = politicore.current_tenant_id() AND politicore.is_tenant_admin());

-- ─────────────────────────────────────────────────────────────────────────
-- Single-row content: biography / gallery / manifesto
-- (tenant_id PRIMARY KEY — one row per tenant, mirroring the Firebase
-- one-document-per-tenant shape without reproducing Firebase itself)
-- ─────────────────────────────────────────────────────────────────────────
CREATE TABLE politicore.biographies (
  tenant_id    uuid PRIMARY KEY REFERENCES politicore.tenants(id) ON DELETE CASCADE,
  full_name    text NOT NULL DEFAULT '',
  title        text NOT NULL DEFAULT '',
  about        text NOT NULL DEFAULT '',
  image_url    text,
  stats        jsonb NOT NULL DEFAULT '{"years_experience":0,"communities_served":0,"volunteers":0}'::jsonb,
  social_links jsonb NOT NULL DEFAULT '{}'::jsonb,
  status       text NOT NULL DEFAULT 'draft' CHECK (status IN ('draft', 'published')),
  created_at   timestamptz NOT NULL DEFAULT now(),
  updated_at   timestamptz NOT NULL DEFAULT now()
);

ALTER TABLE politicore.biographies ENABLE ROW LEVEL SECURITY;
ALTER TABLE politicore.biographies FORCE  ROW LEVEL SECURITY;

CREATE POLICY biographies_read_published ON politicore.biographies
  FOR SELECT USING (status = 'published' OR politicore.is_platform_admin()
                    OR tenant_id = politicore.current_tenant_id());
CREATE POLICY biographies_admin ON politicore.biographies
  FOR ALL USING (tenant_id = politicore.current_tenant_id() AND politicore.is_tenant_admin())
  WITH CHECK (tenant_id = politicore.current_tenant_id() AND politicore.is_tenant_admin());

CREATE TABLE politicore.galleries (
  tenant_id  uuid PRIMARY KEY REFERENCES politicore.tenants(id) ON DELETE CASCADE,
  images     jsonb NOT NULL DEFAULT '[]'::jsonb,
  status     text NOT NULL DEFAULT 'draft' CHECK (status IN ('draft', 'published')),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

ALTER TABLE politicore.galleries ENABLE ROW LEVEL SECURITY;
ALTER TABLE politicore.galleries FORCE  ROW LEVEL SECURITY;

CREATE POLICY galleries_read_published ON politicore.galleries
  FOR SELECT USING (status = 'published' OR politicore.is_platform_admin()
                    OR tenant_id = politicore.current_tenant_id());
CREATE POLICY galleries_admin ON politicore.galleries
  FOR ALL USING (tenant_id = politicore.current_tenant_id() AND politicore.is_tenant_admin())
  WITH CHECK (tenant_id = politicore.current_tenant_id() AND politicore.is_tenant_admin());

CREATE TABLE politicore.manifestos (
  tenant_id   uuid PRIMARY KEY REFERENCES politicore.tenants(id) ON DELETE CASCADE,
  title       text NOT NULL DEFAULT '',
  subtitle    text NOT NULL DEFAULT '',
  introduction text NOT NULL DEFAULT '',
  candidate_name text NOT NULL DEFAULT '',
  candidate_title text NOT NULL DEFAULT '',
  sections    jsonb NOT NULL DEFAULT '[]'::jsonb,
  closing     text NOT NULL DEFAULT '',
  call_to_action text NOT NULL DEFAULT '',
  call_to_action_link text NOT NULL DEFAULT '',
  pdf_url     text,
  status      text NOT NULL DEFAULT 'draft' CHECK (status IN ('draft', 'published')),
  created_at  timestamptz NOT NULL DEFAULT now(),
  updated_at  timestamptz NOT NULL DEFAULT now()
);

ALTER TABLE politicore.manifestos ENABLE ROW LEVEL SECURITY;
ALTER TABLE politicore.manifestos FORCE  ROW LEVEL SECURITY;

CREATE POLICY manifestos_read_published ON politicore.manifestos
  FOR SELECT USING (status = 'published' OR politicore.is_platform_admin()
                    OR tenant_id = politicore.current_tenant_id());
CREATE POLICY manifestos_admin ON politicore.manifestos
  FOR ALL USING (tenant_id = politicore.current_tenant_id() AND politicore.is_tenant_admin())
  WITH CHECK (tenant_id = politicore.current_tenant_id() AND politicore.is_tenant_admin());

-- ─────────────────────────────────────────────────────────────────────────
-- DONATIONS — PRIVATE admin-only ledger (no public collection)
-- ─────────────────────────────────────────────────────────────────────────
CREATE TABLE politicore.donations (
  id                 uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id          uuid NOT NULL REFERENCES politicore.tenants(id) ON DELETE CASCADE,
  donor_name         text NOT NULL,
  donor_phone        text,
  donor_email        text,
  donor_reference    text,
  amount             numeric(14,2) NOT NULL CHECK (amount >= 0),
  currency           text NOT NULL DEFAULT 'NGN',
  date_received      date NOT NULL,
  payment_method     text NOT NULL DEFAULT 'cash'
                     CHECK (payment_method IN ('cash','bank_transfer','pos','cheque','other')),
  category           text NOT NULL DEFAULT 'campaign_fund',
  status             text NOT NULL DEFAULT 'received'
                     CHECK (status IN ('received','pledged','cancelled')),
  external_reference text,
  notes              text,
  lga_id             text REFERENCES politicore.lgas(id),
  ward_id            text REFERENCES politicore.wards(id),
  created_by         uuid REFERENCES politicore.profiles(id),
  created_by_name    text,
  created_at         timestamptz NOT NULL DEFAULT now(),
  updated_at         timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX donations_tenant_date_idx ON politicore.donations (tenant_id, date_received);

ALTER TABLE politicore.donations ENABLE ROW LEVEL SECURITY;
ALTER TABLE politicore.donations FORCE  ROW LEVEL SECURITY;

-- Tenant-admin ONLY. Anonymous: no grant. Ordinary members: policy denies.
CREATE POLICY donations_admin ON politicore.donations
  FOR ALL USING (tenant_id = politicore.current_tenant_id() AND politicore.is_tenant_admin())
  WITH CHECK (tenant_id = politicore.current_tenant_id() AND politicore.is_tenant_admin());

CREATE TABLE politicore.donors (
  id                       uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id                uuid NOT NULL REFERENCES politicore.tenants(id) ON DELETE CASCADE,
  full_name                text NOT NULL,
  phone                    text,
  email                    text,
  reference_identifier     text,
  lga_id                   text REFERENCES politicore.lgas(id),
  ward_id                  text REFERENCES politicore.wards(id),
  total_received_amount    numeric(14,2) NOT NULL DEFAULT 0 CHECK (total_received_amount >= 0),
  contribution_count       integer NOT NULL DEFAULT 0 CHECK (contribution_count >= 0),
  latest_contribution_date date,
  created_at               timestamptz NOT NULL DEFAULT now(),
  updated_at               timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, full_name)
);

ALTER TABLE politicore.donors ENABLE ROW LEVEL SECURITY;
ALTER TABLE politicore.donors FORCE  ROW LEVEL SECURITY;

CREATE POLICY donors_admin ON politicore.donors
  FOR ALL USING (tenant_id = politicore.current_tenant_id() AND politicore.is_tenant_admin())
  WITH CHECK (tenant_id = politicore.current_tenant_id() AND politicore.is_tenant_admin());

-- Donors projection: idempotent full recomputation per tenant on any
-- ledger mutation (small ledger volumes; correctness over incrementality).
CREATE OR REPLACE FUNCTION politicore.refresh_donors()
RETURNS trigger AS $$
DECLARE
  v_tenant uuid := COALESCE(NEW.tenant_id, OLD.tenant_id);
BEGIN
  DELETE FROM politicore.donors WHERE tenant_id = v_tenant;
  INSERT INTO politicore.donors
    (tenant_id, full_name, phone, email, reference_identifier, lga_id, ward_id,
     total_received_amount, contribution_count, latest_contribution_date)
  SELECT
    d.tenant_id,
    d.donor_name,
    (array_agg(d.donor_phone ORDER BY d.created_at DESC))[1],
    (array_agg(d.donor_email ORDER BY d.created_at DESC))[1],
    (array_agg(d.donor_reference ORDER BY d.created_at DESC))[1],
    (array_agg(d.lga_id ORDER BY d.created_at DESC))[1],
    (array_agg(d.ward_id ORDER BY d.created_at DESC))[1],
    COALESCE(SUM(CASE WHEN d.status = 'received' THEN d.amount ELSE 0 END), 0),
    count(*) FILTER (WHERE d.status = 'received'),
    max(d.date_received) FILTER (WHERE d.status = 'received')
  FROM politicore.donations d
  WHERE d.tenant_id = v_tenant
  GROUP BY d.tenant_id, d.donor_name;
  RETURN NULL;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER SET search_path = politicore, pg_temp;

CREATE TRIGGER trg_donations_refresh_donors
  AFTER INSERT OR UPDATE OR DELETE ON politicore.donations
  FOR EACH ROW EXECUTE FUNCTION politicore.refresh_donors();

-- (Donation audit history intentionally has NO separate table: ledger
-- writes are audited into the canonical politicore.system_audits stream
-- by trg_audit_donations below — one audit trail, one read path.)

-- Server-side audit of every ledger write reuses the canonical 0002 audit
-- trigger: rows land in politicore.system_audits (action 'donations:insert'
-- etc., actor resolved from the JWT). One audit stream, one read path —
-- surfaced on the admin Audit Logs page; no parallel donation audit store.
CREATE TRIGGER trg_audit_donations
  AFTER INSERT OR UPDATE OR DELETE ON politicore.donations
  FOR EACH ROW EXECUTE FUNCTION politicore.audit_authority_change();

-- ---------------------------------------------------------------------
-- BASE-TABLE GRANTS (0009 conventions — REQUIRED for the
-- security_invoker views above: a view executes its policy checks with
-- the caller's role, so the caller needs grants on the underlying tables,
-- not merely on the view).
-- ---------------------------------------------------------------------
GRANT SELECT, INSERT, UPDATE, DELETE ON politicore.events              TO authenticated, service_role;
GRANT SELECT, INSERT, UPDATE, DELETE ON politicore.announcements       TO authenticated, service_role;
GRANT SELECT, INSERT, UPDATE, DELETE ON politicore.news_articles       TO authenticated, service_role;
GRANT SELECT, INSERT, UPDATE, DELETE ON politicore.contact_messages    TO authenticated, service_role;
GRANT SELECT, INSERT, UPDATE, DELETE ON politicore.biographies         TO authenticated, service_role;
GRANT SELECT, INSERT, UPDATE, DELETE ON politicore.galleries           TO authenticated, service_role;
GRANT SELECT, INSERT, UPDATE, DELETE ON politicore.manifestos          TO authenticated, service_role;
GRANT SELECT, INSERT, UPDATE, DELETE ON politicore.donations           TO authenticated, service_role;
GRANT SELECT, INSERT, UPDATE, DELETE ON politicore.donors              TO authenticated, service_role;
GRANT SELECT ON politicore.system_audits                               TO authenticated, service_role;

-- anon: reads on PUBLIC families only (published-only rows enforced by
-- the RLS predicates above); INSERT on the public contact form; nothing
-- on announcements/donations/donors/system_audits.
GRANT SELECT ON politicore.events           TO anon;
GRANT SELECT ON politicore.news_articles    TO anon;
GRANT SELECT, INSERT ON politicore.contact_messages TO anon;
GRANT SELECT ON politicore.biographies      TO anon;
GRANT SELECT ON politicore.galleries        TO anon;
GRANT SELECT ON politicore.manifestos       TO anon;

-- ─────────────────────────────────────────────────────────────────────────
-- SITE SETTINGS — the admin toggles page writes tenant rows; canonicalize
-- onto politicore.tenants.config (single tenant configuration system).
-- ─────────────────────────────────────────────────────────────────────────
ALTER TABLE politicore.tenants ADD COLUMN IF NOT EXISTS config jsonb
  NOT NULL DEFAULT '{}'::jsonb;

-- Tenants SELECT: authenticated members may read their own tenant row
-- (module gating and config need it). Management stays platform-admin.
CREATE POLICY tenants_read_authenticated ON politicore.tenants
  FOR SELECT USING (politicore.current_tenant_id() = id OR politicore.is_platform_admin());

-- ─────────────────────────────────────────────────────────────────────────
-- PUBLIC DATA-API VIEWS + GRANTS (0009 conventions; security_invoker)
-- ─────────────────────────────────────────────────────────────────────────
CREATE OR REPLACE VIEW public.events
  WITH (security_invoker = true) AS SELECT * FROM politicore.events;
CREATE OR REPLACE VIEW public.announcements
  WITH (security_invoker = true) AS SELECT * FROM politicore.announcements;
CREATE OR REPLACE VIEW public.news_articles
  WITH (security_invoker = true) AS SELECT * FROM politicore.news_articles;
CREATE OR REPLACE VIEW public.contact_messages
  WITH (security_invoker = true) AS SELECT * FROM politicore.contact_messages;
CREATE OR REPLACE VIEW public.biographies
  WITH (security_invoker = true) AS SELECT * FROM politicore.biographies;
CREATE OR REPLACE VIEW public.galleries
  WITH (security_invoker = true) AS SELECT * FROM politicore.galleries;
CREATE OR REPLACE VIEW public.manifestos
  WITH (security_invoker = true) AS SELECT * FROM politicore.manifestos;
CREATE OR REPLACE VIEW public.donations
  WITH (security_invoker = true) AS SELECT * FROM politicore.donations;
CREATE OR REPLACE VIEW public.donors
  WITH (security_invoker = true) AS SELECT * FROM politicore.donors;
CREATE OR REPLACE VIEW public.system_audit_logs
  WITH (security_invoker = true) AS SELECT * FROM politicore.system_audits;

GRANT SELECT, INSERT, UPDATE, DELETE ON public.events              TO authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON public.announcements       TO authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON public.news_articles       TO authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON public.contact_messages    TO authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON public.biographies         TO authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON public.galleries           TO authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON public.manifestos          TO authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON public.donations           TO authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON public.donors              TO authenticated;

GRANT SELECT ON public.events           TO anon, service_role;
GRANT SELECT ON public.announcements    TO anon, service_role;
GRANT SELECT ON public.news_articles    TO anon, service_role;
GRANT SELECT, INSERT ON public.contact_messages TO anon, service_role;
GRANT SELECT ON public.biographies      TO anon, service_role;
GRANT SELECT ON public.galleries        TO anon, service_role;
GRANT SELECT ON public.manifestos       TO anon, service_role;
GRANT SELECT ON public.donations        TO service_role;
GRANT SELECT ON public.donors           TO service_role;
GRANT SELECT ON public.system_audit_logs TO authenticated, service_role;
