"use client";

import { useState } from "react";
import Link from "next/link";
import { Menu, X, User, Bell, LogOut, ArrowUpRight } from "lucide-react";
import { useAuth } from "@/contexts/AuthContext";
import { getSupabaseClient, logOut } from "@/lib/supabase";
import Image from "next/image";

export default function Header() {
  const [isOpen, setIsOpen] = useState(false);
  const { user } = useAuth();

  const handleLogout = async () => {
    await logOut(getSupabaseClient());
    setIsOpen(false);
  };

  const closeMenu = () => setIsOpen(false);

  return (
    <header className="sticky top-0 z-50 bg-white shadow-[0_2px_20px_rgba(0,0,0,0.06)]">
      {/* Campaign accent */}
      <div className="flex h-1 w-full">
        <div className="w-1/3 bg-[#008751]" />
        <div className="w-1/3 bg-white" />
        <div className="w-1/3 bg-[#008751]" />
      </div>

      <nav className="mx-auto max-w-7xl px-4 sm:px-6 lg:px-8">
        <div className="flex h-[76px] items-center justify-between">
          {/* =====================================================
              BRAND
          ===================================================== */}
          <div className="shrink-0">
            <Link
              href="/"
              onClick={closeMenu}
              className="group flex items-center gap-3"
            >
              {/* Campaign Logo */}
              <div className="relative flex h-11 w-11 items-center justify-center overflow-hidden rounded-xl border border-gray-100 bg-white shadow-sm transition-all duration-300 group-hover:shadow-md">
                <Image
                  src="/images/official_logo.jpeg"
                  alt="Uche Geoffrey Nnaji"
                  fill
                  sizes="44px"
                  className="object-contain p-1"
                />
              </div>

              {/* Campaign Name */}
              <div className="leading-none">
                <div className="flex items-center gap-1">
                  <span className="text-lg font-extrabold tracking-tight text-[#008751] sm:text-xl">
                    Uche
                  </span>
                  <span className="text-lg font-extrabold text-[#d71920] sm:text-xl">
                    Ndi
                  </span>
                  <span className="text-lg font-extrabold text-gray-800 sm:text-xl">
                    Enugu
                  </span>
                </div>

                <span className="mt-1 block text-[10px] font-semibold uppercase tracking-[0.16em] text-gray-400 sm:text-[11px]">
                  Governorship • Enugu • 2027
                </span>
              </div>
            </Link>
          </div>

          {/* =====================================================
              DESKTOP NAVIGATION
          ===================================================== */}
          <div className="hidden items-center gap-7 md:flex">
            <Link
              href="/"
              className="text-sm font-medium text-gray-600 transition-colors hover:text-[#008751]"
            >
              Home
            </Link>

            <Link
              href="/biography"
              className="text-sm font-medium text-gray-600 transition-colors hover:text-[#008751]"
            >
              Biography
            </Link>

            <Link
              href="/manifesto"
              className="text-sm font-medium text-gray-600 transition-colors hover:text-[#008751]"
            >
              Our Agenda
            </Link>

            <Link
              href="/news"
              className="text-sm font-medium text-gray-600 transition-colors hover:text-[#008751]"
            >
              News
            </Link>

            <Link
              href="/gallery"
              className="text-sm font-medium text-gray-600 transition-colors hover:text-[#008751]"
            >
              Gallery
            </Link>

            <Link
              href="/contact"
              className="text-sm font-medium text-gray-600 transition-colors hover:text-[#008751]"
            >
              Contact
            </Link>
          </div>

          {/* =====================================================
              DESKTOP ACTIONS
          ===================================================== */}
          <div className="hidden items-center gap-4 md:flex">
            {user ? (
              <>
                {/* Notifications */}
                <button
                  aria-label="Notifications"
                  className="relative rounded-full p-2 text-gray-500 transition-colors hover:bg-green-50 hover:text-[#008751]"
                >
                  <Bell className="h-5 w-5" />

                  <span className="absolute right-0.5 top-0.5 flex h-4 w-4 items-center justify-center rounded-full bg-[#008751] text-[9px] font-bold text-white">
                    3
                  </span>
                </button>

                {/* Portal */}
                <Link
                  href="/portal/dashboard"
                  className="flex items-center gap-2 rounded-full bg-[#008751] px-5 py-2.5 text-sm font-bold text-white shadow-sm transition-all hover:bg-[#007744] hover:shadow-md"
                >
                  <User className="h-4 w-4" />
                  <span>Portal</span>
                </Link>

                {/* Logout */}
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
                  className="text-sm font-semibold text-[#008751] transition-colors hover:text-[#006b40]"
                >
                  Log In
                </Link>

                <Link
                  href="/volunteer"
                  className="group flex items-center gap-2 rounded-full bg-[#008751] px-5 py-2.5 text-sm font-bold text-white shadow-sm transition-all hover:bg-[#007744] hover:shadow-md"
                >
                  Get Involved
                  <ArrowUpRight className="h-4 w-4 transition-transform group-hover:-translate-y-0.5 group-hover:translate-x-0.5" />
                </Link>
              </>
            )}
          </div>

          {/* =====================================================
              MOBILE MENU BUTTON
          ===================================================== */}
          <div className="flex items-center md:hidden">
            <button
              onClick={() => setIsOpen(!isOpen)}
              aria-label={isOpen ? "Close menu" : "Open menu"}
              aria-expanded={isOpen}
              className="rounded-xl p-2 text-gray-600 transition-colors hover:bg-green-50 hover:text-[#008751]"
            >
              {isOpen ? (
                <X className="h-6 w-6" />
              ) : (
                <Menu className="h-6 w-6" />
              )}
            </button>
          </div>
        </div>

        {/* =====================================================
            MOBILE NAVIGATION
        ===================================================== */}
        {isOpen && (
          <div className="border-t border-gray-100 pb-5 pt-3 md:hidden">
            <div className="flex flex-col gap-1">
              {[
                ["Home", "/"],
                ["Biography", "/biography"],
                ["Our Agenda", "/manifesto"],
                ["News", "/news"],
                ["Gallery", "/gallery"],
                ["Contact", "/contact"],
              ].map(([label, href]) => (
                <Link
                  key={href}
                  href={href}
                  onClick={closeMenu}
                  className="group flex items-center justify-between rounded-xl px-4 py-3 text-sm font-medium text-gray-700 transition-colors hover:bg-green-50 hover:text-[#008751]"
                >
                  <span>{label}</span>

                  <ArrowUpRight className="h-4 w-4 text-gray-300 transition-colors group-hover:text-[#008751]" />
                </Link>
              ))}

              {/* Mobile Account Actions */}
              <div className="mt-3 border-t border-gray-100 pt-4">
                {user ? (
                  <div className="space-y-2">
                    <Link
                      href="/portal/dashboard"
                      onClick={closeMenu}
                      className="flex items-center justify-center gap-2 rounded-xl bg-[#008751] px-4 py-3 text-sm font-bold text-white transition-colors hover:bg-[#007744]"
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
                      className="block rounded-xl border border-[#008751]/20 px-4 py-3 text-center text-sm font-semibold text-[#008751] transition-colors hover:bg-green-50"
                    >
                      Sign In
                    </Link>

                    <Link
                      href="/volunteer"
                      onClick={closeMenu}
                      className="flex items-center justify-center gap-2 rounded-xl bg-[#008751] px-4 py-3 text-sm font-bold text-white transition-colors hover:bg-[#007744]"
                    >
                      Get Involved
                      <ArrowUpRight className="h-4 w-4" />
                    </Link>
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
