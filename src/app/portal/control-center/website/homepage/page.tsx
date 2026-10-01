"use client";

/**
 * POLITICORE — Homepage Builder (Phase 24).
 *
 * Configuration-driven homepage composition over the Phase 22/23
 * configuration primitives. The database stores declarative section
 * instances only; the typed registry (src/lib/homepage/registry.ts) owns
 * every schema, default and label. Authority stays server-side: all
 * mutations go through the revision-checked SECURITY DEFINER RPCs gated
 * on is_tenant_admin().
 */

import { useCallback, useEffect, useMemo, useState } from "react";
import { useRouter } from "next/navigation";
import {
  ArrowDown,
  ArrowLeft,
  ArrowUp,
  Copy,
  Eye,
  History,
  LayoutTemplate,
  Loader2,
  Plus,
  Power,
  RotateCcw,
  Save,
  Trash2,
} from "lucide-react";

import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { useToast } from "@/components/ui/toast";
import { getErrorMessage } from "@/lib/errors";
import {
  getSiteConfig,
  publishSiteConfig,
  rollbackSiteConfig,
  saveSiteConfigDraft,
  type SiteConfigRecord,
} from "@/lib/supabase/controlCenter";
import { getSiteConfigHistory } from "@/lib/supabase/websiteExperience";
import {
  HOMEPAGE_SECTION_TYPES,
  SECTIONS,
  isSafeHref,
  validateComposition,
  type SectionConfig,
  type SectionField,
  type SectionInstance,
  type SectionType,
} from "@/lib/homepage/registry";
import { DEFAULT_HOMEPAGE_SECTIONS } from "@/lib/homepage/default-composition";

const SERVICE_LABELS: Record<string, string> = {
  social: "Social Force",
  campaign: "Campaign",
  election: "Election",
  governance: "Governance",
};

function newStableId(type: SectionType): string {
  return `${type}-${Date.now().toString(36)}${Math.floor(Math.random() * 1296).toString(36)}`;
}

function initialSections(rec: SiteConfigRecord | null): SectionInstance[] {
  const draftSections = (rec?.draft as { sections?: SectionInstance[] } | null)?.sections;
  if (draftSections && draftSections.length >= 0 && rec?.draft) return draftSections;
  const publishedSections = (rec?.published as { sections?: SectionInstance[] } | null)?.sections;
  if (publishedSections) return publishedSections;
  return DEFAULT_HOMEPAGE_SECTIONS;
}

