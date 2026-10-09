"use client";

/**
 * POLITICORE — Public SaaS Pricing (Phase 30, SaaS C) — STEP 1 of the
 * self-service journey.
 *
 * Identity-free commercial surface: renders the Phase 28 public plan
 * catalog (plan_catalog_public — plan CODE only, never version ids,
 * never platform-admin metadata). Selecting a plan continues into
 * tenant creation (/onboarding) with the plan code as the only
 * carried fact — the server resolves the ACTIVE version, price and
 * trial config at provisioning time.
 */
import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { Check, Loader2, Rocket, X } from "lucide-react";

import Header from "@/components/layout/Header";
import Footer from "@/components/layout/Footer";
import {
  getPlanCatalogPublic,
  PLAN_MODULE_LABELS,
  type PlanCatalogPublicRow,
  type PlanModule,
} from "@/lib/supabase";
import { formatMinor } from "@/lib/supabase/billing";

type Interval = "monthly" | "annual";

const FEATURE_LABELS: Record<string, string> = {
  governance_projects: "Governance projects",
  governance_participation: "Citizen participation",
  governance_accountability: "Accountability tracking",
  custom_domains: "Custom domains",
  advanced_analytics: "Advanced analytics",
};

export default function PricingPage() {
  const [plans, setPlans] = useState<PlanCatalogPublicRow[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [interval, setInterval] = useState<Interval>("monthly");
  const [selected, setSelected] = useState<string | null>(null);
  const router = useRouter();

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const rows = await getPlanCatalogPublic();
        if (!cancelled) setPlans(rows);
      } catch (e) {
        if (!cancelled) setError(e instanceof Error ? e.message : "Failed to load plans.");
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  const continueToOnboarding = () => {
    if (!selected) return;
    // Only the plan CODE travels — no version ids (§3).
    router.push(`/onboarding?plan=${encodeURIComponent(selected)}&interval=${interval}`);
  };

  return (
    <div className="min-h-screen bg-brand-surface flex flex-col">
      <Header />

      <main className="flex-1 px-4 py-12">
        <div className="mx-auto max-w-6xl">
          {/* Heading */}
          <div className="text-center mb-10">
            <div className="mx-auto mb-4 inline-flex h-14 w-14 items-center justify-center rounded-full bg-brand-primary">
              <Rocket className="h-7 w-7 text-white" />
            </div>

            <h1 className="text-3xl font-bold text-brand-primary sm:text-4xl">
              Run your political organization on PolitiCore
            </h1>

            <p className="mt-3 text-gray-600 max-w-2xl mx-auto">
              One platform for your campaign, social force, election operations and
              governance work. Start with a free trial — no payment method required.
            </p>

            {/* Interval toggle */}
            <div className="mt-8 inline-flex rounded-lg border border-gray-200 bg-white p-1 shadow-sm">
              {(["monthly", "annual"] as Interval[]).map((i) => (
                <button
                  key={i}
                  type="button"
                  onClick={() => setInterval(i)}
                  className={`rounded-md px-5 py-2 text-sm font-semibold capitalize transition-colors ${
                    interval === i
                      ? "bg-brand-primary text-white"
                      : "text-gray-600 hover:text-brand-primary"
                  }`}
                >
                  {i}
                  {i === "annual" && (
                    <span className="ml-2 text-xs font-bold text-emerald-600">2 months free</span>
                  )}
                </button>
              ))}
            </div>
          </div>

          {/* States */}
          {error && (
            <p className="mx-auto max-w-md rounded-lg bg-red-50 px-4 py-3 text-center text-sm text-red-700">
              {error}
            </p>
          )}

          {!plans && !error && (
            <div className="flex justify-center py-16">
              <Loader2 className="h-8 w-8 animate-spin text-brand-primary" />
            </div>
          )}

          {/* Plan cards */}
          {plans && (
            <>
              {plans.length === 0 ? (
                <p className="text-center text-gray-500">
                  No plans are currently available. Please check back soon.
                </p>
              ) : (
                <div
                  className={`grid gap-6 ${
                    plans.length === 1
                      ? "mx-auto max-w-md"
                      : plans.length === 2
                        ? "mx-auto max-w-3xl md:grid-cols-2"
                        : "md:grid-cols-3"
                  }`}
                >
                  {plans.map((plan) => {
                    const price = plan.prices[interval];
                    const isSelected = selected === plan.plan_code;

                    return (
                      <div
                        key={plan.plan_code}
                        className={`flex flex-col rounded-2xl bg-white p-8 shadow-lg transition-shadow ${
                          isSelected
                            ? "ring-2 ring-brand-primary"
                            : "hover:shadow-xl"
                        }`}
                      >
                        <h2 className="text-xl font-bold text-brand-primary">
                          {plan.plan_name}
                        </h2>

                        {plan.description && (
                          <p className="mt-2 min-h-[48px] text-sm text-gray-600">
                            {plan.description}
                          </p>
                        )}

                        <div className="mt-4">
                          {price === undefined ? (
                            <p className="text-sm text-gray-500">
                              Not available {interval === "annual" ? "annually" : "monthly"}
                            </p>
                          ) : (
                            <>
                              <p className="text-3xl font-bold text-gray-900">
                                {formatMinor(price, plan.currency)}
                                <span className="text-base font-medium text-gray-500">
                                  {" "}
                                  /{interval === "annual" ? "year" : "month"}
                                </span>
                              </p>
                              {plan.trial_enabled && plan.trial_days > 0 && (
                                <p className="mt-1 text-sm font-semibold text-emerald-600">
                                  {plan.trial_days}-day free trial — no card required
                                </p>
                              )}
                            </>
                          )}
                        </div>

                        {/* Modules */}
                        <div className="mt-6 border-t pt-5">
                          <p className="text-xs font-semibold uppercase tracking-wide text-gray-400">
                            Included modules
                          </p>
                          <ul className="mt-3 space-y-2">
                            {(Object.keys(PLAN_MODULE_LABELS) as PlanModule[]).map((m) => {
                              const included = plan.included_modules.includes(m);
                              return (
                                <li key={m} className="flex items-center gap-2 text-sm">
                                  {included ? (
                                    <>
                                      <Check className="h-4 w-4 shrink-0 text-emerald-600" />
                                      <span className="text-gray-700">
                                        {PLAN_MODULE_LABELS[m]}
                                      </span>
                                    </>
                                  ) : (
                                    <>
                                      <X className="h-4 w-4 shrink-0 text-gray-300" />
                                      <span className="text-gray-400 line-through">
                                        {PLAN_MODULE_LABELS[m]}
                                      </span>
                                    </>
                                  )}
                                </li>
                              );
                            })}
                          </ul>
                        </div>

                        {/* Features */}
                        {Object.entries(plan.feature_entitlements).some(([, v]) => v) && (
                          <div className="mt-5 border-t pt-5">
                            <p className="text-xs font-semibold uppercase tracking-wide text-gray-400">
                              Features
                            </p>
                            <ul className="mt-3 space-y-1.5">
                              {Object.entries(plan.feature_entitlements)
                                .filter(([, v]) => v)
                                .map(([k]) => (
                                  <li key={k} className="flex items-center gap-2 text-sm text-gray-700">
                                    <Check className="h-4 w-4 shrink-0 text-emerald-600" />
                                    {FEATURE_LABELS[k] ?? k}
                                  </li>
                                ))}
                            </ul>
                          </div>
                        )}

                        {/* Select */}
                        <div className="mt-auto pt-6">
                          <button
                            type="button"
                            disabled={price === undefined}
                            onClick={() => setSelected(plan.plan_code)}
                            className={`w-full rounded-lg py-3 font-semibold transition-colors disabled:cursor-not-allowed disabled:opacity-50 ${
                              isSelected
                                ? "bg-emerald-600 text-white"
                                : "bg-brand-primary text-white hover:opacity-90"
                            }`}
                          >
                            {isSelected
                              ? "Selected"
                              : price === undefined
                                ? "Unavailable"
                                : "Choose plan"}
                          </button>
                        </div>
                      </div>
                    );
                  })}
                </div>
              )}

              {/* Continue */}
              {selected && (
                <div className="mt-10 text-center">
                  <button
                    type="button"
                    onClick={continueToOnboarding}
                    className="rounded-lg bg-brand-primary px-10 py-4 text-lg font-semibold text-white transition-colors hover:opacity-90"
                  >
                    Continue — create your organization &rarr;
                  </button>
                </div>
              )}
            </>
          )}
        </div>
      </main>

      <Footer />
    </div>
  );
}
