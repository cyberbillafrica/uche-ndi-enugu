"use client";

/**
 * POLITICORE — Homepage draft preview (Phase 24).
 *
 * Uses the SAME section engine + renderer as the public homepage
 * (§21: no separate preview implementation). Loads the admin-gated draft
 * composition via get_site_config_preview("homepage") and renders it with
 * the current module activation state.
 */

import { useEffect, useState } from "react";
import Link from "next/link";
import { ArrowLeft, Loader2 } from "lucide-react";

import { Button } from "@/components/ui/button";
import { getErrorMessage } from "@/lib/errors";
import { getSupabaseClient } from "@/lib/supabase/config";
import { getSiteConfigPreview } from "@/lib/supabase/websiteExperience";
import {
  loadModuleState,
  resolveComposition,
  type ResolvedSection,
} from "@/lib/homepage/engine";
import { SectionRenderer } from "@/lib/homepage/render";
import type { SectionInstance } from "@/lib/homepage/registry";

export default function HomepagePreviewPage() {
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [resolved, setResolved] = useState<ResolvedSection[]>([]);

  useEffect(() => {
    async function initialLoad() {
      try {
        const payload = await getSiteConfigPreview("homepage");
        const list =
          (payload as { sections?: SectionInstance[] } | null)?.sections ?? [];
        const supabase = getSupabaseClient();
        const { modules } = await loadModuleState(supabase);
        const resolvedList = await resolveComposition(list, modules);
        setResolved(resolvedList);
        setError(null);
      } catch (err) {
        setError(getErrorMessage(err));
      } finally {
        setLoading(false);
      }
    }
    void initialLoad();
  }, []);

  return (
    <div className="space-y-4">
      <div className="flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between">
        <div>
          <h1 className="text-xl font-bold text-gray-900">Homepage draft preview</h1>
          <p className="text-sm text-gray-600">
            Rendered by the same engine as the public homepage. Service-dependent sections honor
            current activation state.
          </p>
        </div>
        <Link href="/portal/control-center/website/homepage" passHref legacyBehavior>
          <Button variant="ghost" size="sm">
            <ArrowLeft className="h-4 w-4" aria-hidden /> Back to builder
          </Button>
        </Link>
      </div>

      {loading ? (
        <div className="flex items-center justify-center py-16 text-gray-500">
          <Loader2 className="h-5 w-5 animate-spin" aria-hidden />
          <span className="ml-2 text-sm">Resolving draft composition…</span>
        </div>
      ) : error ? (
        <p className="py-8 text-center text-sm text-red-600">{error}</p>
      ) : (
        <div className="rounded border border-dashed border-amber-400 bg-amber-50/40 p-1">
          {resolved.map((r) => (
            <SectionRenderer key={r.section.stable_id} resolved={r} />
          ))}
          {resolved.length === 0 ? (
            <p className="py-8 text-center text-sm text-gray-500">
              The draft composition is empty.
            </p>
          ) : null}
        </div>
      )}
    </div>
  );
}
