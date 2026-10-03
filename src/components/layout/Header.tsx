"use client";

/**
 * POLITICORE — Public site Header (Phase 25).
 *
 * The SINGLE production header renderer (Phase 21 gate §12, prompt §18):
 * it consumes the tenant's PUBLISHED navigation chrome — items, header
 * presentation, CTA — served by `public.get_public_site_chrome` with
 * server-side eligibility already applied (disabled items and items whose
 * service module is deactivated never reach the client; migration 0063 §D).
 *
 * It configures NOTHING beyond presentation: visibility classes are
 * presentation state (a hidden item is NOT access control — protected
 * routes stay server/DB-authoritative, prompt §9); destinations are
 * bounded to internal paths, #fragments and http(s) URLs (validated in
 * 0063 before storage and re-checked here). Branding (logo/site name)
 * remains canonical in the published `branding` area — never duplicated.
 *
 * On any projection failure the parity default composition renders, so the
 * public shell can never go blank (gate §15 fallback safety). Accessibility
 * (prompt §22): semantic <nav>, aria-expanded menu button, labelled links,
 * keyboard-closable mobile menu.
 */

import { useEffect, useMemo, useRef, useState } from "react";
import Link from "next/link";
import Image from "next/image";
import { Menu, X, User, Bell, LogOut, ArrowUpRight } from "lucide-react";

import { useAuth } from "@/contexts/AuthContext";
import { getSupabaseClient, logOut } from "@/lib/supabase";
import { usePublicChrome } from "@/components/layout/PublicChromeProvider";
import {
  DEFAULT_NAVIGATION_CONFIG,
  type ChromeNavItem,
  type NavigationConfig,
} from "@/lib/chrome/types";

/** Declarative destinations only — mirrors cc_assert_safe_href. */
function safeChromeHref(href: unknown): string | null {
  if (typeof href !== "string") return null;
  const v = href.trim();
  if (v.length === 0 || v.length > 2000) return null;
  if (/^\s*(javascript|data|vbscript|file|about):/i.test(v)) return null;
  if (v.startsWith("/") || v.startsWith("#") || /^https?:\/\/\S+$/i.test(v)) return v;
  return null;
}

function NavLabel({ item }: { item: ChromeNavItem }) {
  return (
    <span
      className={
        item.presentation?.style === "pill"
          ? "rounded-full px-3 py-1 text-sm font-medium text-gray-600 transition-colors hover:bg-green-50 hover:text-[var(--color-brand-primary)]"
          : "text-sm font-medium text-gray-600 transition-colors hover:text-[var(--color-brand-primary)]"
      }
    >
      {item.label}
    </span>
  );
}

function DesktopItem({ item }: { item: ChromeNavItem }) {
  const href = safeChromeHref(item.href);
  if (!href) return null; // unknown/malformed destination → omit the item
  const isExternal = /^https?:\/\//i.test(href);
  if (isExternal) {
    return (
      <a href={href} target="_blank" rel="noopener noreferrer" className="inline-flex">
        <NavLabel item={item} />
        <ArrowUpRight className="ml-1 h-3.5 w-3.5 self-center text-gray-300" />
      </a>
    );
  }
  return (
    <Link href={href} className="inline-flex">
      <NavLabel item={item} />
    </Link>
  );
}

