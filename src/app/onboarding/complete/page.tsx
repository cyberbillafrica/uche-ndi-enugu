"use client";

/**
 * POLITICORE — Onboarding Completion (Phase 30, SaaS C) — STEP 3.
 *
 * Collects tenant name/slug/owner name and calls the single atomic
 * SECURITY DEFINER RPC (complete_tenant_onboarding): tenant + module
 * defaults + default config + owner profile (tenant_super_admin) +
 * subscription/trial + entitlement sync + audit — all server-side.
 *
 * Slug availability is checked server-side for UX; the database (the
 * RPC + the 0001 UNIQUE constraint) remains authoritative. Resume is
 * never inferred from localStorage or query params — after signup the
 * user can always return via /onboarding/resume.
 */
import { Suspense, useCallback, useEffect, useRef, useState } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import Link from "next/link";
import { CheckCircle2, Loader2, Rocket, XCircle } from "lucide-react";

import { useToast } from "@/components/ui/toast";
import { getSupabaseClient } from "@/lib/supabase";
import {
  checkTenantSlugAvailability,
  completeTenantOnboarding,
  type SlugAvailability,
} from "@/lib/supabase/onboarding";
import type { BillingInterval } from "@/lib/supabase/billing";
import Header from "@/components/layout/Header";
import Footer from "@/components/layout/Footer";

function slugify(raw: string): string {
  return raw
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9-]+/g, "-")
    .replace(/-{2,}/g, "-")
    .replace(/^-+|-+$/g, "");
}

