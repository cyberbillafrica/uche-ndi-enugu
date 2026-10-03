"use client";

/**
 * POLITICORE — Control Center: Footer editor (Phase 25).
 *
 * Typed editor over the validated `footer` configuration area. Column/link
 * management stays within the bounded contract (≤ 4 columns × ≤ 8 links);
 * contact and social DATA are canonical elsewhere — this editor controls
 * placement/presentation only (prompt §11/§24). Publish promotes through
 * migration 0063's server-side validators with optimistic revision
 * concurrency; preview renders the SAME production Footer component.
 */

import { useState } from "react";
import Link from "next/link";
import {
  ArrowLeft,
  ChevronDown,
  ChevronUp,
  History,
  Loader2,
  Plus,
  RefreshCw,
  Save,
  Trash2,
} from "lucide-react";

import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { useToast } from "@/components/ui/toast";
import Footer from "@/components/layout/Footer";
import { PublicChromeProvider } from "@/components/layout/PublicChromeProvider";
import type { PublicSiteChrome } from "@/lib/supabase/websiteExperience";
import {
  DEFAULT_FOOTER_CONFIG,
  FOOTER_LAYOUTS,
  isValidFooterConfig,
  type ChromeLink,
  type FooterColumn,
  type FooterConfig,
} from "@/lib/chrome/types";
import { useChromeArea } from "@/lib/chrome/useChromeArea";

function isExternalHref(href: string): boolean {
  return /^https?:\/\//i.test(href.trim());
}

function emptyColumn(): FooterColumn {
  return { id: `col-${Date.now().toString(36)}`, heading: "New column", links: [] };
}

function emptyLink(): ChromeLink {
  return { label: "New link", href: "/" };
}

