-- POLITICORE — MIGRATION 0035: PUBLIC-SURFACE GRANT HYGIENE (PHASE 6 DISCOVERY).
--
-- Discovery: the hosted Supabase project carries ALTER DEFAULT PRIVILEGES
-- that auto-grant ALL to `anon` on every new relation in `public`. Views
-- created by migrations therefore acquire a full anon privilege set that
-- the migration contracts never declared. RLS remains the real boundary
-- (anon reads/writes fail closed on the guarded base tables), but the
-- grant surface must match the declared contracts — least privilege is
-- verifiable, drift is not.
--
-- This migration normalizes the 0033-governed public surface (and the
-- 0027-narrowed profile view) to their declared grant shapes via the
-- revoke-then-grant pattern. It is idempotent and a no-op where the
-- surface already matches. Legacy election/core views are deliberately
-- NOT touched here: their grant surfaces belong to LOCKED modules and any
-- change requires its own authorization (§3.1 discipline).
--
-- Migration discipline (§35): the identical statements were applied to
-- the hosted project ahead of the 0033 signature gate (whose clause
-- `NOT EXISTS anon grants on public.donations` correctly detected this
-- drift); this migration is the canonical, reproducible record.
-- =====================================================================

-- Private ledger (0033): authenticated + service_role ONLY — no anon.
REVOKE ALL ON public.donations FROM anon;
REVOKE ALL ON public.donors   FROM anon;

-- Canonical audit stream (0002/0033): authenticated + service_role ONLY.
REVOKE ALL ON public.system_audit_logs FROM anon;

-- Public published content (0033 declared sets).
REVOKE ALL ON public.events           FROM anon;
GRANT SELECT ON public.events         TO anon;
REVOKE ALL ON public.announcements    FROM anon;
GRANT SELECT ON public.announcements  TO anon;
REVOKE ALL ON public.news_articles    FROM anon;
GRANT SELECT ON public.news_articles  TO anon;
REVOKE ALL ON public.contact_messages FROM anon;
GRANT SELECT, INSERT ON public.contact_messages TO anon;
REVOKE ALL ON public.biographies      FROM anon;
GRANT SELECT ON public.biographies    TO anon;
REVOKE ALL ON public.galleries        FROM anon;
GRANT SELECT ON public.galleries      TO anon;
REVOKE ALL ON public.manifestos       FROM anon;
GRANT SELECT ON public.manifestos     TO anon;

-- Identity surface (0027): profiles are SELECT-only for anon.
REVOKE ALL ON public.politicore_profiles FROM anon;
GRANT SELECT ON public.politicore_profiles TO anon;

-- Governance event trail (0034): append-only at the grant layer. Hosted
-- default privileges auto-grant UPDATE/DELETE to authenticated on new
-- public relations; the 0034 contract is SELECT+INSERT only.
REVOKE ALL ON public.governance_request_events FROM anon, authenticated, service_role;
GRANT SELECT, INSERT ON public.governance_request_events TO authenticated, service_role;