export default function HomepageBuilderPage() {
  const toast = useToast();
  const router = useRouter();

  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const [record, setRecord] = useState<SiteConfigRecord | null>(null);
  const [sections, setSections] = useState<SectionInstance[]>([]);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [history, setHistory] = useState<{ revision: number; published_at: string | null }[]>([]);
  const [showLibrary, setShowLibrary] = useState(false);

  const load = useCallback(async () => {
    try {
      const rec = await getSiteConfig("homepage");
      setRecord(rec);
      setSections(initialSections(rec));
      const hist = await getSiteConfigHistory("homepage");
      setHistory(hist.slice().reverse());
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
        const rec = await getSiteConfig("homepage");
        setRecord(rec);
        setSections(initialSections(rec));
        const hist = await getSiteConfigHistory("homepage");
        setHistory(hist.slice().reverse());
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
  const savedDraft = record?.draft as { sections?: SectionInstance[] } | null;
  const baseline = savedDraft
    ? savedDraft.sections ?? []
    : ((record?.published as { sections?: SectionInstance[] } | null)?.sections ??
      DEFAULT_HOMEPAGE_SECTIONS);
  const isDirty = JSON.stringify(sections) !== JSON.stringify(baseline);

  const problems = useMemo(() => validateComposition(sections), [sections]);
  const ordered = useMemo(
    () => [...sections].sort((a, b) => a.display_order - b.display_order),
    [sections]
  );
  const editing = sections.find((s) => s.stable_id === editingId) ?? null;

  function mutateSections(next: SectionInstance[]) {
    setSections(next.map((s, i) => ({ ...s, display_order: i + 1 })));
  }

  function addSection(type: SectionType) {
    const def = SECTIONS[type];
    mutateSections([
      ...sections,
      {
        stable_id: newStableId(type),
        section_type: type,
        display_order: sections.length + 1,
        enabled: true,
        config: { ...def.defaultConfig },
        service_dependency: def.serviceDependency,
      },
    ]);
    setShowLibrary(false);
  }

  function duplicate(id: string) {
    const src = sections.find((s) => s.stable_id === id);
    if (!src) return;
    const copy: SectionInstance = {
      ...structuredClone(src),
      stable_id: newStableId(src.section_type),
    };
    const idx = sections.findIndex((s) => s.stable_id === id);
    const next = [...sections];
    next.splice(idx + 1, 0, copy);
    mutateSections(next);
  }

  function remove(id: string) {
    mutateSections(sections.filter((s) => s.stable_id !== id));
    if (editingId === id) setEditingId(null);
  }

  function toggleEnabled(id: string) {
    setSections(sections.map((s) => (s.stable_id === id ? { ...s, enabled: !s.enabled } : s)));
  }

  function move(id: string, dir: -1 | 1) {
    const orderedIdx = ordered.findIndex((s) => s.stable_id === id);
    const swapIdx = orderedIdx + dir;
    if (swapIdx < 0 || swapIdx >= ordered.length) return;
    const next = [...ordered];
    [next[orderedIdx], next[swapIdx]] = [next[swapIdx], next[orderedIdx]];
    mutateSections(next);
  }

  function updateEditing(next: SectionInstance) {
    setSections(sections.map((s) => (s.stable_id === next.stable_id ? next : s)));
  }

  async function handleSaveDraft() {
    if (problems.length > 0) {
      toast.error(`Cannot save: ${problems[0]}`);
      return;
    }
    setBusy(true);
    try {
      const newRevision = await saveSiteConfigDraft("homepage", { sections }, revision);
      toast.success(`Homepage draft saved (revision ${newRevision}). Not yet public.`);
      await load();
    } catch (err) {
      toast.error(getErrorMessage(err));
    } finally {
      setBusy(false);
    }
  }

  async function handlePublish() {
    if (problems.length > 0) {
      toast.error(`Fix draft problems before publishing: ${problems[0]}`);
      return;
    }
    if (isDirty) {
      toast.error("Save the draft before publishing.");
      return;
    }
    setBusy(true);
    try {
      const result = await publishSiteConfig("homepage", revision);
      toast.success(`Homepage published — live at revision ${result.revision}.`);
      await load();
    } catch (err) {
      toast.error(getErrorMessage(err));
    } finally {
      setBusy(false);
    }
  }

  async function handleRollback(historyRevision: number) {
    setBusy(true);
    try {
      const newRevision = await rollbackSiteConfig("homepage", historyRevision);
      toast.success(
        `Revision ${historyRevision} restored as draft (revision ${newRevision}). Publish to make it live.`
      );
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
        <span className="ml-2 text-sm">Loading homepage composition…</span>
      </div>
    );
  }

  return (
    <div className="space-y-6">
      <div className="flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between">
        <div>
          <h1 className="flex items-center gap-2 text-2xl font-bold text-gray-900">
            <LayoutTemplate className="h-6 w-6 text-green-700" aria-hidden />
            Homepage Builder
          </h1>
          <p className="text-sm text-gray-600">
            Compose the public homepage from registered sections. Drafts stay private until
            published.
          </p>
        </div>
        <Button variant="ghost" size="sm" onClick={() => router.push("/portal/control-center")}>
          <ArrowLeft className="h-4 w-4" aria-hidden /> Control Center
        </Button>
      </div>

      {error ? (
        <Card>
          <CardContent className="pt-4 text-sm text-red-600">{error}</CardContent>
        </Card>
      ) : null}

      <div className="flex flex-wrap items-center gap-2">
        <span className="text-sm text-gray-500">Revision {revision}</span>
        {isDirty ? (
          <span className="rounded-full bg-amber-100 px-2 py-0.5 text-xs font-medium text-amber-800">
            unsaved changes
          </span>
        ) : null}
        <div className="ml-auto flex flex-wrap gap-2">
          <Button size="sm" onClick={() => setShowLibrary((v) => !v)}>
            <Plus className="h-4 w-4" aria-hidden /> Add section
          </Button>
          <Button size="sm" variant="outline" onClick={() => router.push("/portal/control-center/website/homepage/preview")}>
            <Eye className="h-4 w-4" aria-hidden /> Preview draft
          </Button>
          <Button size="sm" variant="outline" onClick={handleSaveDraft} disabled={busy || problems.length > 0}>
            <Save className="h-4 w-4" aria-hidden /> Save draft
          </Button>
          <Button size="sm" variant="outline" onClick={handlePublish} disabled={busy || isDirty || problems.length > 0}>
            Publish
          </Button>
        </div>
      </div>

      {problems.length > 0 ? (
        <Card className="border-amber-300">
          <CardContent className="pt-4 text-sm text-amber-800">
            <p className="font-medium">Draft problems</p>
            <ul className="mt-1 list-disc pl-5">
              {problems.slice(0, 5).map((p) => (
                <li key={p}>{p}</li>
              ))}
            </ul>
          </CardContent>
        </Card>
      ) : null}

      {showLibrary ? (
        <Card>
          <CardHeader>
            <CardTitle className="text-base">Section library</CardTitle>
          </CardHeader>
          <CardContent className="grid gap-2 sm:grid-cols-2">
            {(["content", "presentation"] as const).map((group) => (
              <div key={group}>
                <p className="mb-2 text-xs font-semibold uppercase tracking-wide text-gray-500">
                  {group === "content" ? "Content" : "Marketing / Presentation"}
                </p>
                <div className="space-y-1">
                  {HOMEPAGE_SECTION_TYPES.filter((t) => SECTIONS[t].group === group).map((t) => (
                    <button
                      key={t}
                      type="button"
                      onClick={() => addSection(t)}
                      className="w-full rounded border border-gray-200 px-3 py-2 text-left text-sm hover:border-green-600 hover:bg-green-50"
                    >
                      <span className="font-medium">{SECTIONS[t].label}</span>
                      <span className="block text-xs text-gray-500">{SECTIONS[t].description}</span>
                      {SECTIONS[t].serviceDependency ? (
                        <span className="mt-0.5 block text-xs text-gray-400">
                          Requires {SERVICE_LABELS[SECTIONS[t].serviceDependency!]}
                        </span>
                      ) : null}
                    </button>
                  ))}
                </div>
              </div>
            ))}
          </CardContent>
        </Card>
      ) : null}

      {/* Canvas */}
      <Card>
        <CardHeader>
          <CardTitle className="text-base">Composition ({ordered.length})</CardTitle>
        </CardHeader>
        <CardContent className="space-y-2">
          {ordered.length === 0 ? (
            <p className="text-sm text-gray-500">
              No sections yet — add one from the library.
            </p>
          ) : null}
          {ordered.map((s) => {
            const def = SECTIONS[s.section_type];
            const known = Boolean(def);
            return (
              <div
                key={s.stable_id}
                className={`flex flex-col gap-2 rounded border px-3 py-2 sm:flex-row sm:items-center ${
                  s.enabled ? "border-gray-200" : "border-dashed border-gray-300 bg-gray-50"
                }`}
              >
                <div className="min-w-0 flex-1">
                  <p className="truncate text-sm font-medium text-gray-900">
                    {known ? def.label : `${s.section_type} (unavailable)`}
                    {s.enabled ? null : (
                      <span className="ml-2 rounded bg-gray-200 px-1.5 py-0.5 text-xs text-gray-600">
                        disabled
                      </span>
                    )}
                  </p>
                  <p className="truncate text-xs text-gray-500">
                    {known ? def.description : "This section type is not in the current registry and is skipped on render."}
                    {s.service_dependency ? ` · needs ${SERVICE_LABELS[s.service_dependency]}` : ""}
                  </p>
                </div>
                <div className="flex shrink-0 items-center gap-1">
                  <Button variant="ghost" size="sm" aria-label="Move up" onClick={() => move(s.stable_id, -1)}>
                    <ArrowUp className="h-4 w-4" aria-hidden />
                  </Button>
                  <Button variant="ghost" size="sm" aria-label="Move down" onClick={() => move(s.stable_id, 1)}>
                    <ArrowDown className="h-4 w-4" aria-hidden />
                  </Button>
                  {known ? (
                    <>
                      <Button
                        variant="ghost"
                        size="sm"
                        aria-label={s.enabled ? "Disable" : "Enable"}
                        onClick={() => toggleEnabled(s.stable_id)}
                      >
                        <Power className={`h-4 w-4 ${s.enabled ? "text-green-700" : "text-gray-400"}`} aria-hidden />
                      </Button>
                      <Button variant="ghost" size="sm" onClick={() => setEditingId(s.stable_id)}>
                        Edit
                      </Button>
                      <Button variant="ghost" size="sm" aria-label="Duplicate" onClick={() => duplicate(s.stable_id)}>
                        <Copy className="h-4 w-4" aria-hidden />
                      </Button>
                    </>
                  ) : null}
                  <Button variant="ghost" size="sm" aria-label="Remove" onClick={() => remove(s.stable_id)}>
                    <Trash2 className="h-4 w-4 text-red-600" aria-hidden />
                  </Button>
                </div>
              </div>
            );
          })}
        </CardContent>
      </Card>

      {/* Editor */}
      {editing ? (
        <SectionEditor
          key={editing.stable_id}
          section={editing}
          onChange={updateEditing}
          onClose={() => setEditingId(null)}
        />
      ) : null}

      {/* History */}
      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2 text-base">
            <History className="h-4 w-4" aria-hidden /> Published history
          </CardTitle>
        </CardHeader>
        <CardContent>
          {history.length === 0 ? (
            <p className="text-sm text-gray-500">No previous published revisions.</p>
          ) : (
            <ul className="divide-y divide-gray-100">
              {history.map((h) => (
                <li key={h.revision} className="flex items-center justify-between py-2">
                  <span className="text-sm text-gray-700">
                    Revision {h.revision}
                    {h.published_at ? (
                      <span className="ml-2 text-xs text-gray-400">
                        {new Date(h.published_at).toLocaleString()}
                      </span>
                    ) : null}
                  </span>
                  <Button
                    variant="outline"
                    size="sm"
                    disabled={busy}
                    onClick={() => handleRollback(h.revision)}
                  >
                    <RotateCcw className="h-4 w-4" aria-hidden /> Roll back
                  </Button>
                </li>
              ))}
            </ul>
          )}
          <p className="mt-2 text-xs text-gray-400">
            Rollback restores the chosen revision as a draft; publishing it goes through the normal
            validated path. The last 10 published revisions are retained.
          </p>
        </CardContent>
      </Card>
    </div>
  );
}

/** Schema-driven editor: only registry-declared fields are editable. */
function SectionEditor({
  section,
  onChange,
  onClose,
}: {
  section: SectionInstance;
  onChange: (s: SectionInstance) => void;
  onClose: () => void;
}) {
  const toast = useToast();
  const def = SECTIONS[section.section_type];
  const [busy, setBusy] = useState(false);
  if (!def) return null;

  function setConfig(patch: Partial<SectionConfig>) {
    onChange({ ...section, config: { ...section.config, ...patch } });
  }

  async function uploadMedia(key: string) {
    const input = document.createElement("input");
    input.type = "file";
    input.accept = "image/png,image/jpeg,image/webp,image/svg+xml";
    input.onchange = async () => {
      const file = input.files?.[0];
      if (!file) return;
      setBusy(true);
      try {
        const fd = new FormData();
        fd.append("file", file);
        fd.append("purpose", "homepage_section");
        const res = await fetch("/api/branding/upload", { method: "POST", body: fd });
        const body = (await res.json().catch(() => ({}))) as { assetId?: string; error?: string };
        if (!res.ok || !body.assetId) throw new Error(body.error ?? "Upload failed");
        setConfig({ [key]: { asset_id: body.assetId } } as Partial<SectionConfig>);
        toast.success("Media uploaded — save the draft to apply it.");
      } catch (err) {
        toast.error(getErrorMessage(err));
      } finally {
        setBusy(false);
      }
    };
    input.click();
  }

  function renderField(field: SectionField) {
    const key = field.key;
    const value = section.config[key];
    switch (field.kind) {
      case "text":
        return (
          <div key={key} className="space-y-1">
            <Label htmlFor={`cfg-${key}`}>{field.label}</Label>
            {field.multiline ? (
              <textarea
                id={`cfg-${key}`}
                className="w-full rounded border border-gray-300 px-2 py-1 text-sm"
                maxLength={field.max}
                rows={3}
                value={typeof value === "string" ? value : ""}
                onChange={(e) => setConfig({ [key]: e.target.value } as Partial<SectionConfig>)}
              />
            ) : (
              <Input
                id={`cfg-${key}`}
                maxLength={field.max}
                value={typeof value === "string" ? value : ""}
                onChange={(e) => setConfig({ [key]: e.target.value } as Partial<SectionConfig>)}
              />
            )}
          </div>
        );
      case "number":
        return (
          <div key={key} className="space-y-1">
            <Label htmlFor={`cfg-${key}`}>{field.label}</Label>
            <Input
              id={`cfg-${key}`}
              type="number"
              min={field.min}
              max={field.max}
              value={typeof value === "number" ? value : ""}
              onChange={(e) =>
                setConfig({
                  [key]: e.target.value === "" ? undefined : Number(e.target.value),
                } as Partial<SectionConfig>)
              }
            />
          </div>
        );
      case "boolean":
        return (
          <label key={key} className="flex items-center gap-2 text-sm">
            <input
              type="checkbox"
              checked={value === true}
              onChange={(e) => setConfig({ [key]: e.target.checked } as Partial<SectionConfig>)}
            />
            {field.label}
          </label>
        );
      case "select":
        return (
          <div key={key} className="space-y-1">
            <Label htmlFor={`cfg-${key}`}>{field.label}</Label>
            <select
              id={`cfg-${key}`}
              className="w-full rounded border border-gray-300 px-2 py-1 text-sm"
              value={typeof value === "string" ? value : ""}
              onChange={(e) => setConfig({ [key]: e.target.value } as Partial<SectionConfig>)}
            >
              <option value="">—</option>
              {field.options.map((o) => (
                <option key={o} value={o}>
                  {o}
                </option>
              ))}
            </select>
          </div>
        );
      case "link": {
        const link = (value ?? {}) as { label?: string; href?: string };
        return (
          <div key={key} className="space-y-1">
            <Label>{field.label}</Label>
            <Input
              placeholder="Label"
              maxLength={80}
              value={link.label ?? ""}
              onChange={(e) => setConfig({ [key]: { ...link, label: e.target.value } } as Partial<SectionConfig>)}
            />
            <Input
              placeholder="/internal/path or https://…"
              value={link.href ?? ""}
              onChange={(e) => setConfig({ [key]: { ...link, href: e.target.value } } as Partial<SectionConfig>)}
            />
            {link.href && !isSafeHref(link.href) ? (
              <p className="text-xs text-red-600">Only internal paths and https:// URLs are allowed.</p>
            ) : null}
          </div>
        );
      }
      case "media": {
        const media = (value ?? null) as { asset_id?: string } | null;
        return (
          <div key={key} className="space-y-1">
            <Label>{field.label}</Label>
            {media?.asset_id ? (
              <p className="text-xs text-gray-500">Asset: {media.asset_id}</p>
            ) : (
              <p className="text-xs text-gray-400">No asset selected.</p>
            )}
            <div className="flex gap-2">
              <Button type="button" size="sm" variant="outline" disabled={busy} onClick={() => uploadMedia(key)}>
                Upload
              </Button>
              {media?.asset_id ? (
                <Button
                  type="button"
                  size="sm"
                  variant="ghost"
                  onClick={() => setConfig({ [key]: undefined } as Partial<SectionConfig>)}
                >
                  Clear
                </Button>
              ) : null}
            </div>
          </div>
        );
      }
      default:
        return null;
    }
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-base">Edit — {def.label}</CardTitle>
      </CardHeader>
      <CardContent className="space-y-4">
        <div className="grid gap-4 sm:grid-cols-2">
          {def.schema.map(renderField)}
        </div>
        <div className="flex justify-end">
          <Button size="sm" variant="outline" onClick={onClose}>
            Done
          </Button>
        </div>
      </CardContent>
    </Card>
  );
}
