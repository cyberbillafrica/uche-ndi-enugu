"use client";

/**
 * POLITICORE — Control Center: Navigation & Header editor (Phase 25).
 *
 * Typed editor over the validated `navigation` configuration area — no
 * arbitrary JSON editing, no CSS/class inputs, no executable fields. The
 * editor mutates the DRAFT only; publish promotes through migration 0063's
 * server-side validators with optimistic revision concurrency. Preview
 * renders the SAME production Header component with the draft chrome
 * (prompt §19) — no second renderer exists.
 */

import { useMemo, useState } from "react";
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
import Header from "@/components/layout/Header";
import { PublicChromeProvider } from "@/components/layout/PublicChromeProvider";
import type { PublicSiteChrome } from "@/lib/supabase/websiteExperience";
import {
  CHROME_ITEM_STYLES,
  CHROME_ITEM_TYPES,
  CHROME_SERVICE_DEPENDENCIES,
  CHROME_VISIBILITIES,
  DEFAULT_NAVIGATION_CONFIG,
  HEADER_ALIGNMENTS,
  HEADER_MOBILE_MENUS,
  isValidNavigationConfig,
  type ChromeNavItem,
  type NavigationConfig,
} from "@/lib/chrome/types";
import { useChromeArea } from "@/lib/chrome/useChromeArea";

const DEP_LABELS: Record<string, string> = {
  "": "No dependency",
  social: "Social Force",
  campaign: "Campaign",
  election: "Election",
  governance: "Governance",
};

function emptyItem(): ChromeNavItem {
  return {
    id: `item-${Date.now().toString(36)}`,
    label: "New item",
    href: "/",
    type: "internal",
    visibility: "public",
  };
}

