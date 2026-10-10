"use client";

/**
 * POLITICORE — Forgot password (Auth Repair).
 *
 * Requests a password-recovery email through the canonical client. The
 * response is deliberately NEUTRAL: request failures and success render
 * the same user-facing outcome, so the page never discloses whether an
 * email address has an account. The redirect lands on the canonical
 * callback route, which then hands off to /reset-password.
 *
 * No recovery token/OTP is logged or rendered beyond the neutral text.
 */
import { useState } from "react";
import Link from "next/link";
import { KeyRound, MailCheck } from "lucide-react";

import Header from "@/components/layout/Header";
import Footer from "@/components/layout/Footer";
import { getSupabaseClient } from "@/lib/supabase/config";
import { AUTH_CALLBACK_PATH } from "@/lib/supabase/authLinks";

export default function ForgotPasswordPage() {
  const [email, setEmail] = useState("");
  const [submitted, setSubmitted] = useState(false);
  const [loading, setLoading] = useState(false);

  const handleSubmit = async (e: React.FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    setLoading(true);

    try {
      // emailRedirectTo is the canonical callback; the callback route
      // advances to /reset-password only after verification succeeds.
      await getSupabaseClient().auth.resetPasswordForEmail(email, {
        redirectTo: `${window.location.origin}${AUTH_CALLBACK_PATH}?type=recovery&next=${encodeURIComponent("/reset-password")}`,
      });
    } catch {
      // Swallowed on purpose — neutral outcome either way.
    } finally {
      setSubmitted(true);
      setLoading(false);
    }
  };

  return (
    <div className="min-h-screen bg-brand-surface flex flex-col">
      <Header />

      <main className="flex-1 flex items-center justify-center px-4 py-12">
        <div className="w-full max-w-md">
          {submitted ? (
            <div className="bg-white rounded-2xl shadow-lg p-8 text-center">
              <div className="mx-auto mb-4 flex h-14 w-14 items-center justify-center rounded-full bg-emerald-100">
                <MailCheck className="h-7 w-7 text-emerald-600" />
              </div>
              <h1 className="text-2xl font-bold text-brand-primary">
                Check your email
              </h1>
              <p className="mt-3 text-gray-600">
                If an account exists for this address, a password-reset link
                has been sent. The link expires after a short time — request a
                new one if it expires.
              </p>
              <Link
                href="/login"
                className="mt-6 inline-block rounded-lg bg-brand-primary px-6 py-3 font-semibold text-white hover:opacity-90"
              >
                Back to sign in
              </Link>
            </div>
          ) : (
            <div className="bg-white rounded-2xl shadow-lg p-8">
              <div className="text-center mb-8">
                <div className="mx-auto mb-4 flex h-14 w-14 items-center justify-center rounded-full bg-brand-surface">
                  <KeyRound className="h-7 w-7 text-brand-primary" />
                </div>
                <h1 className="text-3xl font-bold text-brand-primary">
                  Forgot password
                </h1>
                <p className="mt-2 text-gray-600">
                  Enter your email address and we&apos;ll send you a reset link.
                </p>
              </div>

              <form onSubmit={handleSubmit} className="space-y-5">
                <div>
                  <label
                    htmlFor="email"
                    className="block text-sm font-medium text-gray-700 mb-2"
                  >
                    Email Address
                  </label>
                  <input
                    id="email"
                    type="email"
                    value={email}
                    onChange={(e) => setEmail(e.target.value)}
                    placeholder="you@example.com"
                    autoComplete="email"
                    required
                    className="w-full px-4 py-3 rounded-lg border border-gray-300
                               focus:outline-none focus:ring-2
                               focus:ring-brand-primary focus:border-transparent"
                  />
                </div>

                <button
                  type="submit"
                  disabled={loading}
                  className="w-full bg-brand-primary text-white py-3 rounded-lg
                             font-semibold hover:opacity-90 transition-colors
                             disabled:opacity-50 disabled:cursor-not-allowed"
                >
                  {loading ? "Sending…" : "Send reset link"}
                </button>
              </form>

              <div className="mt-6 text-center text-sm text-gray-600">
                Remembered it?{" "}
                <Link
                  href="/login"
                  className="font-semibold text-brand-primary hover:underline"
                >
                  Back to sign in
                </Link>
              </div>
            </div>
          )}
        </div>
      </main>

      <Footer />
    </div>
  );
}