export default function FooterBuilderPage() {
  const toast = useToast();
  const [showPreview, setShowPreview] = useState(false);
  const [showHistory, setShowHistory] = useState(false);

  const chrome = useChromeArea<FooterConfig>(
    "footer",
    DEFAULT_FOOTER_CONFIG,
    (d) => (isValidFooterConfig(d) ? null : "Configuration is invalid — check the highlighted fields.")
  );

  const columns = Array.isArray(chrome.draft.columns) ? chrome.draft.columns : [];
  const legal = chrome.draft.legal ?? {};
  const presentation = chrome.draft.presentation ?? {};

  function setColumns(next: FooterColumn[]) {
    chrome.setDraft((d) => ({ ...d, columns: next }));
  }

  function updateColumn(idx: number, patch: Partial<FooterColumn>) {
    setColumns(columns.map((c, i) => (i === idx ? { ...c, ...patch } : c)));
  }

  function moveColumn(idx: number, dir: -1 | 1) {
    const j = idx + dir;
    if (j < 0 || j >= columns.length) return;
    const next = [...columns];
    [next[idx], next[j]] = [next[j], next[idx]];
    setColumns(next);
  }

  const previewChrome: PublicSiteChrome = {
    branding: {},
    seo: {},
    navigation: {},
    footer: chrome.draft,
    contact: {},
    social_links: {},
  };

  const notify = (m: string) => toast.success(m);
  const fail = (m: string) => toast.error(m);

  if (chrome.loading) {
    return (
      <div className="flex items-center justify-center py-16 text-gray-500">
        <Loader2 className="h-5 w-5 animate-spin" aria-hidden />
        <span className="ml-2 text-sm">Loading footer configuration…</span>
      </div>
    );
  }

  return (
    <div className="space-y-6">
      <div className="flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between">
        <div>
          <h1 className="text-2xl font-bold text-gray-900">Footer</h1>
          <p className="text-sm text-gray-600">
            Columns, legal and presentation. Contact and social data stay canonical — this controls
            placement only.
          </p>
        </div>
        <div className="flex items-center gap-2">
          <Link
            href="/portal/control-center"
            className="flex items-center gap-1.5 text-sm font-medium text-gray-500 hover:text-gray-800"
          >
            <ArrowLeft className="h-4 w-4" aria-hidden /> Control Center
          </Link>
        </div>
      </div>

      {chrome.error && (
        <div className="rounded-lg border border-red-200 bg-red-50 p-3 text-sm text-red-700">{chrome.error}</div>
      )}

      {/* Columns */}
      <Card>
        <CardHeader className="flex flex-row items-center justify-between">
          <CardTitle className="text-base">Columns (max 4)</CardTitle>
          <Button
            size="sm"
            variant="outline"
            disabled={columns.length >= 4}
            onClick={() => setColumns([...columns, emptyColumn()])}
          >
            <Plus className="mr-1 h-4 w-4" aria-hidden /> Add column
          </Button>
        </CardHeader>
        <CardContent className="space-y-4">
          {columns.length === 0 && <p className="text-sm text-gray-500">No columns configured.</p>}

          {columns.map((col, idx) => (
            <div key={col.id} className="rounded-xl border border-gray-200 p-4">
              <div className="flex items-center justify-between gap-2">
                <span className="text-xs font-semibold uppercase tracking-wider text-gray-400">{col.id}</span>
                <div className="flex items-center gap-1">
                  <Button size="icon" variant="ghost" aria-label="Move up" disabled={idx === 0} onClick={() => moveColumn(idx, -1)}>
                    <ChevronUp className="h-4 w-4" />
                  </Button>
                  <Button
                    size="icon"
                    variant="ghost"
                    aria-label="Move down"
                    disabled={idx === columns.length - 1}
                    onClick={() => moveColumn(idx, 1)}
                  >
                    <ChevronDown className="h-4 w-4" />
                  </Button>
                  <Button
                    size="icon"
                    variant="ghost"
                    aria-label={`Delete ${col.heading}`}
                    onClick={() => setColumns(columns.filter((_, i) => i !== idx))}
                  >
                    <Trash2 className="h-4 w-4 text-red-500" />
                  </Button>
                </div>
              </div>

              <div className="mt-3 flex items-end gap-3">
                <div className="flex-1">
                  <Label htmlFor={`col-h-${col.id}`}>Heading</Label>
                  <Input
                    id={`col-h-${col.id}`}
                    className="mt-1"
                    maxLength={60}
                    value={col.heading}
                    onChange={(e) => updateColumn(idx, { heading: e.target.value })}
                  />
                </div>
              </div>

              {/* Links */}
              <div className="mt-4 space-y-2">
                <div className="flex items-center justify-between">
                  <Label className="text-xs text-gray-500">Links (max 8)</Label>
                  <Button
                    size="sm"
                    variant="ghost"
                    disabled={(col.links?.length ?? 0) >= 8}
                    onClick={() => updateColumn(idx, { links: [...(col.links ?? []), emptyLink()] })}
                  >
                    <Plus className="mr-1 h-3.5 w-3.5" aria-hidden /> Add link
                  </Button>
                </div>
                {(col.links ?? []).map((link, li) => {
                  const external = isExternalHref(link.href);
                  return (
                    <div key={li} className="flex flex-wrap items-end gap-2 rounded-lg bg-gray-50 p-2">
                      <div className="min-w-[140px] flex-1">
                        <Label htmlFor={`l-lab-${col.id}-${li}`} className="text-xs">
                          Label
                        </Label>
                        <Input
                          id={`l-lab-${col.id}-${li}`}
                          className="mt-1"
                          maxLength={120}
                          value={link.label}
                          onChange={(e) =>
                            updateColumn(idx, {
                              links: (col.links ?? []).map((l, i) =>
                                i === li ? { ...l, label: e.target.value } : l
                              ),
                            })
                          }
                        />
                      </div>
                      <div className="min-w-[180px] flex-[2]">
                        <Label htmlFor={`l-href-${col.id}-${li}`} className="text-xs">
                          Destination
                        </Label>
                        <Input
                          id={`l-href-${col.id}-${li}`}
                          className="mt-1"
                          maxLength={2000}
                          placeholder="/news · #about · https://…"
                          value={link.href}
                          onChange={(e) =>
                            updateColumn(idx, {
                              links: (col.links ?? []).map((l, i) =>
                                i === li ? { ...l, href: e.target.value } : l
                              ),
                            })
                          }
                        />
                      </div>
                      {external && (
                        <div className="flex items-center gap-2 pb-1 text-xs text-gray-500">
                          <input
                            id={`l-rel-${col.id}-${li}`}
                            type="checkbox"
                            className="h-4 w-4 rounded border-gray-300"
                            checked={link.rel === "noopener noreferrer"}
                            onChange={(e) =>
                              updateColumn(idx, {
                                links: (col.links ?? []).map((l, i) =>
                                  i === li
                                    ? { ...l, rel: e.target.checked ? ("noopener noreferrer" as const) : undefined }
                                    : l
                                ),
                              })
                            }
                          />
                          <Label htmlFor={`l-rel-${col.id}-${li}`} className="text-xs">
                            open safely (rel)
                          </Label>
                        </div>
                      )}
                      <Button
                        size="icon"
                        variant="ghost"
                        aria-label="Remove link"
                        onClick={() =>
                          updateColumn(idx, { links: (col.links ?? []).filter((_, i) => i !== li) })
                        }
                      >
                        <Trash2 className="h-4 w-4 text-red-500" />
                      </Button>
                    </div>
                  );
                })}
              </div>
            </div>
          ))}
        </CardContent>
      </Card>

      {/* Legal + presentation */}
      <Card>
        <CardHeader>
          <CardTitle className="text-base">Legal &amp; presentation</CardTitle>
        </CardHeader>
        <CardContent className="grid gap-4 sm:grid-cols-2">
          <div className="sm:col-span-2">
            <Label htmlFor="legal-copy">Copyright line (&#123;year&#125; is substituted)</Label>
            <Input
              id="legal-copy"
              className="mt-1"
              maxLength={160}
              value={legal.copyright ?? ""}
              onChange={(e) => chrome.setDraft((d) => ({ ...d, legal: { ...d.legal, copyright: e.target.value } }))}
            />
          </div>
          <div>
            <Label htmlFor="f-layout">Layout</Label>
            <Select
              value={presentation.layout ?? "columns-4"}
              onValueChange={(v) =>
                chrome.setDraft((d) => ({ ...d, presentation: { ...d.presentation, layout: v as never } }))
              }
            >
              <SelectTrigger id="f-layout" className="mt-1">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {FOOTER_LAYOUTS.map((l) => (
                  <SelectItem key={l} value={l}>
                    {l}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
          <div className="flex flex-col gap-2 pt-6">
            {(
              [
                ["show_contact", "Show contact block"],
                ["show_cta", "Show call-to-action banner"],
              ] as const
            ).map(([key, label]) => (
              <div key={key} className="flex items-center gap-2">
                <input
                  id={`f-${key}`}
                  type="checkbox"
                  className="h-4 w-4 rounded border-gray-300"
                  checked={presentation[key] !== false}
                  onChange={(e) =>
                    chrome.setDraft((d) => ({
                      ...d,
                      presentation: { ...d.presentation, [key]: e.target.checked },
                    }))
                  }
                />
                <Label htmlFor={`f-${key}`}>{label}</Label>
              </div>
            ))}
            <div className="flex items-center gap-2">
              <input
                id="f-social"
                type="checkbox"
                className="h-4 w-4 rounded border-gray-300"
                checked={chrome.draft.social?.show !== false}
                onChange={(e) => chrome.setDraft((d) => ({ ...d, social: { show: e.target.checked } }))}
              />
              <Label htmlFor="f-social">Show social links (canonical URLs)</Label>
            </div>
          </div>
          {presentation.show_cta !== false && (
            <>
              <div className="sm:col-span-2">
                <Label htmlFor="f-cta-head">CTA banner heading</Label>
                <Input
                  id="f-cta-head"
                  className="mt-1"
                  maxLength={120}
                  value={presentation.cta_heading ?? ""}
                  onChange={(e) =>
                    chrome.setDraft((d) => ({
                      ...d,
                      presentation: { ...d.presentation, cta_heading: e.target.value },
                    }))
                  }
                />
              </div>
              <div>
                <Label htmlFor="f-cta-label">CTA label</Label>
                <Input
                  id="f-cta-label"
                  className="mt-1"
                  maxLength={60}
                  value={presentation.cta_label ?? ""}
                  onChange={(e) =>
                    chrome.setDraft((d) => ({
                      ...d,
                      presentation: { ...d.presentation, cta_label: e.target.value },
                    }))
                  }
                />
              </div>
              <div>
                <Label htmlFor="f-cta-href">CTA destination</Label>
                <Input
                  id="f-cta-href"
                  className="mt-1"
                  maxLength={2000}
                  value={presentation.cta_href ?? ""}
                  onChange={(e) =>
                    chrome.setDraft((d) => ({
                      ...d,
                      presentation: { ...d.presentation, cta_href: e.target.value },
                    }))
                  }
                />
              </div>
            </>
          )}
        </CardContent>
      </Card>

      {/* Lifecycle */}
      <Card>
        <CardContent className="flex flex-wrap items-center gap-3 pt-6">
          <Button disabled={chrome.busy} onClick={() => chrome.saveDraft(notify, fail)}>
            {chrome.busy ? <Loader2 className="mr-2 h-4 w-4 animate-spin" aria-hidden /> : <Save className="mr-2 h-4 w-4" aria-hidden />}
            Save draft
          </Button>
          <Button variant="default" disabled={chrome.busy || !chrome.isDirty} onClick={() => chrome.publish(notify, fail)}>
            Publish
          </Button>
          <Button variant="ghost" disabled={chrome.busy} onClick={() => void chrome.reload()}>
            <RefreshCw className="mr-2 h-4 w-4" aria-hidden /> Reload
          </Button>
          <Button variant="outline" onClick={() => setShowPreview((s) => !s)}>
            {showPreview ? "Hide preview" : "Preview draft"}
          </Button>
          <Button variant="outline" onClick={() => setShowHistory((s) => !s)}>
            <History className="mr-2 h-4 w-4" aria-hidden /> History &amp; rollback
          </Button>
          <span className="ml-auto text-xs text-gray-500">
            revision {chrome.revision}
            {chrome.isDirty ? " · unsaved changes" : ""}
            {chrome.validationError ? " · invalid configuration" : ""}
          </span>
        </CardContent>
      </Card>

      {chrome.validationError && <p className="text-sm text-amber-700">{chrome.validationError}</p>}

      {showPreview && (
        <Card>
          <CardHeader>
            <CardTitle className="text-base">Draft preview (not public)</CardTitle>
          </CardHeader>
          <CardContent className="overflow-hidden rounded-xl border border-gray-200">
            <PublicChromeProvider chrome={previewChrome}>
              <Footer />
            </PublicChromeProvider>
          </CardContent>
        </Card>
      )}

      {showHistory && (
        <Card>
          <CardHeader>
            <CardTitle className="text-base">Published history (bounded to 10)</CardTitle>
          </CardHeader>
          <CardContent>
            {chrome.history.length === 0 ? (
              <p className="text-sm text-gray-500">No published revisions yet.</p>
            ) : (
              <ul className="divide-y divide-gray-100">
                {chrome.history.map((h) => (
                  <li key={h.revision} className="flex items-center justify-between py-2.5">
                    <span className="text-sm text-gray-700">
                      revision {h.revision}
                      {h.published_at ? ` — ${new Date(h.published_at).toLocaleString()}` : ""}
                    </span>
                    <Button
                      size="sm"
                      variant="outline"
                      disabled={chrome.busy}
                      onClick={() => chrome.rollback(h.revision, notify, fail)}
                    >
                      Restore as draft
                    </Button>
                  </li>
                ))}
              </ul>
            )}
          </CardContent>
        </Card>
      )}
    </div>
  );
}
