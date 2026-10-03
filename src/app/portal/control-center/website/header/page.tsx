"use client";

/**
 * POLITICORE — Control Center: Header presentation editor (Phase 25).
 *
 * Bounded presentation controls only (prompt §5/§20): logo/site-name/nav
 * visibility, CTA shape, mobile-menu variant and alignment. The underlying
 * storage is the `navigation` area's `header` sub-object (Phase 21 gate
 * §12) — navigation ITEMS live in the Navigation editor; a notice links
 * there. Both editors save through the same revision-checked RPC, so
 * concurrent edits fail safely instead of overwriting.
 */

import { Loader2, Save } from "lucide-react";

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
import {
  DEFAULT_NAVIGATION_CONFIG,
  HEADER_ALIGNMENTS,
  HEADER_MOBILE_MENUS,
  isValidNavigationConfig,
  type NavigationConfig,
} from "@/lib/chrome/types";
import { useChromeArea } from "@/lib/chrome/useChromeArea";

export default function HeaderBuilderPage() {
  const toast = useToast();

  const chrome = useChromeArea<NavigationConfig>(
    "navigation",
    DEFAULT_NAVIGATION_CONFIG,
    (d) => (isValidNavigationConfig(d) ? null : "Configuration is invalid — check the highlighted fields.")
  );

  const header = chrome.draft.header ?? {};
  const cta = header.cta;
  const notify = (m: string) => toast.success(m);
  const fail = (m: string) => toast.error(m);

  if (chrome.loading) {
    return (
      <div className="flex items-center justify-center py-16 text-gray-500">
        <Loader2 className="h-5 w-5 animate-spin" aria-hidden />
        <span className="ml-2 text-sm">Loading header configuration…</span>
      </div>
    );
  }

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-bold text-gray-900">Header</h1>
        <p className="text-sm text-gray-600">
          Bounded presentation for the global header. Branding itself (logo asset, site name,
          tokens) is owned by{" "}
          <a href="/portal/control-center/website/branding" className="font-medium text-green-700 underline">
            Branding &amp; Theme
          </a>
          ; navigation items live in{" "}
          <a href="/portal/control-center/website/navigation" className="font-medium text-green-700 underline">
            Navigation &amp; Header
          </a>
          .
        </p>
      </div>

      {chrome.error && (
        <div className="rounded-lg border border-red-200 bg-red-50 p-3 text-sm text-red-700">{chrome.error}</div>
      )}

      <Card>
        <CardHeader>
          <CardTitle className="text-base">Presentation</CardTitle>
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
                id={`h-${key}`}
                type="checkbox"
                className="h-4 w-4 rounded border-gray-300"
                checked={header[key] !== false}
                onChange={(e) =>
                  chrome.setDraft((d) => ({ ...d, header: { ...d.header, [key]: e.target.checked } }))
                }
              />
              <Label htmlFor={`h-${key}`}>{label}</Label>
            </div>
          ))}

          <div>
            <Label htmlFor="h-alignment">Desktop alignment</Label>
            <Select
              value={header.alignment ?? "right"}
              onValueChange={(v) =>
                chrome.setDraft((d) => ({ ...d, header: { ...d.header, alignment: v as never } }))
              }
            >
              <SelectTrigger id="h-alignment" className="mt-1">
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
            <Label htmlFor="h-mobile">Mobile menu</Label>
            <Select
              value={header.mobile_menu ?? "accordion"}
              onValueChange={(v) =>
                chrome.setDraft((d) => ({ ...d, header: { ...d.header, mobile_menu: v as never } }))
              }
            >
              <SelectTrigger id="h-mobile" className="mt-1">
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
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle className="text-base">Call-to-action (signed-out visitors)</CardTitle>
        </CardHeader>
        <CardContent className="space-y-3">
          <div className="flex items-center gap-2">
            <input
              id="h-cta"
              type="checkbox"
              className="h-4 w-4 rounded border-gray-300"
              checked={cta?.enabled === true}
              onChange={(e) =>
                chrome.setDraft((d) => ({
                  ...d,
                  header: {
                    ...d.header,
                    cta: {
                      enabled: e.target.checked,
                      label: d.header?.cta?.label ?? "Get Involved",
                      href: d.header?.cta?.href ?? "/volunteer",
                    },
                  },
                }))
              }
            />
            <Label htmlFor="h-cta">Show call-to-action button</Label>
          </div>
          {cta?.enabled === true && (
            <div className="grid gap-3 sm:grid-cols-2">
              <div>
                <Label htmlFor="h-cta-label">Label</Label>
                <Input
                  id="h-cta-label"
                  className="mt-1"
                  maxLength={60}
                  value={cta.label ?? ""}
                  onChange={(e) =>
                    chrome.setDraft((d) => ({
                      ...d,
                      header: { ...d.header, cta: { ...d.header!.cta!, label: e.target.value } },
                    }))
                  }
                />
              </div>
              <div>
                <Label htmlFor="h-cta-href">Destination (internal path, #fragment or https URL)</Label>
                <Input
                  id="h-cta-href"
                  className="mt-1"
                  maxLength={2000}
                  value={cta.href ?? ""}
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
        </CardContent>
      </Card>

      <Card>
        <CardContent className="flex flex-wrap items-center gap-3 pt-6">
          <Button disabled={chrome.busy} onClick={() => chrome.saveDraft(notify, fail)}>
            {chrome.busy ? <Loader2 className="mr-2 h-4 w-4 animate-spin" aria-hidden /> : <Save className="mr-2 h-4 w-4" aria-hidden />}
            Save draft
          </Button>
          <Button variant="default" disabled={chrome.busy || !chrome.isDirty} onClick={() => chrome.publish(notify, fail)}>
            Publish
          </Button>
          <span className="ml-auto text-xs text-gray-500">
            revision {chrome.revision}
            {chrome.isDirty ? " · unsaved changes" : ""}
            {chrome.validationError ? " · invalid configuration" : ""}
          </span>
        </CardContent>
      </Card>

      {chrome.validationError && <p className="text-sm text-amber-700">{chrome.validationError}</p>}
    </div>
  );
}
