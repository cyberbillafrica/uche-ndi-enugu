-- POLITICORE — MIGRATION 0038: GOVERNANCE PUBLIC INTAKE CATEGORIES RPC.
--
-- Phase 10 implementation-phase addition to the 0037 public boundary
-- (recorded as a deliberate, documented deviation from the gate's
-- two-RPC count): the public submission form must list the tenant's
-- ACTIVE request categories to file a request (prompt §6), but
-- governance_request_categories has ZERO anon surface by design (gate §J).
--
-- The minimal boundary that satisfies both: one SECURITY DEFINER RPC
-- returning ONLY the names of active categories for a public-intake-
-- enabled tenant. No ids, no descriptions (staff-authored internal
-- text), gated by the same module + public_intake check as submission.
-- Exposed via the same thin `public` wrapper convention (0007 blanket
-- execute grant makes it anon-callable like its three siblings).

CREATE OR REPLACE FUNCTION politicore.governance_public_categories(p_tenant_slug text)
RETURNS TABLE (category text) AS $$
  SELECT c.name
    FROM politicore.tenants t
    JOIN politicore.governance_request_categories c
      ON c.tenant_id = t.id AND c.is_active
   WHERE t.slug = lower(trim(COALESCE(p_tenant_slug, '')))
     AND politicore.governance_public_intake_enabled(t.id)
   ORDER BY c.name;
$$ LANGUAGE sql STABLE SECURITY DEFINER SET search_path = politicore, pg_temp;

CREATE OR REPLACE FUNCTION public.governance_public_categories(p_tenant_slug text)
RETURNS TABLE (category text) AS $$
  SELECT * FROM politicore.governance_public_categories(p_tenant_slug);
$$ LANGUAGE sql;
