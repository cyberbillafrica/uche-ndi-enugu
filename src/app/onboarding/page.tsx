"use client";

/**
 * POLITICORE — Tenant Owner Signup (Phase 30, SaaS C) — STEP 2 of the
 * self-service journey.
 *
 * Creates a BARE Supabase Auth identity (no tenant_slug metadata → no
 * profile via the 0007 trigger). The onboarding completion step then
 * provisions tenant + owner authority server-side in ONE atomic RPC.
 * An interrupted journey is recovered by /onboarding/resume — the
 * server (onboarding_state) decides where the user actually is.
 */
import { Suspense, useEffect, useState } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import Link from "next/link";
import { Eye, EyeOff, UserPlus } from "lucide-react";

import { useToast } from "@/components/ui/toast";
import { getSupabaseClient, signUpBareIdentity } from "@/lib/supabase";
import Header from "@/components/layout/Header";
import Footer from "@/components/layout/Footer";

function OnboardingSignupForm() {
  const search = useSearchParams();
  const router = useRouter();
  const toast = useToast();

  // Plan facts carried from /pricing (presentation only — the RPC
  // re-resolves the plan from the CODE server-side).
  const planCode = search.get("plan") ?? "starter";
  const interval = search.get("interval") === "annual" ? "annual" : "monthly";

  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [showPassword, setShowPassword] = useState(false);
  const [loading, setLoading] = useState(false);
  const [checking, setChecking] = useState(true);

  // §11 resume: if this browser already has a session, let the server
  // say where the journey stands instead of creating a duplicate identity.
  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const { data } = await getSupabaseClient().auth.getSession();
        if (!cancelled && data.session?.user) {
          router.replace("/onboarding/resume");
          return;
        }
      } catch {
        /* fall through to the signup form */
      }
      if (!cancelled) setChecking(false);
    })();
    return () => {
      cancelled = true;
    };
  }, [router]);

  const handleSubmit = async (e: React.FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    setLoading(true);

    const { error } = await signUpBareIdentity(email, password, getSupabaseClient());

    if (error) {
      toast.error(getSignupErrorMessage(error));
      setLoading(false);
      return;
    }

    // Session established → complete tenant creation server-side.
    router.push(
      `/onboarding/complete?plan=${encodeURIComponent(planCode)}&interval=${interval}`,
    );
  };

  if (checking) {
    return (
      <div className="flex justify-center py-16">
        <div className="h-8 w-8 animate-spin rounded-full border-4 border-brand-primary/20 border-t-brand-primary" />
      </div>
    );
  }

  return (
    <div className="w-full max-w-md">
      <div className="rounded-2xl bg-white p-8 shadow-lg">
        <div className="mb-8 text-center">
          <div className="mx-auto mb-4 flex h-14 w-14 items-center justify-center rounded-full bg-brand-primary">
            <UserPlus className="h-7 w-7 text-white" />
          </div>

          <h1 className="text-3xl font-bold text-brand-primary">Create your account</h1>

          <p className="mt-2 text-gray-600">
            Step 2 of 3 — your organization details come next
          </p>

          <p className="mt-4 rounded-lg bg-brand-primary/5 px-4 py-2 text-sm text-gray-600">
            Selected plan:{" "}
            <span className="font-semibold capitalize text-brand-primary">
              {planCode} · {interval}
            </span>
          </p>
        </div>

        <form onSubmit={handleSubmit} className="space-y-5">
          <div>
            <label htmlFor="email" className="mb-2 block text-sm font-medium text-gray-700">
              Work Email
            </label>
            <input
              id="email"
              type="email"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              placeholder="you@yourorganization.org"
              autoComplete="email"
              className="w-full rounded-lg border border-gray-300 px-4 py-3
                         focus:border-transparent focus:outline-none focus:ring-2
                         focus:ring-brand-primary"
              required
            />
          </div>

          <div>
            <label htmlFor="password" className="mb-2 block text-sm font-medium text-gray-700">
              Password
            </label>
            <div className="relative">
              <input
                id="password"
                type={showPassword ? "text" : "password"}
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                placeholder="At least 8 characters"
                autoComplete="new-password"
                className="w-full rounded-lg border border-gray-300 px-4 py-3 pr-12
                           focus:border-transparent focus:outline-none focus:ring-2
                           focus:ring-brand-primary"
                minLength={8}
                required
              />
              <button
                type="button"
                onClick={() => setShowPassword((p) => !p)}
                aria-label={showPassword ? "Hide password" : "Show password"}
                className="absolute right-3 top-1/2 -translate-y-1/2 rounded-md p-1
                           text-gray-500 transition-colors hover:text-brand-primary"
              >
                {showPassword ? <EyeOff className="h-5 w-5" /> : <Eye className="h-5 w-5" />}
              </button>
            </div>
          </div>

          <button
            type="submit"
            disabled={loading}
            className="w-full rounded-lg bg-brand-primary py-3 font-semibold text-white
                       transition-colors hover:opacity-90 disabled:cursor-not-allowed disabled:opacity-50"
          >
            {loading ? "Creating account..." : "Create account & continue"}
          </button>
        </form>

        <div className="mt-6 text-center text-sm text-gray-600">
          Already have an account?{" "}
          <Link href="/login" className="font-semibold text-brand-primary hover:underline">
            Sign in
          </Link>
        </div>
      </div>
    </div>
  );
}

function getSignupErrorMessage(error: string): string {
  if (error.includes("already registered") || error.includes("already exists")) {
    return "An account with this email already exists. Sign in instead — your journey will resume where you left off.";
  }
  if (error.includes("Password") && error.toLowerCase().includes("short")) {
    return "Your password is too short. Please use at least 8 characters.";
  }
  if (error.includes("rate limit") || error.includes("Too many")) {
    return "Too many attempts. Please wait a moment and try again.";
  }
  if (error.includes("network")) {
    return "Network error. Please check your internet connection and try again.";
  }
  return "Unable to create your account. Please try again.";
}

export default function OnboardingSignupPage() {
  return (
    <div className="flex min-h-screen flex-col bg-brand-surface">
      <Header />

      <main className="flex flex-1 items-center justify-center px-4 py-12">
        <Suspense
          fallback={
            <div className="h-8 w-8 animate-spin rounded-full border-4 border-brand-primary/20 border-t-brand-primary" />
          }
        >
          <OnboardingSignupForm />
        </Suspense>
      </main>

      <Footer />
    </div>
  );
}
