"use client";

/**
 * POLITICORE — Onboarding Resume (Phase 30, SaaS C) — §11 recovery.
 *
 * The journey position is resolved EXCLUSIVELY by the server
 * (onboarding_state RPC) from the session + database. Never from
 * localStorage, query params or client flags. Every stage routes the
 * user to the correct next step:
 *
 *   signin           → /onboarding           (create the bare identity)
 *   create_tenant    → /onboarding/complete  (finish provisioning)
 *   enter_app        → /portal/dashboard     (live subscription)
 *   existing_tenant  → /portal/dashboard     (member of an existing tenant)
 */
import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import Link from "next/link";

import { getSupabaseClient, logOut } from "@/lib/supabase";
import { getOnboardingState, type OnboardingStateRow } from "@/lib/supabase/onboarding";
import Header from "@/components/layout/Header";
import Footer from "@/components/layout/Footer";

export default function OnboardingResumePage() {
  const router = useRouter();
  const [state, setState] = useState<OnboardingStateRow | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [resolved, setResolved] = useState(false);

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const s = await getOnboardingState();
        if (cancelled) return;

        // No session at all client-side → the server will report stage
        // `signin`; route to signup.
        const { data } = await getSupabaseClient().auth.getSession();
        if (!data.session?.user) {
          router.replace("/onboarding");
          return;
        }

        switch (s?.stage) {
          case "signin":
            router.replace("/onboarding");
            return;
          case "create_tenant":
            setState(s);
            break;
          case "enter_app":
          case "existing_tenant":
            router.replace("/portal/dashboard");
            return;
          default:
            router.replace("/onboarding");
            return;
        }
      } catch (e) {
        if (!cancelled) {
          setError(e instanceof Error ? e.message : "Unable to determine your journey state.");
        }
      } finally {
        if (!cancelled) setResolved(true);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [router]);

  const handleSignOutAndRestart = async () => {
    await logOut(getSupabaseClient());
    router.replace("/onboarding");
  };

  return (
    <div className="flex min-h-screen flex-col bg-brand-surface">
      <Header />

      <main className="flex flex-1 items-center justify-center px-4 py-12">
        {!resolved && (
          <div className="flex flex-col items-center gap-3">
            <div className="h-8 w-8 animate-spin rounded-full border-4 border-brand-primary/20 border-t-brand-primary" />
            <p className="text-sm text-gray-500">Checking your setup…</p>
          </div>
        )}

        {resolved && error && (
          <div className="w-full max-w-md rounded-2xl bg-white p-8 text-center shadow-lg">
            <p className="text-red-600">{error}</p>
            <Link
              href="/"
              className="mt-4 inline-block font-semibold text-brand-primary hover:underline"
            >
              Back to home
            </Link>
          </div>
        )}

        {resolved && !error && state?.stage === "create_tenant" && (
          <div className="w-full max-w-md">
            <div className="rounded-2xl bg-white p-8 shadow-lg">
              <h1 className="text-2xl font-bold text-brand-primary">
                Welcome back
              </h1>

              <p className="mt-2 text-gray-600">
                Your account <span className="font-semibold">{state.tenantName ?? ""}</span>{" "}
                was created, but the organization setup isn&apos;t finished yet.
              </p>

              {state.tenantSlug && (
                <div className="mt-5 rounded-xl bg-gray-50 p-4 text-sm">
                  <p className="text-gray-500">Reserved address</p>
                  <p className="font-semibold text-brand-primary">{state.tenantSlug}</p>
                </div>
              )}

              <button
                type="button"
                onClick={() => router.push("/onboarding/complete")}
                className="mt-6 w-full rounded-lg bg-brand-primary py-3 font-semibold text-white transition-colors hover:opacity-90"
              >
                Continue setup →
              </button>

              <button
                type="button"
                onClick={handleSignOutAndRestart}
                className="mt-3 w-full rounded-lg border border-gray-200 py-2.5 text-sm text-gray-600 transition-colors hover:bg-gray-50"
              >
                Not you? Sign out and start over
              </button>
            </div>
          </div>
        )}
      </main>

      <Footer />
    </div>
  );
}
