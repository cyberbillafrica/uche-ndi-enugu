"use client";

/**
 * POLITICORE — Public site Footer (Phase 25).
 *
 * The SINGLE production footer renderer (Phase 21 gate §13, prompt §18).
 * Consumes the tenant's PUBLISHED footer configuration (columns, legal,
 * social placement, presentation) served by `public.get_public_site_chrome`.
 *
 * Data ownership is preserved (prompt §24): contact information and social
 * link URLs come from the canonical `contact` / `social_links` areas of the
 * same projection — the footer area controls PLACEMENT/PRESENTATION only and
 * never duplicates them. Branding (logo/site name) stays canonical in
 * `branding`. Destinations are validated (0063) and re-checked here.
 *
 * On any failure the parity default composition renders (gate §15).
 * Landmark semantics: <footer> with a labelled contentinfo role via the
 * implicit landmark; heading levels remain h4 within the footer.
 */

import Link from "next/link";
import Image from "next/image";
import { Mail, Phone, MapPin, ArrowUpRight, Heart } from "lucide-react";

import type { ReactElement } from "react";

import { usePublicChrome } from "./PublicChromeProvider";
import type { ChromeLink, FooterConfig } from "@/lib/chrome/types";

// Inline SVG brand icons (the lucide package carries no brand glyphs).
type IconProps = { className?: string };
const FacebookIcon = ({ className }: IconProps) => (
  <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className={className} aria-hidden>
    <path d="M18 2h-3a5 5 0 0 0-5 5v3H7v4h3v8h4v-8h3l1-4h-4V7a1 1 0 0 1 1-1h3z" />
  </svg>
);
const TwitterIcon = ({ className }: IconProps) => (
  <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className={className} aria-hidden>
    <path d="M4 4l11.733 16h4.267l-11.733-16z" />
    <path d="M4 20l6.768-6.768m2.46-2.46L20 4" />
  </svg>
);
const InstagramIcon = ({ className }: IconProps) => (
  <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className={className} aria-hidden>
    <rect x="2" y="2" width="20" height="20" rx="5" ry="5" />
    <path d="M16 11.37A4 4 0 1 1 12.63 8 4 4 0 0 1 16 11.37z" />
    <line x1="17.5" y1="6.5" x2="17.51" y2="6.5" />
  </svg>
);
const YoutubeIcon = ({ className }: IconProps) => (
  <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className={className} aria-hidden>
    <path d="M22.54 6.42a2.78 2.78 0 0 0-1.94-2C18.88 4 12 4 12 4s-6.88 0-8.6.46a2.78 2.78 0 0 0-1.94 2A29.94 29.94 0 0 0 1 11.75a29.94 29.94 0 0 0 .46 5.33A2.78 2.78 0 0 0 3.4 19c1.72.46 8.6.46 8.6.46s6.88-.46 8.6-.46a2.78 2.78 0 0 0 1.94-2 29.94 29.94 0 0 0 .46-5.25 29.94 29.94 0 0 0-.46-5.33z" />
    <polygon points="9.75 15.02 15.5 11.75 9.75 8.48 9.75 15.02" />
  </svg>
);

/** Declarative destinations only — mirrors cc_assert_safe_href. */
function safeChromeHref(href: unknown): string | null {
  if (typeof href !== "string") return null;
  const v = href.trim();
  if (v.length === 0 || v.length > 2000) return null;
  if (/^\s*(javascript|data|vbscript|file|about):/i.test(v)) return null;
  if (v.startsWith("/") || v.startsWith("#") || /^https?:\/\/\S+$/i.test(v)) return v;
  return null;
}

