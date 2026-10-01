"use client";

import { useEffect, useState } from "react";
import Header from "@/components/layout/Header";
import Footer from "@/components/layout/Footer";
import { Inbox, ShieldCheck, CheckCircle2, Loader2 } from "lucide-react";
import {
  listPublicIntakeCategories,
  submitPublicIntake,
  verifyPublicIntake,
  PublicIntakeError,
  listLgas,
  listWards,
  listPollingUnits,
  type GeoLga,
  type GeoWard,
  type GeoPollingUnit,
} from "@/lib/supabase";

/**
 * POLITICORE — PUBLIC GOVERNANCE INTAKE (Phase 10, first slice).
 *
 * Minimal public submission surface over the three approved SECURITY
 * DEFINER RPCs (0037/0038). The browser sends NO authority values —
 * no tenant id, no actor, no status, no visibility flags — and never
 * touches a governance table. The verification code is delivered by
 * email only; the tracking secret is shown exactly once below and is
 * the case's credential (the reference alone identifies nothing).
 */
export default function PublicRequestPage() {
  const siteSlug = process.env.NEXT_PUBLIC_SITE_SLUG ?? "ifeanyi-2027";

  // ── Form state ──────────────────────────────────────────────────────
  const [categories, setCategories] = useState<string[]>([]);
  const [lgas, setLgas] = useState<GeoLga[]>([]);
  const [wards, setWards] = useState<GeoWard[]>([]);
  const [pus, setPus] = useState<GeoPollingUnit[]>([]);

  const [fullName, setFullName] = useState("");
  const [email, setEmail] = useState("");
  const [category, setCategory] = useState("");
  const [subject, setSubject] = useState("");
  const [description, setDescription] = useState("");
  const [lgaId, setLgaId] = useState("");
  const [wardId, setWardId] = useState("");
  const [pollingUnitId, setPollingUnitId] = useState("");
  const [consent, setConsent] = useState(false);

  const [loaded, setLoaded] = useState(false);
  const [stage, setStage] = useState<"form" | "verify" | "done">("form");
  const [token, setToken] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [formError, setFormError] = useState<string | null>(null);
  const [verifyError, setVerifyError] = useState<string | null>(null);
  const [result, setResult] = useState<{ ref: string; secret: string } | null>(
    null
  );

  // ── Load form inputs (active category names + Core Geography) ───────
  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const [cats, lgaRows] = await Promise.all([
          listPublicIntakeCategories(siteSlug),
          listLgas(),
        ]);
        if (cancelled) return;
        setCategories(cats);
        setLgas(lgaRows);
      } catch {
        if (!cancelled) setCategories([]);
      } finally {
        if (!cancelled) setLoaded(true);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [siteSlug]);

  // ── Cascading geography (Core Geography; every level optional) ──────
  const onLgaChange = async (id: string) => {
    setLgaId(id);
    setWardId("");
    setPollingUnitId("");
    setPus([]);
    setWards([]);
    if (!id) return;
    try {
      setWards(await listWards(id));
    } catch {
      setWards([]);
    }
  };

  const onWardChange = async (id: string) => {
    setWardId(id);
    setPollingUnitId("");
    setPus([]);
    if (!id) return;
    try {
      setPus(await listPollingUnits(id));
    } catch {
      setPus([]);
    }
  };

  // ── Step 1: stage the submission (server emails the code) ──────────
  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setFormError(null);
    setSubmitting(true);
    try {
      await submitPublicIntake({
        siteSlug,
        contactEmail: email,
        fullName,
        category,
        subject,
        description,
        wardId: wardId || null,
        lgaId: lgaId || null,
        pollingUnitId: pollingUnitId || null,
        consent,
      });
      setStage("verify");
    } catch (err) {
      setFormError(
        err instanceof PublicIntakeError
          ? err.message
          : "We couldn't accept your submission. Please check your details and try again."
      );
    } finally {
      setSubmitting(false);
    }
  };

  // ── Step 2: present the emailed code → activate + issue secret ─────
  const handleVerify = async (e: React.FormEvent) => {
    e.preventDefault();
    setVerifyError(null);
    setSubmitting(true);
    try {
      const r = await verifyPublicIntake(token, siteSlug);
      setResult({ ref: r.referenceCode, secret: r.trackingSecret });
      setStage("done");
    } catch (err) {
      setVerifyError(
        err instanceof PublicIntakeError
          ? err.message
          : "We couldn't verify that code. Please try again."
      );
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <div className="min-h-screen bg-gray-50 flex flex-col justify-between">
      <div>
        <Header />
        <main className="max-w-3xl mx-auto px-4 py-16">
          <div className="flex items-center gap-3 mb-2">
            <Inbox className="h-8 w-8 text-brand-primary" />
            <h1 className="text-4xl font-bold text-brand-primary">
              File a Request
            </h1>
          </div>
          <p className="text-gray-600 mb-8">
            Submit a governance request to the team. You&apos;ll verify your
            email, then receive a reference number and a tracking secret to
            follow your case.
          </p>

          {stage === "form" && (
            <form
              onSubmit={handleSubmit}
              className="bg-white rounded-xl shadow-sm p-6 space-y-4"
            >
              <div className="grid md:grid-cols-2 gap-4">
                <div>
                  <label className="block text-sm font-medium text-gray-700 mb-1">
                    Full Name *
                  </label>
                  <input
                    type="text"
                    required
                    maxLength={120}
                    value={fullName}
                    onChange={(e) => setFullName(e.target.value)}
                    className="w-full rounded-lg border border-gray-300 px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-brand-primary"
                  />
                </div>
                <div>
                  <label className="block text-sm font-medium text-gray-700 mb-1">
                    Email Address *
                  </label>
                  <input
                    type="email"
                    required
                    value={email}
                    onChange={(e) => setEmail(e.target.value)}
                    className="w-full rounded-lg border border-gray-300 px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-brand-primary"
                  />
                </div>
              </div>

              <div>
                <label className="block text-sm font-medium text-gray-700 mb-1">
                  Category *
                </label>
                <select
                  required
                  value={category}
                  onChange={(e) => setCategory(e.target.value)}
                  className="w-full rounded-lg border border-gray-300 px-3 py-2 text-sm bg-white focus:outline-none focus:ring-2 focus:ring-brand-primary"
                >
                  <option value="">
                    {loaded && categories.length === 0
                      ? "Requests are not being accepted right now"
                      : "Select a category"}
                  </option>
                  {categories.map((c) => (
                    <option key={c} value={c}>
                      {c}
                    </option>
                  ))}
                </select>
              </div>

              <div>
                <label className="block text-sm font-medium text-gray-700 mb-1">
                  Subject * <span className="text-gray-400">(5–200 characters)</span>
                </label>
                <input
                  type="text"
                  required
                  minLength={5}
                  maxLength={200}
                  value={subject}
                  onChange={(e) => setSubject(e.target.value)}
                  className="w-full rounded-lg border border-gray-300 px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-brand-primary"
                />
              </div>

              <div>
                <label className="block text-sm font-medium text-gray-700 mb-1">
                  Description *{" "}
                  <span className="text-gray-400">(20–10,000 characters)</span>
                </label>
                <textarea
                  required
                  rows={6}
                  minLength={20}
                  maxLength={10000}
                  value={description}
                  onChange={(e) => setDescription(e.target.value)}
                  className="w-full rounded-lg border border-gray-300 px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-brand-primary"
                />
              </div>

              {/* Optional Core Geography — State/LGA cascade; no forced Ward/PU */}
              <div className="grid md:grid-cols-3 gap-4">
                <div>
                  <label className="block text-sm font-medium text-gray-700 mb-1">
                    LGA <span className="text-gray-400">(optional)</span>
                  </label>
                  <select
                    value={lgaId}
                    onChange={(e) => void onLgaChange(e.target.value)}
                    className="w-full rounded-lg border border-gray-300 px-3 py-2 text-sm bg-white focus:outline-none focus:ring-2 focus:ring-brand-primary"
                  >
                    <option value="">Select LGA</option>
                    {lgas.map((l) => (
                      <option key={l.id} value={l.id}>
                        {l.name}
                      </option>
                    ))}
                  </select>
                </div>
                <div>
                  <label className="block text-sm font-medium text-gray-700 mb-1">
                    Ward <span className="text-gray-400">(optional)</span>
                  </label>
                  <select
                    value={wardId}
                    onChange={(e) => void onWardChange(e.target.value)}
                    disabled={!lgaId}
                    className="w-full rounded-lg border border-gray-300 px-3 py-2 text-sm bg-white disabled:bg-gray-100 focus:outline-none focus:ring-2 focus:ring-brand-primary"
                  >
                    <option value="">Select Ward</option>
                    {wards.map((w) => (
                      <option key={w.id} value={w.id}>
                        {w.name}
                      </option>
                    ))}
                  </select>
                </div>
                <div>
                  <label className="block text-sm font-medium text-gray-700 mb-1">
                    Polling Unit <span className="text-gray-400">(optional)</span>
                  </label>
                  <select
                    value={pollingUnitId}
                    onChange={(e) => setPollingUnitId(e.target.value)}
                    disabled={!wardId}
                    className="w-full rounded-lg border border-gray-300 px-3 py-2 text-sm bg-white disabled:bg-gray-100 focus:outline-none focus:ring-2 focus:ring-brand-primary"
                  >
                    <option value="">Select Polling Unit</option>
                    {pus.map((p) => (
                      <option key={p.id} value={p.id}>
                        {p.name}
                      </option>
                    ))}
                  </select>
                </div>
              </div>

              <label className="flex items-start gap-3 text-sm text-gray-700">
                <input
                  type="checkbox"
                  required
                  checked={consent}
                  onChange={(e) => setConsent(e.target.checked)}
                  className="mt-1 h-4 w-4"
                />
                <span>
                  I consent to my contact details being used to verify this
                  request and provide updates. *
                </span>
              </label>

              {formError && (
                <p className="text-sm text-red-600" role="alert">
                  {formError}
                </p>
              )}

              <button
                type="submit"
                disabled={submitting}
                className="inline-flex items-center justify-center rounded-lg bg-brand-primary px-6 py-2.5 text-sm font-semibold text-white hover:bg-brand-primary transition-colors disabled:opacity-50"
              >
                {submitting ? (
                  <Loader2 className="h-4 w-4 animate-spin" />
                ) : (
                  "Submit Request"
                )}
              </button>
            </form>
          )}

          {stage === "verify" && (
            <form
              onSubmit={handleVerify}
              className="bg-white rounded-xl shadow-sm p-6 space-y-4"
            >
              <div className="flex items-center gap-2 text-sm text-gray-600">
                <ShieldCheck className="h-5 w-5 text-green-600" />
                We&apos;ve emailed a verification code to{" "}
                <strong>{email}</strong>. It expires in 24 hours and works
                once.
              </div>
              <div>
                <label className="block text-sm font-medium text-gray-700 mb-1">
                  Verification Code *
                </label>
                <input
                  type="text"
                  required
                  value={token}
                  onChange={(e) => setToken(e.target.value)}
                  className="w-full rounded-lg border border-gray-300 px-3 py-2 text-sm font-mono focus:outline-none focus:ring-2 focus:ring-brand-primary"
                />
              </div>
              {verifyError && (
                <p className="text-sm text-red-600" role="alert">
                  {verifyError}
                </p>
              )}
              <button
                type="submit"
                disabled={submitting}
                className="inline-flex items-center justify-center rounded-lg bg-brand-primary px-6 py-2.5 text-sm font-semibold text-white hover:bg-brand-primary transition-colors disabled:opacity-50"
              >
                {submitting ? (
                  <Loader2 className="h-4 w-4 animate-spin" />
                ) : (
                  "Verify & File Request"
                )}
              </button>
            </form>
          )}

          {stage === "done" && result && (
            <div className="bg-white rounded-xl shadow-sm p-6 space-y-5">
              <div className="flex items-center gap-3">
                <CheckCircle2 className="h-8 w-8 text-green-600" />
                <h2 className="text-2xl font-bold text-gray-900">
                  Request Filed
                </h2>
              </div>

              <div className="rounded-lg bg-gray-50 border border-gray-200 p-4">
                <p className="text-xs uppercase tracking-wide text-gray-500">
                  Reference number
                </p>
                <p className="text-xl font-mono font-bold text-gray-900">
                  {result.ref}
                </p>
              </div>

              <div className="rounded-lg bg-yellow-50 border border-yellow-300 p-4">
                <p className="text-xs uppercase tracking-wide text-yellow-700">
                  Tracking secret — shown only once
                </p>
                <p className="font-mono text-sm break-all text-gray-900">
                  {result.secret}
                </p>
                <p className="text-xs text-yellow-700 mt-2">
                  Keep this safe. The reference alone cannot access your case;
                  the secret is required to track it and cannot be recovered.
                </p>
              </div>

              <p className="text-sm text-gray-600">
                A copy has been emailed to you. Track your request any time at{" "}
                <a href="/request/track" className="text-brand-primary underline">
                  Track a Request
                </a>
                .
              </p>
            </div>
          )}
        </main>
      </div>
      <Footer />
    </div>
  );
}
