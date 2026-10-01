"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { useRouter } from "next/navigation";
import { ArrowLeft, Loader2, Palette, RefreshCw, Save, Upload } from "lucide-react";

import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { useToast } from "@/components/ui/toast";
import { getErrorMessage } from "@/lib/errors";
import {
  BRAND_PRESETS,
  DEFAULT_BRAND_TOKENS,
  SUPPORTED_RADII,
  SUPPORTED_TYPOGRAPHY,
  resolveBrandTokens,
  brandTokenStyle,
  type BrandPresetId,
  type BrandTokens,
  type BrandingConfig,
  type RadiusPreference,
  type TypographyPreference,
} from "@/lib/branding/presets";
import { getSiteConfig, type SiteConfigRecord } from "@/lib/supabase/controlCenter";
import {
  saveBrandingDraft,
  publishBranding,
} from "@/lib/supabase/websiteExperience";

const TOKEN_LABELS: Record<keyof BrandTokens, string> = {
  primary: "Primary",
  secondary: "Secondary",
  accent: "Accent",
  surface: "Surface",
  background: "Background",
  text: "Text",
  muted: "Muted",
  border: "Border",
};

type PresetChoice = BrandPresetId;

export default function BrandingThemePage() {
  const toast = useToast();
  const router = useRouter();

  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const [record, setRecord] = useState<SiteConfigRecord | null>(null);
  const [draft, setDraft] = useState<BrandingConfig>({});
  const [publishedTokens, setPublishedTokens] = useState(resolveBrandTokens(null));

  const load = useCallback(async () => {
    try {
      const rec = await getSiteConfig("branding");
      setRecord(rec);
      const current = (rec?.draft ?? rec?.published ?? {}) as BrandingConfig;
      setDraft(current);
      setPublishedTokens(resolveBrandTokens((rec?.published ?? {}) as BrandingConfig));
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
        const rec = await getSiteConfig("branding");
        setRecord(rec);
        setDraft((rec?.draft ?? rec?.published ?? {}) as BrandingConfig);
        setPublishedTokens(resolveBrandTokens((rec?.published ?? {}) as BrandingConfig));
        setError(null);
      } catch (err) {
        setError(getErrorMessage(err));
      } finally {
        setLoading(false);
      }
    }
    void initialLoad();
  }, []);

  const presetChoice: PresetChoice = draft.preset ?? "apc";

  /** Effective bundle shown live in the editor (preset + custom overlay). */
  const previewTokens = useMemo(() => {
    if (presetChoice === "custom") {
      return resolveBrandTokens({ tokens: draft.tokens });
    }
    return resolveBrandTokens({ preset: presetChoice });
  }, [presetChoice, draft.tokens]);

  async function setPreset(next: PresetChoice) {
    if (next === "custom") {
      // Seed the custom overlay from the currently effective bundle.
      const seeded = previewTokens;
      setDraft((d) => ({ ...d, preset: "custom", tokens: { ...seeded } }));
    } else {
      setDraft((d) => {
        const { tokens: _drop, ...rest } = d;
        void _drop;
        return { ...rest, preset: next };
      });
    }
  }

  function setToken(key: keyof BrandTokens, value: string) {
    setDraft((d) => ({
      ...d,
      preset: "custom",
      tokens: { ...(d.tokens ?? { ...previewTokens }), [key]: value },
    }));
  }

  const revision = record?.revision ?? 0;
  const isDirty =
    JSON.stringify(draft) !== JSON.stringify(record?.draft ?? record?.published ?? {});

  async function handleSaveDraft() {
    setBusy(true);
    try {
      const newRevision = await saveBrandingDraft(draft, revision);
      toast.success(`Branding draft saved (revision ${newRevision}). Not yet public.`);
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
      const result = await publishBranding(revision);
      toast.success(`Branding published — live at revision ${result.revision}.`);
      await load();
    } catch (err) {
      toast.error(getErrorMessage(err));
    } finally {
      setBusy(false);
    }
  }

  async function handleUpload(kind: "logo" | "favicon") {
    const input = document.createElement("input");
    input.type = "file";
    input.accept = "image/png,image/jpeg,image/webp,image/svg+xml,image/x-icon";
    input.onchange = async () => {
      const file = input.files?.[0];
      if (!file) return;
      setBusy(true);
      try {
        const fd = new FormData();
        fd.append("file", file);
        fd.append("purpose", `branding_${kind}`);
        const res = await fetch("/api/branding/upload", { method: "POST", body: fd });
        const body = (await res.json().catch(() => ({}))) as { assetId?: string; error?: string };
        if (!res.ok || !body.assetId) {
          throw new Error(body.error ?? "Upload failed");
        }
        setDraft((d) =>
          kind === "logo" ? { ...d, logo: { asset_id: body.assetId! } } : { ...d, favicon: { asset_id: body.assetId! } }
        );
        toast.success(`${kind === "logo" ? "Logo" : "Favicon"} uploaded — save the draft to apply it.`);
      } catch (err) {
        toast.error(getErrorMessage(err));
      } finally {
        setBusy(false);
      }
    };
    input.click();
  }

  if (loading) {
    return (
      <div className="flex items-center justify-center py-16 text-gray-500">
        <Loader2 className="h-5 w-5 animate-spin" aria-hidden />
        <span className="ml-2 text-sm">Loading branding configuration…</span>
      </div>
    );
  }

  return (
    <div className="space-y-6">
      <div className="flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between">
        <div>
          <h1 className="flex items-center gap-2 text-2xl font-bold text-gray-900">
            <Palette className="h-6 w-6 text-green-700" aria-hidden />
            Branding &amp; Theme
          </h1>
          <p className="text-sm text-gray-600">
            Visual design tokens for the public site. Presets are token bundles — they change no
            platform behavior.
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
        {/* ── Editor column ─────────────────────────────────────────── */}
        <div className="space-y-6 lg:col-span-2">
          <Card>
            <CardHeader>
              <CardTitle className="text-lg">Theme preset</CardTitle>
              <p className="text-sm text-gray-600">
                Selecting a preset applies its visual token bundle. No authorization, routing or
                module behavior is affected.
              </p>
            </CardHeader>
            <CardContent className="space-y-3">
              <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
                {(["apc", "pdp", "ndc", "custom"] as PresetChoice[]).map((id) => {
                  const tokens =
                    id === "custom" ? DEFAULT_BRAND_TOKENS : BRAND_PRESETS[id].tokens;
                  const selected = presetChoice === id;
                  return (
                    <button
                      key={id}
                      type="button"
                      onClick={() => void setPreset(id)}
                      className={`rounded-lg border-2 p-3 text-left transition ${
                        selected
                          ? "border-green-600 bg-green-50 shadow-sm"
                          : "border-gray-200 hover:border-gray-300"
                      }`}
                    >
                      <div className="mb-2 flex gap-1">
                        {(["primary", "secondary", "accent"] as const).map((k) => (
                          <span
                            key={k}
                            className="h-5 w-5 rounded-full border border-black/10"
                            style={{ backgroundColor: tokens[k] }}
                            title={`${k}: ${tokens[k]}`}
                          />
                        ))}
                      </div>
                      <span className="text-xs font-semibold uppercase tracking-wide text-gray-700">
                        {id}
                      </span>
                    </button>
                  );
                })}
              </div>

              {presetChoice === "custom" && (
                <div className="space-y-2 rounded-lg border border-gray-200 p-3">
                  <p className="text-xs font-medium text-gray-700">
                    Custom tokens (controlled values only — unknown keys and non-color values are
                    rejected server-side)
                  </p>
                  <div className="grid gap-2 sm:grid-cols-2">
                    {(Object.keys(TOKEN_LABELS) as (keyof BrandTokens)[]).map((key) => (
                      <label key={key} className="flex items-center gap-2 text-xs text-gray-700">
                        <span className="w-20 shrink-0">{TOKEN_LABELS[key]}</span>
                        <input
                          type="color"
                          value={/^#[0-9a-fA-F]{6}$/.test(previewTokens[key]) ? previewTokens[key] : "#000000"}
                          onChange={(e) => setToken(key, e.target.value)}
                          className="h-7 w-10 cursor-pointer rounded border border-gray-300"
                          aria-label={`${TOKEN_LABELS[key]} color`}
                        />
                        <code className="text-[10px] text-gray-500">{previewTokens[key]}</code>
                      </label>
                    ))}
                  </div>
                </div>
              )}
            </CardContent>
          </Card>

          <Card>
            <CardHeader>
              <CardTitle className="text-lg">Site identity</CardTitle>
            </CardHeader>
            <CardContent className="space-y-4">
              <div className="space-y-1.5">
                <Label htmlFor="site-name">Site name</Label>
                <Input
                  id="site-name"
                  value={draft.site_name ?? ""}
                  onChange={(e) => setDraft((d) => ({ ...d, site_name: e.target.value }))}
                  placeholder="e.g. Uche-Ndi-Enugu 2027"
                  maxLength={120}
                />
              </div>

              <div className="grid gap-4 sm:grid-cols-2">
                <div className="space-y-1.5">
                  <Label htmlFor="typo-heading">Heading typography</Label>
                  <select
                    id="typo-heading"
                    value={draft.typography?.heading ?? "sans"}
                    onChange={(e) =>
                      setDraft((d) => ({
                        ...d,
                        typography: {
                          ...(d.typography ?? {}),
                          heading: e.target.value as TypographyPreference,
                        },
                      }))
                    }
                    className="w-full rounded-md border border-gray-300 bg-white px-3 py-2 text-sm"
                  >
                    {SUPPORTED_TYPOGRAPHY.map((t) => (
                      <option key={t} value={t}>{t}</option>
                    ))}
                  </select>
                </div>
                <div className="space-y-1.5">
                  <Label htmlFor="typo-body">Body typography</Label>
                  <select
                    id="typo-body"
                    value={draft.typography?.body ?? "sans"}
                    onChange={(e) =>
                      setDraft((d) => ({
                        ...d,
                        typography: {
                          ...(d.typography ?? {}),
                          body: e.target.value as TypographyPreference,
                        },
                      }))
                    }
                    className="w-full rounded-md border border-gray-300 bg-white px-3 py-2 text-sm"
                  >
                    {SUPPORTED_TYPOGRAPHY.map((t) => (
                      <option key={t} value={t}>{t}</option>
                    ))}
                  </select>
                </div>
              </div>

              <div className="space-y-1.5">
                <Label htmlFor="radius">Corner radius</Label>
                <select
                  id="radius"
                  value={draft.radius ?? "lg"}
                  onChange={(e) =>
                    setDraft((d) => ({ ...d, radius: e.target.value as RadiusPreference }))
                  }
                  className="w-full rounded-md border border-gray-300 bg-white px-3 py-2 text-sm"
                >
                  {SUPPORTED_RADII.map((r) => (
                    <option key={r} value={r}>{r}</option>
                  ))}
                </select>
              </div>

              <div className="grid gap-4 sm:grid-cols-2">
                <div className="space-y-1.5">
                  <Label>Logo (public media asset)</Label>
                  <div className="flex items-center gap-2">
                    <Button
                      type="button"
                      variant="outline"
                      size="sm"
                      onClick={() => void handleUpload("logo")}
                      disabled={busy}
                    >
                      <Upload className="h-4 w-4" aria-hidden /> Upload logo
                    </Button>
                    {draft.logo && (
                      <span className="text-xs text-gray-500" title={draft.logo.asset_id}>
                        asset selected
                      </span>
                    )}
                  </div>
                </div>
                <div className="space-y-1.5">
                  <Label>Favicon (public media asset)</Label>
                  <div className="flex items-center gap-2">
                    <Button
                      type="button"
                      variant="outline"
                      size="sm"
                      onClick={() => void handleUpload("favicon")}
                      disabled={busy}
                    >
                      <Upload className="h-4 w-4" aria-hidden /> Upload favicon
                    </Button>
                    {draft.favicon && (
                      <span className="text-xs text-gray-500" title={draft.favicon.asset_id}>
                        asset selected
                      </span>
                    )}
                  </div>
                </div>
              </div>
            </CardContent>
          </Card>
        </div>

        {/* ── Preview + publish column ─────────────────────────────── */}
        <div className="space-y-6">
          <Card>
            <CardHeader>
              <CardTitle className="text-lg">Live preview</CardTitle>
              <p className="text-sm text-gray-600">Rendered from your current editor state.</p>
            </CardHeader>
            <CardContent className="space-y-3">
              <div
                className="rounded-xl border p-4"
                style={brandTokenStyle(previewTokens)}
              >
                <div
                  className="rounded-lg p-4"
                  style={{ backgroundColor: "var(--cc-primary)" }}
                >
                  <p className="text-sm font-bold text-white">
                    {draft.site_name || "Your site name"}
                  </p>
                </div>
                <div
                  className="mt-3 rounded-lg border p-3"
                  style={{
                    backgroundColor: "var(--cc-surface)",
                    borderColor: "var(--cc-border)",
                  }}
                >
                  <p style={{ color: "var(--cc-text)" }} className="text-sm font-semibold">
                    Card heading
                  </p>
                  <p style={{ color: "var(--cc-muted)" }} className="text-xs">
                    Body text on your surface color.
                  </p>
                  <span
                    className="mt-2 inline-block rounded px-2 py-1 text-[10px] font-bold text-white"
                    style={{ backgroundColor: "var(--cc-secondary)" }}
                  >
                    Accent button
                  </span>
                </div>
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

          <Card>
            <CardHeader>
              <CardTitle className="text-lg">Currently published</CardTitle>
            </CardHeader>
            <CardContent>
              <div className="rounded-xl border p-4" style={brandTokenStyle(publishedTokens)}>
                <div className="flex gap-1.5">
                  {Object.values(publishedTokens).map((c, i) => (
                    <span
                      key={i}
                      className="h-6 w-6 rounded-full border border-black/10"
                      style={{ backgroundColor: c }}
                    />
                  ))}
                </div>
                <p className="mt-2 text-xs text-gray-500">
                  {publishedTokens.primary} · this is what anonymous visitors see.
                </p>
              </div>
            </CardContent>
          </Card>
        </div>
      </div>
    </div>
  );
}