function FooterLink({ link }: { link: ChromeLink }) {
  const href = safeChromeHref(link.href);
  if (!href) return null; // malformed destination → omit the link
  const isExternal = /^https?:\/\//i.test(href);
  if (isExternal) {
    return (
      <a
        href={href}
        target="_blank"
        rel="noopener noreferrer"
        className="group flex items-center gap-2 text-sm text-white/55 transition-colors hover:text-white"
      >
        <span className="h-px w-0 bg-[var(--color-brand-primary)] transition-all duration-300 group-hover:w-4" />
        {link.label}
        <ArrowUpRight className="h-3.5 w-3.5 opacity-0 transition-all group-hover:-translate-y-0.5 group-hover:translate-x-0.5 group-hover:opacity-100" />
      </a>
    );
  }
  return (
    <Link
      href={href}
      className="group flex items-center gap-2 text-sm text-white/55 transition-colors hover:text-white"
    >
      <span className="h-px w-0 bg-[var(--color-brand-primary)] transition-all duration-300 group-hover:w-4" />
      {link.label}
      <ArrowUpRight className="h-3.5 w-3.5 opacity-0 transition-all group-hover:-translate-y-0.5 group-hover:translate-x-0.5 group-hover:opacity-100" />
    </Link>
  );
}

/** Canonical social surface (facebook/x/instagram/tiktok) → placement only. */
const SOCIAL_ICONS = [
  { key: "facebook", label: "Facebook", Icon: FacebookIcon },
  { key: "x", label: "X / Twitter", Icon: TwitterIcon },
  { key: "instagram", label: "Instagram", Icon: InstagramIcon },
  { key: "tiktok", label: "TikTok", Icon: YoutubeIcon },
] as const;

function SocialLinks({ canonical }: { canonical: Record<string, unknown> }) {
  type SocialEntry = { key: string; label: string; href: string; Icon: (p: IconProps) => ReactElement };
  const entries: SocialEntry[] = [];
  for (const { key, label, Icon } of SOCIAL_ICONS) {
    const href = safeChromeHref(canonical[key]);
    if (href) entries.push({ key, label, href, Icon });
  }
  if (entries.length === 0) return null;
  return (
    <div className="mt-5 flex items-center gap-3">
      {entries.map(({ key, label, href, Icon }) => (
        <a
          key={key}
          href={href}
          aria-label={label}
          target="_blank"
          rel="noopener noreferrer"
          className="flex h-9 w-9 items-center justify-center rounded-full border border-white/10 text-white/45 transition-all hover:border-[var(--color-brand-primary)]/40 hover:bg-[var(--color-brand-primary)]/10 hover:text-white"
        >
          <Icon className="h-4 w-4" />
        </a>
      ))}
    </div>
  );
}

/** Canonical contact area (phone/email/location keys) → placement only. */
function ContactBlock({ canonical }: { canonical: Record<string, unknown> }) {
  const phone = typeof canonical.phone === "string" ? canonical.phone : "+234 800 000 0000";
  const email = typeof canonical.email === "string" ? canonical.email : "info@uchenna.ng";
  const location = typeof canonical.location === "string" ? canonical.location : "Enugu State, Nigeria";
  return (
    <div className="space-y-3">
      {/* Office */}
      <div className="flex items-start gap-3 rounded-xl border border-white/5 bg-white/[0.03] p-3.5 transition-colors hover:border-[var(--color-brand-primary)]/30 hover:bg-white/[0.05]">
        <div className="mt-0.5 flex h-8 w-8 shrink-0 items-center justify-center rounded-lg bg-[var(--color-brand-primary)]/15 text-[color-mix(in_srgb,var(--color-brand-primary)_65%,white)]">
          <MapPin className="h-4 w-4" />
        </div>
        <div>
          <p className="text-xs font-semibold uppercase tracking-wider text-white/35">Campaign Office</p>
          <p className="mt-1 text-sm leading-5 text-white/65">{location}</p>
        </div>
      </div>

      {/* Phone */}
      <div className="flex items-center gap-3 rounded-xl border border-white/5 bg-white/[0.03] p-3.5 transition-colors hover:border-[var(--color-brand-primary)]/30 hover:bg-white/[0.05]">
        <div className="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg bg-[var(--color-brand-primary)]/15 text-[color-mix(in_srgb,var(--color-brand-primary)_65%,white)]">
          <Phone className="h-4 w-4" />
        </div>
        <div>
          <p className="text-xs font-semibold uppercase tracking-wider text-white/35">Phone</p>
          <p className="mt-1 text-sm text-white/65">{phone}</p>
        </div>
      </div>

      {/* Email */}
      <div className="flex items-center gap-3 rounded-xl border border-white/5 bg-white/[0.03] p-3.5 transition-colors hover:border-[var(--color-brand-primary)]/30 hover:bg-white/[0.05]">
        <div className="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg bg-[var(--color-brand-primary)]/15 text-[color-mix(in_srgb,var(--color-brand-primary)_65%,white)]">
          <Mail className="h-4 w-4" />
        </div>
        <div className="min-w-0">
          <p className="text-xs font-semibold uppercase tracking-wider text-white/35">Email</p>
          <p className="mt-1 truncate text-sm text-white/65">{email}</p>
        </div>
      </div>
    </div>
  );
}

