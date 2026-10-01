import type { Metadata } from "next";
import { Inter } from "next/font/google";

import "./globals.css";
import { AuthProvider } from "@/contexts/AuthContext";
import { ToastProvider } from "@/components/ui/toast";
import { getPublicSiteChrome } from "@/lib/supabase/websiteExperience";
import {
  resolveBrandTokens,
  brandTokenStyle,
} from "@/lib/branding/presets";

const inter = Inter({
  subsets: ["latin"],
});

const FALLBACK_TITLE = "Uche-Ndi-Enugu 2027 | Governorship";
const FALLBACK_DESCRIPTION = "Building a brighter future for Ndi Enugu";

/**
 * Phase 23 — tenant-level SEO metadata from the PUBLISHED `seo` area
 * (public projection RPC only; drafts never reach the public site).
 * Fallback safety (gate §15): any failure renders the established defaults.
 */
export async function generateMetadata(): Promise<Metadata> {
  try {
    const { branding, seo } = await getPublicSiteChrome();
    const metadata: Metadata = {
      title: seo.title ?? FALLBACK_TITLE,
      description: seo.description ?? FALLBACK_DESCRIPTION,
    };
    if (seo.keywords?.length) metadata.keywords = seo.keywords;
    if (seo.canonical_url) {
      metadata.alternates = { canonical: seo.canonical_url };
    }
    if (seo.robots) metadata.robots = seo.robots;
    if (seo.og_title || seo.og_description || seo.description) {
      metadata.openGraph = {
        title: seo.og_title ?? seo.title ?? FALLBACK_TITLE,
        description: seo.og_description ?? seo.description ?? FALLBACK_DESCRIPTION,
      };
    }
    if (branding.favicon?.asset_id) {
      // Canonical Core Media asset → public render route (server-resolved).
      metadata.icons = { icon: `/api/media/${branding.favicon.asset_id}` };
    }
    return metadata;
  } catch {
    return { title: FALLBACK_TITLE, description: FALLBACK_DESCRIPTION };
  }
}

export default async function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  // Phase 23 — inject the tenant's PUBLISHED brand tokens as CSS custom
  // properties on <html>. Published-only projection, resolved server-side;
  // on any failure the fallback bundle already declared in globals.css
  // renders the established visual language (gate §15).
  let brandStyle: Record<string, string> = {};
  try {
    const { branding } = await getPublicSiteChrome();
    brandStyle = brandTokenStyle(resolveBrandTokens(branding));
  } catch {
    brandStyle = {};
  }

  return (
    <html lang="en" style={brandStyle}>
      <body className={inter.className}>
        <AuthProvider>
          <ToastProvider>{children}</ToastProvider>
        </AuthProvider>
      </body>
    </html>
  );
}
