"use client";

/**
 * POLITICORE — Public chrome context (Phase 25).
 *
 * Feeds the SINGLE Header/Footer renderers the tenant's published chrome
 * (navigation incl. header presentation, footer, canonical contact/social,
 * branding). The root layout resolves the published projection
 * server-side (`get_public_site_chrome`) and passes it in, so SSR HTML
 * carries the real configuration and draft state never reaches the client.
 *
 * Admin preview surfaces (prompt §19) render the SAME components by
 * supplying a draft chrome through this provider — no second renderer
 * exists. When no chrome is supplied (projection failure, gate §15), the
 * parity defaults render and the public shell can never go blank.
 */

import { createContext, useContext, useMemo, type ReactNode } from "react";

import type { PublicSiteChrome } from "@/lib/supabase/websiteExperience";
import { DEFAULT_FOOTER_CONFIG, DEFAULT_NAVIGATION_CONFIG } from "@/lib/chrome/types";
import type { FooterConfig, NavigationConfig } from "@/lib/chrome/types";

interface PublicChromeContextValue {
  chrome: PublicSiteChrome;
}

const PublicChromeContext = createContext<PublicChromeContextValue | null>(null);

const FALLBACK_CHROME: PublicSiteChrome = {
  branding: {},
  seo: {},
  navigation: DEFAULT_NAVIGATION_CONFIG as NavigationConfig,
  footer: DEFAULT_FOOTER_CONFIG as FooterConfig,
  contact: {},
  social_links: {},
};

export function PublicChromeProvider({
  chrome,
  children,
}: {
  chrome: PublicSiteChrome | null;
  children: ReactNode;
}) {
  const value = useMemo<PublicChromeContextValue>(
    () => ({
      chrome:
        chrome && chrome.navigation && chrome.footer
          ? chrome
          : { ...FALLBACK_CHROME, ...(chrome ?? {}) },
    }),
    [chrome]
  );
  return <PublicChromeContext.Provider value={value}>{children}</PublicChromeContext.Provider>;
}

/** Single production source of chrome config for the public shell. */
export function usePublicChrome(): PublicChromeContextValue {
  const ctx = useContext(PublicChromeContext);
  // Unmounted provider (e.g. a stray test render) → parity defaults, never a crash.
  return ctx ?? { chrome: FALLBACK_CHROME };
}