export default function Footer() {
  const { chrome } = usePublicChrome();
  const footer: FooterConfig = chrome?.footer ?? ({} as FooterConfig);

  const columns = Array.isArray(footer.columns) ? footer.columns : [];
  const legal = footer.legal ?? {};
  const presentation = footer.presentation ?? {};
  const showContact = presentation.show_contact !== false;
  const showSocial = footer.social?.show !== false;
  const showCta = presentation.show_cta !== false;
  const ctaHref = presentation.cta_href ? safeChromeHref(presentation.cta_href) : null;
  const layout = presentation.layout === "columns-3" ? "lg:grid-cols-10" : "lg:grid-cols-12";
  const brandCol = presentation.layout === "columns-3" ? "lg:col-span-4" : "lg:col-span-5";
  const linkCol = presentation.layout === "columns-3" ? "lg:col-span-3" : "lg:col-span-2";
  const contactCol = presentation.layout === "columns-3" ? "lg:col-span-4" : "lg:col-span-3";

  const year = new Date().getFullYear();
  const copyright = (legal.copyright ?? "© {year} Uche Nnaji Campaign. All rights reserved.").replaceAll(
    "{year}",
    String(year)
  );

  return (
    <footer className="relative overflow-hidden bg-[#071b12] text-white">
      {/* Campaign accent */}
      <div className="flex h-1.5 w-full">
        <div className="w-1/3 bg-[var(--color-brand-primary)]" />
        <div className="w-1/3 bg-white" />
        <div className="w-1/3 bg-[var(--color-brand-primary)]" />
      </div>

      {/* Background glows */}
      <div className="pointer-events-none absolute -left-40 top-20 h-80 w-80 rounded-full bg-[var(--color-brand-primary)]/10 blur-3xl" />
      <div className="pointer-events-none absolute -right-40 bottom-0 h-96 w-96 rounded-full bg-[var(--color-brand-primary)]/5 blur-3xl" />

      <div className="relative mx-auto max-w-7xl px-4 sm:px-6 lg:px-8">
        {/* Main Footer */}
        <div className={`grid grid-cols-1 gap-12 py-14 ${layout} gap-10`}>
          {/* Brand — canonical published branding */}
          <div className={brandCol}>
            <Link href="/" className="group inline-flex items-center gap-4">
              <div className="relative flex h-14 w-14 shrink-0 items-center justify-center overflow-hidden rounded-2xl bg-white shadow-lg transition-shadow group-hover:shadow-xl">
                {chrome?.branding?.logo?.asset_id ? (
                  <Image
                    src={`/api/media/${chrome.branding.logo.asset_id}`}
                    alt={chrome.branding.logo.alt ?? chrome.branding.site_name ?? "Site logo"}
                    fill
                    sizes="56px"
                    className="object-contain p-1"
                    unoptimized
                  />
                ) : (
                  <Image
                    src="/images/official_logo.jpeg"
                    alt="Site logo"
                    fill
                    sizes="56px"
                    className="object-contain p-1"
                  />
                )}
              </div>

              <div>
                <span className="text-xl font-extrabold tracking-tight text-[var(--color-brand-primary)] sm:text-2xl">
                  {chrome?.branding?.site_name ?? "Uche Ndi Enugu"}
                </span>
                <p className="mt-1 text-[10px] font-semibold uppercase tracking-[0.16em] text-white/40 sm:text-[11px]">
                  Governorship • Enugu • 2027
                </p>
              </div>
            </Link>

            <div className="mt-7 max-w-md">
              <p className="text-[15px] leading-7 text-white/60">
                A campaign built around responsive leadership, inclusive governance, sustainable
                development and a renewed commitment to the people of Enugu State.
              </p>
            </div>

            {/* Campaign statement */}
            <div className="mt-7 border-l-2 border-[var(--color-brand-primary)] pl-4">
              <p className="text-sm font-semibold leading-6 text-white/80">Leadership. Service. Progress.</p>
              <p className="mt-1 text-xs leading-5 text-white/40">
                Together, we can build a stronger and more prosperous Enugu.
              </p>
            </div>
          </div>

          {/* Configured columns */}
          {columns.slice(0, 2).map((col) => (
            <div key={col.id} className={linkCol}>
              <h4 className="mb-5 text-sm font-bold uppercase tracking-[0.18em] text-white">{col.heading}</h4>
              <ul className="space-y-3.5">
                {(col.links ?? []).map((link, i) => (
                  <li key={`${col.id}-${i}`}>
                    <FooterLink link={link} />
                  </li>
                ))}
              </ul>
            </div>
          ))}

          {/* Contact — canonical data, footer-controlled placement */}
          {showContact && (
            <div className={contactCol}>
              <h4 className="mb-5 text-sm font-bold uppercase tracking-[0.18em] text-white">Contact</h4>

              <ContactBlock canonical={chrome?.contact ?? {}} />

              {showSocial && <SocialLinks canonical={chrome?.social_links ?? {}} />}
            </div>
          )}
        </div>

        {/* CTA banner */}
        {showCta && ctaHref && (
          <div className="relative overflow-hidden rounded-2xl border border-white/10 bg-gradient-to-r from-[var(--color-brand-primary)]/15 via-white/[0.03] to-[var(--color-brand-primary)]/10 px-5 py-6 sm:px-7">
            <div className="absolute left-0 top-0 h-full w-1 bg-[var(--color-brand-primary)]" />
            <div className="absolute right-0 top-0 h-full w-1 bg-[var(--color-brand-primary)]" />

            <div className="flex flex-col items-center justify-between gap-4 text-center sm:flex-row sm:text-left">
              <div>
                <p className="text-sm font-bold text-white">
                  {presentation.cta_heading ?? "Enugu, our future is in our hands."}
                </p>
                <p className="mt-1 text-xs text-white/45">
                  Join the movement for purposeful leadership and a better tomorrow.
                </p>
              </div>

              <Link
                href={ctaHref}
                className="inline-flex items-center gap-2 rounded-full bg-[var(--color-brand-primary)] px-5 py-2.5 text-sm font-bold text-white shadow-lg shadow-[var(--color-brand-primary)]/20 transition-all hover:bg-[color-mix(in_srgb,var(--color-brand-primary)_88%,black)] hover:shadow-[var(--color-brand-primary)]/30"
              >
                {presentation.cta_label ?? "Get Involved"}
                <ArrowUpRight className="h-4 w-4" />
              </Link>
            </div>
          </div>
        )}

        {/* Copyright */}
        <div className="mt-8 border-t border-white/10 py-7">
          <div className="flex flex-col items-center justify-between gap-4 text-center sm:flex-row sm:text-left">
            <p className="text-xs text-white/40">{copyright}</p>

            <p className="flex items-center gap-1.5 text-xs text-white/40">
              Designed with
              <Heart className="h-3.5 w-3.5 fill-[var(--color-brand-secondary)] text-[var(--color-brand-secondary)]" />
              by{" "}
              {(legal.links ?? [])
                .map((l) => ({ link: l, href: safeChromeHref(l.href) }))
                .filter((x) => x.href !== null)
                .map(({ link, href }, i, arr) => (
                  <span key={`${link.label}-${i}`}>
                    {/^https?:\/\//i.test(href!) ? (
                      <a
                        href={href!}
                        target="_blank"
                        rel="noopener noreferrer"
                        className="font-semibold text-[color-mix(in_srgb,var(--color-brand-primary)_65%,white)] transition-colors hover:text-white"
                      >
                        {link.label}
                      </a>
                    ) : (
                      <Link
                        href={href!}
                        className="font-semibold text-[color-mix(in_srgb,var(--color-brand-primary)_65%,white)] transition-colors hover:text-white"
                      >
                        {link.label}
                      </Link>
                    )}
                    {i < arr.length - 1 ? " · " : ""}
                  </span>
                ))}
            </p>
          </div>
        </div>
      </div>
    </footer>
  );
}
