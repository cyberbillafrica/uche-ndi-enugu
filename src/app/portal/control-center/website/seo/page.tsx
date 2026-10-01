"use client";

import { useCallback, useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { ArrowLeft, Globe, Loader2, RefreshCw, Save } from "lucide-react";

import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { useToast } from "@/components/ui/toast";
import { getErrorMessage } from "@/lib/errors";
import { getSiteConfig, type SiteConfigRecord } from "@/lib/supabase/controlCenter";import {
  saveSeoDraft,
  publishSeo,
  type SeoConfig,
} from "@/lib/supabase/websiteExperience";

const ROBOTS_OPTIONS: NonNullable<SeoConfig["robots"]>[] = [
  "index,follow",
  "noindex,nofollow",
  "index,nofollow",
  "noindex,follow",
];

export default function SeoPage() {
  const toast = useToast();
  const router = useRouter();

  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const [record, setRecord] = useState<SiteConfigRecord | null>(null);
  const [draft, setDraft] = useState<SeoConfig>({});

  const load = useCallback(async () => {
    try {
      const rec = await getSiteConfig("seo");
      setRecord(rec);
      setDraft((rec?.draft ?? rec?.published ?? {}) as SeoConfig);
      setError(null);
    } catch (err) {
      setError(getErrorMessage(err));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    async function initialLoad() {
      try {
        const rec = await getSiteConfig("seo");
        setRecord(rec);
        setDraft((rec?.draft ?? rec?.published ?? {}) as SeoConfig);
        setError(null);
      } catch (err) {
        setError(getErrorMessage(err));
      } finally {
        setLoading(false);
      }
    }
    void initialLoad();
  }, []);

  const revision = record?.revision ?? 0;
  const isDirty =
    JSON.stringify(draft) !== JSON.stringify(record?.draft ?? record?.published ?? {});

  async function handleSaveDraft() {
    setBusy(true);
    try {
      const newRevision = await saveSeoDraft(draft, revision);
      toast.success(`SEO draft saved (revision ${newRevision}). Not yet public.`);
      await load();
    } catch (err) {
      toast.error(getErrorMessage(err));
    } finally {
      setBusy(false);
    }
  }

  async function handlePublish() {
    setBusy(true);
    try {
      const result = await publishSeo(revision);
      toast.success(`SEO published — live at revision ${result.revision}.`);
      await load();
    } catch (err) {
      toast.error(getErrorMessage(err));
    } finally {
      setBusy(false);
    }
  }

  if (loading) {
    return (
      <div className="flex items-center justify-center py-16 text-gray-500">
        <Loader2 className="h-5 w-5 animate-spin" aria-hidden />
        <span className="ml-2 text-sm">Loading SEO configuration…</span>
      </div>
    );
  }

  return (
    <div className="space-y-6">
      <div className="flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between">
        <div>
          <h1 className="flex items-center gap-2 text-2xl font-bold text-gray-900">
            <Globe className="h-6 w-6 text-green-700" aria-hidden />
            SEO &amp; Metadata
          </h1>
          <p className="text-sm text-gray-600">
            Tenant-level website metadata. Per-page SEO and content ownership remain with the
            content modules.
          </p>
        </div>
        <div className="flex items-center gap-2">
          <Button
            variant="ghost"
            size="sm"
            onClick={() => router.push("/portal/control-center")}
          >
            <span>
              <ArrowLeft className="h-4 w-4" aria-hidden /> Control Center
            </span>
          </Button>
          <Button variant="outline" size="sm" onClick={() => void load()} disabled={busy}>
            <RefreshCw className="h-4 w-4" aria-hidden /> Refresh
          </Button>
        </div>
      </div>

      {error && (
        <Card className="border-red-200 bg-red-50">
          <CardContent className="py-4 text-sm text-red-800">{error}</CardContent>
        </Card>
      )}

      <div className="grid gap-6 lg:grid-cols-3">
        <div className="space-y-6 lg:col-span-2">
          <Card>
            <CardHeader>
              <CardTitle className="text-lg">Site metadata</CardTitle>
            </CardHeader>
            <CardContent className="space-y-4">
              <div className="space-y-1.5">
                <Label htmlFor="seo-title">Site title</Label>
                <Input
                  id="seo-title"
                  value={draft.title ?? ""}
                  onChange={(e) => setDraft((d) => ({ ...d, title: e.target.value }))}
                  maxLength={120}
                  placeholder="e.g. Uche-Ndi-Enugu 2027 | Governorship"
                />
              </div>
              <div className="space-y-1.5">
                <Label htmlFor="seo-description">Meta description</Label>
                <textarea
                  id="seo-description"
                  value={draft.description ?? ""}
                  onChange={(e) => setDraft((d) => ({ ...d, description: e.target.value }))}
                  maxLength={300}
                  rows={3}
                  className="w-full rounded-md border border-gray-300 bg-white px-3 py-2 text-sm"
                  placeholder="Shown in search results and link previews"
                />
                <p className="text-[11px] text-gray-500">
                  {(draft.description ?? "").length}/300
                </p>
              </div>
              <div className="space-y-1.5">
                <Label htmlFor="seo-keywords">Keywords (comma-separated, max 20)</Label>
                <Input
                  id="seo-keywords"
                  value={(draft.keywords ?? []).join(", ")}
                  onChange={(e) =>
                    setDraft((d) => ({
                      ...d,
                      keywords: e.target.value
                        .split(",")
                        .map((k) => k.trim())
                        .filter(Boolean)
                        .slice(0, 20),
                    }))
                  }
                  placeholder="governorship, enugu, 2027"
                />
              </div>
              <div className="space-y-1.5">
                <Label htmlFor="seo-canonical">Canonical URL</Label>
                <Input
                  id="seo-canonical"
                  value={draft.canonical_url ?? ""}
                  onChange={(e) => setDraft((d) => ({ ...d, canonical_url: e.target.value }))}
                  placeholder="https://example.com"
                />
              </div>
              <div className="space-y-1.5">
                <Label htmlFor="seo-robots">Robots directive</Label>
                <select
                  id="seo-robots"
                  value={draft.robots ?? "index,follow"}
                  onChange={(e) =>
                    setDraft((d) => ({
                      ...d,
                      robots: e.target.value as SeoConfig["robots"],
                    }))
                  }
                  className="w-full rounded-md border border-gray-300 bg-white px-3 py-2 text-sm"
                >
                  {ROBOTS_OPTIONS.map((r) => (
                    <option key={r} value={r}>{r}</option>
                  ))}
                </select>
              </div>
            </CardContent>
          </Card>

          <Card>
            <CardHeader>
              <CardTitle className="text-lg">Social sharing (Open Graph)</CardTitle>
            </CardHeader>
            <CardContent className="space-y-4">
              <div className="space-y-1.5">
                <Label htmlFor="og-title">OG title</Label>
                <Input
                  id="og-title"
                  value={draft.og_title ?? ""}
                  onChange={(e) => setDraft((d) => ({ ...d, og_title: e.target.value }))}
                  maxLength={120}
                  placeholder="Defaults to the site title when empty"
                />
              </div>
              <div className="space-y-1.5">
                <Label htmlFor="og-description">OG description</Label>
                <textarea
                  id="og-description"
                  value={draft.og_description ?? ""}
                  onChange={(e) => setDraft((d) => ({ ...d, og_description: e.target.value }))}
                  maxLength={300}
                  rows={2}
                  className="w-full rounded-md border border-gray-300 bg-white px-3 py-2 text-sm"
                  placeholder="Defaults to the meta description when empty"
                />
              </div>
            </CardContent>
          </Card>
        </div>

        <div className="space-y-6">
          <Card>
            <CardHeader>
              <CardTitle className="text-lg">Search preview</CardTitle>
            </CardHeader>
            <CardContent>
              <div className="rounded-lg border border-gray-200 p-3">
                <p className="text-sm font-medium text-blue-800">
                  {draft.title || "Your site title"}
                </p>
                <p className="text-xs text-green-700">https://your-site.example</p>
                <p className="mt-1 text-xs text-gray-600">
                  {draft.description || "Your meta description appears here."}
                </p>
              </div>
            </CardContent>
          </Card>

          <Card>
            <CardHeader>
              <CardTitle className="text-lg">Draft &amp; publish</CardTitle>
              <p className="text-sm text-gray-600">
                Saving a draft never changes the public site. Publishing promotes the draft.
              </p>
            </CardHeader>
            <CardContent className="space-y-3">
              <p className="text-xs text-gray-500">
                Current revision: <span className="font-mono">{revision}</span>
                {record?.published_at && (
                  <> · published {new Date(record.published_at).toLocaleString()}</>
                )}
              </p>
              {isDirty && (
                <p className="rounded-md bg-amber-50 p-2 text-xs text-amber-800">
                  Unsaved changes — save a draft before publishing.
                </p>
              )}
              <div className="flex flex-wrap gap-2">
                <Button size="sm" onClick={() => void handleSaveDraft()} disabled={busy || !isDirty}>
                  {busy ? <Loader2 className="h-4 w-4 animate-spin" aria-hidden /> : <Save className="h-4 w-4" aria-hidden />}
                  Save draft
                </Button>
                <Button
                  size="sm"
                  variant="outline"
                  onClick={() => void handlePublish()}
                  disabled={busy || isDirty}
                >
                  Publish
                </Button>
              </div>
              <p className="text-[11px] text-gray-500">
                A revision conflict means another administrator saved first — refresh, re-apply your
                changes and save again. Nothing is silently overwritten.
              </p>
            </CardContent>
          </Card>
        </div>
      </div>
    </div>
  );
}