export default function Header() {
  const [isOpen, setIsOpen] = useState(false);
  const { user } = useAuth();
  const { chrome } = usePublicChrome();
  const menuRef = useRef<HTMLDivElement | null>(null);

  // prompt §22: close the mobile menu on Escape / outside click.
  useEffect(() => {
    if (!isOpen) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setIsOpen(false);
    };
    const onClick = (e: MouseEvent) => {
      if (menuRef.current && !menuRef.current.contains(e.target as Node)) setIsOpen(false);
    };
    window.addEventListener("keydown", onKey);
    window.addEventListener("mousedown", onClick);
    return () => {
      window.removeEventListener("keydown", onKey);
      window.removeEventListener("mousedown", onClick);
    };
  }, [isOpen]);

  const nav: NavigationConfig = useMemo(
    () => (chrome?.navigation ? chrome.navigation : DEFAULT_NAVIGATION_CONFIG),
    [chrome]
  );

  const header = useMemo(() => nav.header ?? {}, [nav]);
  const items = useMemo(() => {
    const list = Array.isArray(nav.items) ? nav.items : [];
    // `authenticated` visibility is presentation: signed-out visitors don't
    // see member entries. It grants NOTHING — direct URL access stays
    // authorized by the existing application/database layers (prompt §9).
    return list.filter((i) => (i.visibility === "authenticated" ? Boolean(user) : true));
  }, [nav, user]);

  const mobileMenu = header.mobile_menu ?? "accordion";
  const cta = header.cta;
  const ctaHref = cta?.enabled ? safeChromeHref(cta.href) : null;
  const showLogo = header.show_logo !== false;
  const showSiteName = header.show_site_name !== false;
  const showNav = header.show_primary_nav !== false;

  const handleLogout = async () => {
    await logOut(getSupabaseClient());
    setIsOpen(false);
  };

  const closeMenu = () => setIsOpen(false);

  const alignment =
    header.alignment === "center" ? "justify-center" : header.alignment === "left" ? "justify-start" : "justify-end";

  return (
    <header className="sticky top-0 z-50 bg-white shadow-[0_2px_20px_rgba(0,0,0,0.06)]">
      {/* Campaign accent */}
      <div className="flex h-1 w-full">
        <div className="w-1/3 bg-[var(--color-brand-primary)]" />
        <div className="w-1/3 bg-white" />
        <div className="w-1/3 bg-[var(--color-brand-primary)]" />
      </div>

      <nav aria-label="Primary" className="mx-auto max-w-7xl px-4 sm:px-6 lg:px-8">
        <div className="flex h-[76px] items-center justify-between">
          {/* BRAND — canonical published branding (logo asset via Core Media) */}
          {(showLogo || showSiteName) && (
            <div className="shrink-0">
              <Link href="/" onClick={closeMenu} className="group flex items-center gap-3">
                {showLogo && (
                  <div className="relative flex h-11 w-11 items-center justify-center overflow-hidden rounded-xl border border-gray-100 bg-white shadow-sm transition-all duration-300 group-hover:shadow-md">
                    {chrome?.branding?.logo?.asset_id ? (
                      <Image
                        src={`/api/media/${chrome.branding.logo.asset_id}`}
                        alt={chrome.branding.logo.alt ?? chrome.branding.site_name ?? "Site logo"}
                        fill
                        sizes="44px"
                        className="object-contain p-1"
                        unoptimized
                      />
                    ) : (
                      <Image
                        src="/images/official_logo.jpeg"
                        alt="Site logo"
                        fill
                        sizes="44px"
                        className="object-contain p-1"
                      />
                    )}
                  </div>
                )}

                {showSiteName && (
                  <div className="leading-none">
                    <span className="text-lg font-extrabold tracking-tight text-[var(--color-brand-primary)] sm:text-xl">
                      {chrome?.branding?.site_name ?? "Uche Ndi Enugu"}
                    </span>
                    <span className="mt-1 block text-[10px] font-semibold uppercase tracking-[0.16em] text-gray-400 sm:text-[11px]">
                      Governorship • Enugu • 2027
                    </span>
                  </div>
                )}
              </Link>
            </div>
          )}

          {/* DESKTOP NAVIGATION — published, server-side eligible items */}
          {showNav && (
            <div className={`hidden items-center gap-7 md:flex ${alignment}`}>
              {items.map((item) => (
                <DesktopItem key={item.id} item={item} />
              ))}
            </div>
          )}

          {/* DESKTOP ACTIONS */}
          <div className="hidden items-center gap-4 md:flex">
            {user ? (
              <>
                <button
                  aria-label="Notifications"
                  className="relative rounded-full p-2 text-gray-500 transition-colors hover:bg-green-50 hover:text-[var(--color-brand-primary)]"
                >
                  <Bell className="h-5 w-5" />
                  <span className="absolute right-0.5 top-0.5 flex h-4 w-4 items-center justify-center rounded-full bg-[var(--color-brand-primary)] text-[9px] font-bold text-white">
                    3
                  </span>
                </button>

                <Link
                  href="/portal/dashboard"
                  className="flex items-center gap-2 rounded-full bg-[var(--color-brand-primary)] px-5 py-2.5 text-sm font-bold text-white shadow-sm transition-all hover:bg-[color-mix(in_srgb,var(--color-brand-primary)_88%,black)] hover:shadow-md"
                >
                  <User className="h-4 w-4" />
                  <span>Portal</span>
                </Link>

                <button
                  onClick={handleLogout}
                  aria-label="Logout"
                  className="rounded-full p-2 text-gray-400 transition-colors hover:bg-red-50 hover:text-red-600"
                >
                  <LogOut className="h-5 w-5" />
                </button>
              </>
            ) : (
              <>
                <Link
                  href="/login"
                  className="text-sm font-semibold text-[var(--color-brand-primary)] transition-colors hover:text-[color-mix(in_srgb,var(--color-brand-primary)_85%,black)]"
                >
                  Log In
                </Link>

                {ctaHref && (
                  <Link
                    href={ctaHref}
                    className="group flex items-center gap-2 rounded-full bg-[var(--color-brand-primary)] px-5 py-2.5 text-sm font-bold text-white shadow-sm transition-all hover:bg-[color-mix(in_srgb,var(--color-brand-primary)_88%,black)] hover:shadow-md"
                  >
                    {cta?.label ?? "Get Involved"}
                    <ArrowUpRight className="h-4 w-4 transition-transform group-hover:-translate-y-0.5 group-hover:translate-x-0.5" />
                  </Link>
                )}
              </>
            )}
          </div>

          {/* MOBILE MENU BUTTON */}
          <div className="flex items-center md:hidden">
            <button
              onClick={() => setIsOpen(!isOpen)}
              aria-label={isOpen ? "Close menu" : "Open menu"}
              aria-expanded={isOpen}
              aria-controls="mobile-navigation"
              className="rounded-xl p-2 text-gray-600 transition-colors hover:bg-green-50 hover:text-[var(--color-brand-primary)]"
            >
              {isOpen ? <X className="h-6 w-6" /> : <Menu className="h-6 w-6" />}
            </button>
          </div>
        </div>

        {/* MOBILE NAVIGATION — accordion (default) or drawer variant */}
        {isOpen && (
          <div
            id="mobile-navigation"
            ref={menuRef}
            className={
              mobileMenu === "drawer"
                ? "fixed inset-y-0 right-0 z-50 w-72 overflow-y-auto border-l border-gray-100 bg-white p-5 pt-20 shadow-2xl md:hidden"
                : "border-t border-gray-100 pb-5 pt-3 md:hidden"
            }
          >
            <div className="flex flex-col gap-1">
              {items.map((item) => {
                const href = safeChromeHref(item.href);
                if (!href) return null;
                return /^https?:\/\//i.test(href) ? (
                  <a
                    key={item.id}
                    href={href}
                    target="_blank"
                    rel="noopener noreferrer"
                    onClick={closeMenu}
                    className="group flex items-center justify-between rounded-xl px-4 py-3 text-sm font-medium text-gray-700 transition-colors hover:bg-green-50 hover:text-[var(--color-brand-primary)]"
                  >
                    <span>{item.label}</span>
                    <ArrowUpRight className="h-4 w-4 text-gray-300" />
                  </a>
                ) : (
                  <Link
                    key={item.id}
                    href={href}
                    onClick={closeMenu}
                    className="group flex items-center justify-between rounded-xl px-4 py-3 text-sm font-medium text-gray-700 transition-colors hover:bg-green-50 hover:text-[var(--color-brand-primary)]"
                  >
                    <span>{item.label}</span>
                    <ArrowUpRight className="h-4 w-4 text-gray-300 transition-colors group-hover:text-[var(--color-brand-primary)]" />
                  </Link>
                );
              })}

              {/* Mobile Account Actions */}
              <div className="mt-3 border-t border-gray-100 pt-4">
                {user ? (
                  <div className="space-y-2">
                    <Link
                      href="/portal/dashboard"
                      onClick={closeMenu}
                      className="flex items-center justify-center gap-2 rounded-xl bg-[var(--color-brand-primary)] px-4 py-3 text-sm font-bold text-white transition-colors hover:bg-[color-mix(in_srgb,var(--color-brand-primary)_88%,black)]"
                    >
                      <User className="h-4 w-4" />
                      Member Portal
                    </Link>

                    <button
                      onClick={handleLogout}
                      className="flex w-full items-center justify-center gap-2 rounded-xl px-4 py-3 text-sm font-semibold text-red-600 transition-colors hover:bg-red-50"
                    >
                      <LogOut className="h-4 w-4" />
                      Logout
                    </button>
                  </div>
                ) : (
                  <div className="space-y-2">
                    <Link
                      href="/login"
                      onClick={closeMenu}
                      className="block rounded-xl border border-[var(--color-brand-primary)]/20 px-4 py-3 text-center text-sm font-semibold text-[var(--color-brand-primary)] transition-colors hover:bg-green-50"
                    >
                      Sign In
                    </Link>

                    {ctaHref && (
                      <Link
                        href={ctaHref}
                        onClick={closeMenu}
                        className="flex items-center justify-center gap-2 rounded-xl bg-[var(--color-brand-primary)] px-4 py-3 text-sm font-bold text-white transition-colors hover:bg-[color-mix(in_srgb,var(--color-brand-primary)_88%,black)]"
                      >
                        {cta?.label ?? "Get Involved"}
                        <ArrowUpRight className="h-4 w-4" />
                      </Link>
                    )}
                  </div>
                )}
              </div>
            </div>
          </div>
        )}
      </nav>
    </header>
  );
}
