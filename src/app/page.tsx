/**
 * POLITICORE — Public homepage (Phase 24 §31 migration).
 *
 * The hard-coded homepage composition now renders through the SINGLE
 * section engine: the tenant's PUBLISHED homepage composition
 * (public.get_published_homepage — published-only, slug-resolved), with
 * the deterministic default composition as fallback (§32: no tenant ever
 * receives a blank homepage, and no legacy-only renderer exists).
 *
 * Service-eligibility is evaluated server-side: anonymous visitors get
 * all-false module states here, so service-dependent sections (e.g. the
 * election countdown) are resolved through the engine's server loaders in
 * a follow-up authenticated pass — the safe default below keeps the
 * fallback composition's non-service sections visible to anon and lets
 * the ElectionCountdown component's own safe state handle Election.
 */
import Header from "@/components/layout/Header";
import Footer from "@/components/layout/Footer";
import { getSupabaseClient } from "@/lib/supabase/config";
import { getPublishedHomepage } from "@/lib/supabase/websiteExperience";
import {
  resolveComposition,
  loadModuleState,
  type ResolvedSection,
} from "@/lib/homepage/engine";
import { SectionRenderer } from "@/lib/homepage/render";
import { FALLBACK_HOMEPAGE } from "@/lib/homepage/default-composition";
import type { SectionInstance } from "@/lib/homepage/registry";

export const dynamic = "force-dynamic";

async function loadPublishedSections(): Promise<{
  sections: SectionInstance[];
  source: "published" | "fallback";
}> {
  try {
    const pub = await getPublishedHomepage();
    if (pub && Array.isArray(pub.sections) && pub.sections.length > 0) {
      return { sections: pub.sections as SectionInstance[], source: "published" };
    }
  } catch {
    // fall through to the deterministic default (§15 fallback safety)
  }
  return { sections: FALLBACK_HOMEPAGE.sections, source: "fallback" };
}

export default async function HomePage() {
  const { sections } = await loadPublishedSections();

  // Server-side eligibility: resolve the caller's module state through the
  // existing overview RPC. For anonymous visitors this yields all-false;
  // service-dependent sections then resolve via the engine with the safe
  // component fallbacks (the anon public homepage never gates on modules
  // it cannot see — content publication conditions still apply per
  // section). Admins previewing drafts use the builder's preview path,
  // which supplies the authenticated module state.
  let modules: Record<"social" | "campaign" | "election" | "governance", boolean> | null = null;
  try {
    const supabase = getSupabaseClient();
    modules = (await loadModuleState(supabase)).modules;
    // Anonymous/unknown sessions: treat every module as enabled for PUBLIC
    // eligibility — the section engine still enforces content publication
    // conditions, and module ROUTE/RPC gates remain authoritative (§35).
    // This keeps the public homepage's service sections visible while the
    // service's own public surfaces fail closed when disabled.
    const anyKnown = Object.values(modules).some(Boolean);
    if (!anyKnown) modules = null;
  } catch {
    modules = null;
  }

  const resolved: ResolvedSection[] = await resolveComposition(sections, modules);

  return (
    <div className="min-h-screen bg-gray-50">
      <Header />
      {resolved.map((r) => (
        <SectionRenderer key={r.section.stable_id} resolved={r} />
      ))}
      <Footer />
    </div>
  );
}