export default function NavigationBuilderPage() {
  const toast = useToast();
  const [showPreview, setShowPreview] = useState(false);
  const [showHistory, setShowHistory] = useState(false);

  const chrome = useChromeArea<NavigationConfig>(
    "navigation",
    DEFAULT_NAVIGATION_CONFIG,
    (d) => (isValidNavigationConfig(d) ? null : "Configuration is invalid — check the highlighted fields.")
  );

  const items = useMemo(
    () => (Array.isArray(chrome.draft.items) ? chrome.draft.items : []),
    [chrome.draft.items]
  );

  function setItems(next: ChromeNavItem[]) {
    chrome.setDraft((d) => ({ ...d, items: next }));
  }

  function updateItem(idx: number, patch: Partial<ChromeNavItem>) {
    setItems(items.map((it, i) => (i === idx ? { ...it, ...patch } : it)));
  }

  function move(idx: number, dir: -1 | 1) {
    const j = idx + dir;
    if (j < 0 || j >= items.length) return;
    const next = [...items];
    [next[idx], next[j]] = [next[j], next[idx]];
    setItems(next);
  }

  const previewChrome: PublicSiteChrome = {
    branding: {},
    seo: {},
    navigation: chrome.draft,
    footer: {},
    contact: {},
    social_links: {},
  };

  const notify = (m: string) => toast.success(m);
  const fail = (m: string) => toast.error(m);

  if (chrome.loading) {
    return (
      <div className="flex items-center justify-center py-16 text-gray-500">
        <Loader2 className="h-5 w-5 animate-spin" aria-hidden />
        <span className="ml-2 text-sm">Loading navigation configuration…</span>
      </div>
    );
  }

  return (
    <div className="space-y-6">
      <div className="flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between">
        <div>
          <h1 className="text-2xl font-bold text-gray-900">Navigation &amp; Header</h1>
          <p className="text-sm text-gray-600">
            Public navigation is presentation only — it never grants or restricts authorization.
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

      {/* Header presentation */}
      <Card>
        <CardHeader>
          <CardTitle className="text-base">Header presentation</CardTitle>
        </CardHeader>
        <CardContent className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
          {(
            [
              ["show_logo", "Show logo"],
              ["show_site_name", "Show site name"],
              ["show_primary_nav", "Show primary navigation"],
            ] as const
          ).map(([key, label]) => (
            <div key={key} className="flex items-center gap-2">
              <input
                id={`hdr-${key}`}
                type="checkbox"
                className="h-4 w-4 rounded border-gray-300"
                checked={chrome.draft.header?.[key] !== false}
                onChange={(e) =>
                  chrome.setDraft((d) => ({ ...d, header: { ...d.header, [key]: e.target.checked } }))
                }
              />
              <Label htmlFor={`hdr-${key}`}>{label}</Label>
            </div>
          ))}

          <div>
            <Label htmlFor="hdr-alignment">Desktop alignment</Label>
            <Select
              value={chrome.draft.header?.alignment ?? "right"}
              onValueChange={(v) =>
                chrome.setDraft((d) => ({ ...d, header: { ...d.header, alignment: v as never } }))
              }
            >
              <SelectTrigger id="hdr-alignment" className="mt-1">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {HEADER_ALIGNMENTS.map((a) => (
                  <SelectItem key={a} value={a}>
                    {a}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>

          <div>
            <Label htmlFor="hdr-mobile">Mobile menu</Label>
            <Select
              value={chrome.draft.header?.mobile_menu ?? "accordion"}
              onValueChange={(v) =>
                chrome.setDraft((d) => ({ ...d, header: { ...d.header, mobile_menu: v as never } }))
              }
            >
              <SelectTrigger id="hdr-mobile" className="mt-1">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {HEADER_MOBILE_MENUS.map((m) => (
                  <SelectItem key={m} value={m}>
                    {m}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>

          <div className="sm:col-span-2 lg:col-span-3">
            <div className="flex items-center gap-2">
              <input
                id="hdr-cta"
                type="checkbox"
                className="h-4 w-4 rounded border-gray-300"
                checked={chrome.draft.header?.cta?.enabled === true}
                onChange={(e) =>
                  chrome.setDraft((d) => ({
                    ...d,
                    header: {
                      ...d.header,
                      cta: { enabled: e.target.checked, label: d.header?.cta?.label ?? "Get Involved", href: d.header?.cta?.href ?? "/volunteer" },
                    },
                  }))
                }
              />
              <Label htmlFor="hdr-cta">Show call-to-action button (signed-out visitors)</Label>
            </div>
            {chrome.draft.header?.cta?.enabled === true && (
              <div className="mt-3 grid gap-3 sm:grid-cols-2">
                <div>
                  <Label htmlFor="cta-label">CTA label</Label>
                  <Input
                    id="cta-label"
                    className="mt-1"
                    maxLength={60}
                    value={chrome.draft.header.cta.label ?? ""}
                    onChange={(e) =>
                      chrome.setDraft((d) => ({
                        ...d,
                        header: { ...d.header, cta: { ...d.header!.cta!, label: e.target.value } },
                      }))
                    }
                  />
                </div>
                <div>
                  <Label htmlFor="cta-href">CTA destination (internal path, #fragment or https URL)</Label>
                  <Input
                    id="cta-href"
                    className="mt-1"
                    maxLength={2000}
                    value={chrome.draft.header.cta.href ?? ""}
                    onChange={(e) =>
                      chrome.setDraft((d) => ({
                        ...d,
                        header: { ...d.header, cta: { ...d.header!.cta!, href: e.target.value } },
                      }))
                    }
                  />
                </div>
              </div>
            )}
          </div>
        </CardContent>
      </Card>

      {/* Navigation items */}
      <Card>
        <CardHeader className="flex flex-row items-center justify-between">
          <CardTitle className="text-base">Navigation items</CardTitle>
          <Button
            size="sm"
            variant="outline"
            disabled={items.length >= 12}
            onClick={() => setItems([...items, emptyItem()])}
          >
            <Plus className="mr-1 h-4 w-4" aria-hidden /> Add item
          </Button>
        </CardHeader>
        <CardContent className="space-y-4">
          {items.length === 0 && (
            <p className="text-sm text-gray-500">No navigation items configured.</p>
          )}

          {items.map((item, idx) => (
            <div key={item.id} className="rounded-xl border border-gray-200 p-4">
              <div className="flex items-center justify-between gap-2">
                <span className="text-xs font-semibold uppercase tracking-wider text-gray-400">
                  {item.id}
                </span>
                <div className="flex items-center gap-1">
                  <Button size="icon" variant="ghost" aria-label="Move up" disabled={idx === 0} onClick={() => move(idx, -1)}>
                    <ChevronUp className="h-4 w-4" />
                  </Button>
                  <Button
                    size="icon"
                    variant="ghost"
                    aria-label="Move down"
                    disabled={idx === items.length - 1}
                    onClick={() => move(idx, 1)}
                  >
                    <ChevronDown className="h-4 w-4" />
                  </Button>
                  <Button
                    size="icon"
                    variant="ghost"
                    aria-label={`Delete ${item.label}`}
                    onClick={() => setItems(items.filter((_, i) => i !== idx))}
                  >
                    <Trash2 className="h-4 w-4 text-red-500" />
                  </Button>
                </div>
              </div>

              <div className="mt-3 grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
                <div>
                  <Label htmlFor={`lbl-${item.id}`}>Label</Label>
                  <Input
                    id={`lbl-${item.id}`}
                    className="mt-1"
                    maxLength={120}
                    value={item.label}
                    onChange={(e) => updateItem(idx, { label: e.target.value })}
                  />
                </div>
                <div>
                  <Label htmlFor={`href-${item.id}`}>Destination</Label>
                  <Input
                    id={`href-${item.id}`}
                    className="mt-1"
                    maxLength={2000}
                    placeholder="/news · #about · https://…"
                    value={item.href}
                    onChange={(e) => updateItem(idx, { href: e.target.value })}
                  />
                </div>
                <div>
                  <Label htmlFor={`type-${item.id}`}>Type</Label>
                  <Select
                    value={item.type}
                    onValueChange={(v) => updateItem(idx, { type: v as never })}
                  >
                    <SelectTrigger id={`type-${item.id}`} className="mt-1">
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      {CHROME_ITEM_TYPES.map((t) => (
                        <SelectItem key={t} value={t}>
                          {t}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </div>
                <div>
                  <Label htmlFor={`vis-${item.id}`}>Visibility</Label>
                  <Select
                    value={item.visibility}
                    onValueChange={(v) => updateItem(idx, { visibility: v as never })}
                  >
                    <SelectTrigger id={`vis-${item.id}`} className="mt-1">
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      {CHROME_VISIBILITIES.map((v) => (
                        <SelectItem key={v} value={v}>
                          {v}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </div>
                <div>
                  <Label htmlFor={`dep-${item.id}`}>Service dependency</Label>
                  <Select
                    value={item.service_dependency ?? ""}
                    onValueChange={(v) =>
                      updateItem(idx, { service_dependency: v === "" ? undefined : (v as never) })
                    }
                  >
                    <SelectTrigger id={`dep-${item.id}`} className="mt-1">
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      {["", ...CHROME_SERVICE_DEPENDENCIES].map((d) => (
                        <SelectItem key={d || "none"} value={d}>
                          {DEP_LABELS[d]}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </div>
                <div>
                  <Label htmlFor={`style-${item.id}`}>Style</Label>
                  <Select
                    value={item.presentation?.style ?? "default"}
                    onValueChange={(v) =>
                      updateItem(idx, { presentation: { ...item.presentation, style: v as never } })
                    }
                  >
                    <SelectTrigger id={`style-${item.id}`} className="mt-1">
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      {CHROME_ITEM_STYLES.map((s) => (
                        <SelectItem key={s} value={s}>
                          {s}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </div>
                <div className="flex items-center gap-2 pt-5">
                  <input
                    id={`en-${item.id}`}
                    type="checkbox"
                    className="h-4 w-4 rounded border-gray-300"
                    checked={item.enabled !== false}
                    onChange={(e) => updateItem(idx, { enabled: e.target.checked })}
                  />
                  <Label htmlFor={`en-${item.id}`}>Enabled</Label>
                </div>
              </div>
            </div>
          ))}
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

      {chrome.validationError && (
        <p className="text-sm text-amber-700">{chrome.validationError}</p>
      )}

      {/* Draft preview — the SAME production Header, admin-only surface */}
      {showPreview && (
        <Card>
          <CardHeader>
            <CardTitle className="text-base">Draft preview (not public)</CardTitle>
          </CardHeader>
          <CardContent className="overflow-hidden rounded-xl border border-gray-200">
            <PublicChromeProvider chrome={previewChrome}>
              <Header />
            </PublicChromeProvider>
          </CardContent>
        </Card>
      )}

      {/* History / rollback */}
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