function OnboardingCompleteForm() {
  const search = useSearchParams();
  const router = useRouter();
  const toast = useToast();

  const planCode = search.get("plan") ?? "starter";
  const billingInterval: BillingInterval =
    search.get("interval") === "annual" ? "annual" : "monthly";

  const [tenantName, setTenantName] = useState("");
  const [slug, setSlug] = useState("");
  const [slugTouched, setSlugTouched] = useState(false);
  const [ownerName, setOwnerName] = useState("");
  const [availability, setAvailability] = useState<SlugAvailability | null>(null);
  const [checkingSlug, setCheckingSlug] = useState(false);
  const [provisioning, setProvisioning] = useState(false);
  const [result, setResult] = useState<{
    subscriptionStatus: string;
    trialEnd: string | null;
    nextStep: string;
  } | null>(null);

  // Server-authoritative availability (debounced). UX only — the RPC
  // re-validates and the UNIQUE constraint is the concurrency backstop.
  const checkAvailability = useCallback(async (candidate: string) => {
    if (!candidate) {
      setAvailability(null);
      return;
    }
    setCheckingSlug(true);
    try {
      const r = await checkTenantSlugAvailability(candidate);
      setAvailability(r);
    } catch {
      setAvailability(null); // transient — the RPC is the real gate
    } finally {
      setCheckingSlug(false);
    }
  }, []);

  const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const onSlugChange = (raw: string) => {
    setSlugTouched(true);
    setSlug(slugify(raw));
    if (debounceRef.current) clearTimeout(debounceRef.current);
    const next = slugify(raw);
    debounceRef.current = setTimeout(() => void checkAvailability(next), 400);
  };

  useEffect(() => {
    return () => {
      if (debounceRef.current) clearTimeout(debounceRef.current);
    };
  }, []);

  // §11 resume: an already-provisioned session must not re-provision.
  // The server decides — never client state.
  useEffect(() => {
    void (async () => {
      try {
        const { data } = await getSupabaseClient().auth.getSession();
        if (!data.session?.user) return; // anon → step 3 needs signup first
        const { getOnboardingState } = await import("@/lib/supabase/onboarding");
        const state = await getOnboardingState();
        if (state?.stage === "enter_app" || state?.stage === "existing_tenant") {
          router.replace("/onboarding/resume");
        }
      } catch {
        /* the RPC gate re-validates on submit anyway */
      }
    })();
  }, [router]);

  const handleSubmit = async (e: React.FormEvent<HTMLFormElement>) => {
    e.preventDefault();

    if (availability && !availability.available) {
      toast.error(`The address "${slug}" is not available — ${availability.reason}.`);
      return;
    }

    setProvisioning(true);

    try {
      const r = await completeTenantOnboarding({
        tenantSlug: slug,
        tenantName,
        ownerName: ownerName || undefined,
        planCode,
        billingInterval,
      });
      setResult({
        subscriptionStatus: r.subscriptionStatus,
        trialEnd: r.trialEnd,
        nextStep: r.nextStep,
      });
    } catch (err) {
      const message = err instanceof Error ? err.message : "Provisioning failed.";
      if (message.includes("already belongs to a tenant")) {
        toast.error("This account already belongs to a tenant. Continuing to your portal…");
        router.replace("/onboarding/resume");
        return;
      }
      toast.error(message);
    } finally {
      setProvisioning(false);
    }
  };

  // ── Success panel: trial messaging (§8) ─────────────────────────────
  if (result) {
    const trialEnd = result.trialEnd ? new Date(result.trialEnd) : null;
    return (
      <div className="w-full max-w-lg">
        <div className="rounded-2xl bg-white p-8 text-center shadow-lg">
          <div className="mx-auto mb-4 flex h-16 w-16 items-center justify-center rounded-full bg-emerald-100">
            <CheckCircle2 className="h-9 w-9 text-emerald-600" />
          </div>

          <h1 className="text-3xl font-bold text-brand-primary">You&apos;re all set!</h1>

          <p className="mt-3 text-gray-600">
            Your organization{" "}
            <span className="font-semibold text-gray-900">{tenantName}</span> is ready at{" "}
            <span className="font-semibold text-brand-primary">{slug}</span>.
          </p>

          <div className="mt-6 rounded-xl bg-sky-50 p-5 text-left">
            <p className="text-sm font-semibold text-sky-900">Free trial active</p>
            <ul className="mt-2 space-y-1 text-sm text-sky-800">
              <li>
                Plan: <span className="font-semibold capitalize">{planCode}</span> ·{" "}
                <span className="font-semibold capitalize">{billingInterval}</span> billing
              </li>
              {result.subscriptionStatus === "trialing" && trialEnd && (
                <li>
                  Trial ends: <span className="font-semibold">{trialEnd.toLocaleDateString()}</span>
                </li>
              )}
              <li>
                No payment method on file —{" "}
                <span className="font-semibold">you will never be charged automatically</span>.
                When the trial ends you choose whether to subscribe.
              </li>
            </ul>
          </div>

          <button
            type="button"
            onClick={() => router.push("/portal/dashboard")}
            className="mt-6 w-full rounded-lg bg-brand-primary py-3 font-semibold text-white transition-colors hover:opacity-90"
          >
            Enter your dashboard →
          </button>
        </div>
      </div>
    );
  }

  // ── Form ────────────────────────────────────────────────────────────
  const slugState = availability
    ? availability.available
      ? "ok"
      : "bad"
    : null;

  return (
    <div className="w-full max-w-md">
      <div className="rounded-2xl bg-white p-8 shadow-lg">
        <div className="mb-8 text-center">
          <div className="mx-auto mb-4 flex h-14 w-14 items-center justify-center rounded-full bg-brand-primary">
            <Rocket className="h-7 w-7 text-white" />
          </div>

          <h1 className="text-3xl font-bold text-brand-primary">
            Set up your organization
          </h1>

          <p className="mt-2 text-gray-600">Step 3 of 3 — the final step</p>

          <p className="mt-4 rounded-lg bg-brand-primary/5 px-4 py-2 text-sm text-gray-600">
            Plan:{" "}
            <span className="font-semibold capitalize text-brand-primary">
              {planCode} · {billingInterval}
            </span>
          </p>
        </div>

        <form onSubmit={handleSubmit} className="space-y-5">
          <div>
            <label htmlFor="tenantName" className="mb-2 block text-sm font-medium text-gray-700">
              Organization Name
            </label>
            <input
              id="tenantName"
              type="text"
              value={tenantName}
              onChange={(e) => {
                setTenantName(e.target.value);
                // Auto-suggest the slug until the user edits it manually.
                if (!slugTouched) setSlug(slugify(e.target.value));
              }}
              placeholder="Acme Campaign Organization"
              className="w-full rounded-lg border border-gray-300 px-4 py-3
                         focus:border-transparent focus:outline-none focus:ring-2
                         focus:ring-brand-primary"
              required
              maxLength={80}
            />
          </div>

          <div>
            <label htmlFor="slug" className="mb-2 block text-sm font-medium text-gray-700">
              Organization Address
            </label>
            <div className="flex items-center">
              <span className="rounded-l-lg border border-r-0 border-gray-300 bg-gray-50 px-3 py-3 text-sm text-gray-500">
                politicore.ng/
              </span>
              <input
                id="slug"
                type="text"
                value={slug}
                onChange={(e) => onSlugChange(e.target.value)}
                placeholder="acme-campaign"
                className="w-full rounded-r-lg border border-gray-300 px-4 py-3
                           focus:border-transparent focus:outline-none focus:ring-2
                           focus:ring-brand-primary"
                required
                maxLength={48}
              />
            </div>

            {checkingSlug && (
              <p className="mt-2 flex items-center gap-2 text-xs text-gray-500">
                <Loader2 className="h-3 w-3 animate-spin" /> Checking availability…
              </p>
            )}

            {!checkingSlug && slugState === "ok" && (
              <p className="mt-2 flex items-center gap-1 text-xs font-semibold text-emerald-600">
                <CheckCircle2 className="h-3.5 w-3.5" /> Available
              </p>
            )}

            {!checkingSlug && slugState === "bad" && availability && (
              <p className="mt-2 flex items-center gap-1 text-xs font-semibold text-red-600">
                <XCircle className="h-3.5 w-3.5" /> {availability.reason}
              </p>
            )}
          </div>

          <div>
            <label htmlFor="ownerName" className="mb-2 block text-sm font-medium text-gray-700">
              Your Name <span className="font-normal text-gray-400">(optional)</span>
            </label>
            <input
              id="ownerName"
              type="text"
              value={ownerName}
              onChange={(e) => setOwnerName(e.target.value)}
              placeholder="Ifeanyi Barth"
              className="w-full rounded-lg border border-gray-300 px-4 py-3
                         focus:border-transparent focus:outline-none focus:ring-2
                         focus:ring-brand-primary"
              maxLength={80}
            />
          </div>

          <button
            type="submit"
            disabled={
              provisioning ||
              checkingSlug ||
              (slugState === "bad")
            }
            className="w-full rounded-lg bg-brand-primary py-3 font-semibold text-white
                       transition-colors hover:opacity-90 disabled:cursor-not-allowed disabled:opacity-50"
          >
            {provisioning ? "Creating your organization..." : "Create organization & start trial"}
          </button>

          <p className="text-center text-xs text-gray-500">
            Your 14-day free trial starts immediately. No card required, no automatic
            charges — ever.
          </p>

          <div className="text-center text-sm">
            <Link
              href="/onboarding/resume"
              className="text-gray-500 hover:text-brand-primary hover:underline"
            >
              Already started? Resume your setup →
            </Link>
          </div>
        </form>
      </div>
    </div>
  );
}

export default function OnboardingCompletePage() {
  return (
    <div className="flex min-h-screen flex-col bg-brand-surface">
      <Header />

      <main className="flex flex-1 items-center justify-center px-4 py-12">
        <Suspense
          fallback={
            <div className="h-8 w-8 animate-spin rounded-full border-4 border-brand-primary/20 border-t-brand-primary" />
          }
        >
          <OnboardingCompleteForm />
        </Suspense>
      </main>

      <Footer />
    </div>
  );
}
