"use client";

import { useEffect, useMemo, useState } from "react";
import { useRouter } from "next/navigation";
import Link from "next/link";
import { CheckCircle2, Loader2, ShieldAlert, Send } from "lucide-react";

import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { useAuth } from "@/contexts/AuthContext";
import { useToast } from "@/components/ui/toast";
import { getErrorMessage } from "@/lib/errors";
import {
  resolveGovernanceAccess,
  listCategories,
  listLgas,
  listWards,
  listPollingUnits,
  submitRequest,
  GovernanceError,
  type GovernanceAccess,
  type GovernanceCategory,
  type GeoLga,
  type GeoWard,
  type GeoPollingUnit,
} from "@/lib/supabase";

export default function SubmitRequestPage() {
  const router = useRouter();
  const toast = useToast();
  const { profile, loading: authLoading } = useAuth();

  const [access, setAccess] = useState<GovernanceAccess | null>(null);
  const [guardDone, setGuardDone] = useState(false);

  const [categories, setCategories] = useState<GovernanceCategory[]>([]);
  const [lgas, setLgas] = useState<GeoLga[]>([]);
  const [wards, setWards] = useState<GeoWard[]>([]);
  const [pus, setPus] = useState<GeoPollingUnit[]>([]);

  const [categoryId, setCategoryId] = useState("");
  const [title, setTitle] = useState("");
  const [details, setDetails] = useState("");
  const [lgaId, setLgaId] = useState("");
  const [wardId, setWardId] = useState("");
  const [pollingUnitId, setPollingUnitId] = useState("");

  const [loading, setLoading] = useState(true);
  const [submitting, setSubmitting] = useState(false);
  const [reference, setReference] = useState<string | null>(null);
  const [requestId, setRequestId] = useState<string | null>(null);

  // ─── ROUTE GUARD (fail closed) ───
  useEffect(() => {
    if (authLoading) return;
    if (!profile) {
      router.replace("/portal/dashboard");
      return;
    }
    let cancelled = false;
    void (async () => {
      try {
        const a = await resolveGovernanceAccess();
        if (!cancelled) setAccess(a);
        if (!a.moduleEnabled || !a.canViewGovernance || !a.isParticipant) {
          router.replace("/portal/dashboard");
        }
      } catch {
        router.replace("/portal/dashboard");
      } finally {
        if (!cancelled) setGuardDone(true);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [authLoading, profile, router]);

  // ─── LOAD (categories + geography) ───
  useEffect(() => {
    if (!guardDone || !access?.isParticipant) return;
    let cancelled = false;
    void (async () => {
      try {
        const [cats, lgaData] = await Promise.all([
          listCategories(),
          listLgas(),
        ]);
        if (cancelled) return;
        setCategories(cats.filter((c) => c.is_active));
        setLgas(lgaData);
      } catch (err) {
        console.error("Failed to load governance form data:", err);
        if (!cancelled) {
          toast.error("Unable to load the request form. Please refresh.");
        }
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [guardDone, access?.isParticipant, toast]);

  // Dependent-field resets live in the change handlers; effects only fetch.
  const handleLgaChange = (value: string) => {
    setLgaId(value);
    setWards([]);
    setWardId("");
    setPus([]);
    setPollingUnitId("");
  };

  const handleWardChange = (value: string) => {
    setWardId(value);
    setPus([]);
    setPollingUnitId("");
  };

  // Cascade ward options from the chosen LGA (Core geography, paged).
  useEffect(() => {
    if (!lgaId) return;
    let cancelled = false;
    void (async () => {
      try {
        const w = await listWards(lgaId);
        if (!cancelled) setWards(w);
      } catch {
        if (!cancelled) setWards([]);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [lgaId]);

  // Cascade polling-unit options from the chosen ward.
  useEffect(() => {
    if (!wardId) return;
    let cancelled = false;
    void (async () => {
      try {
        const units = await listPollingUnits(wardId);
        if (!cancelled) setPus(units);
      } catch {
        if (!cancelled) setPus([]);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [wardId]);

  const canSubmit = useMemo(
    () => title.trim().length > 0 && details.trim().length > 0 && !submitting,
    [title, details, submitting],
  );

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!canSubmit) return;
    setSubmitting(true);
    try {
      const id = await submitRequest({
        title: title.trim(),
        details: details.trim(),
        categoryId: categoryId || null,
        lgaId: lgaId || null,
        wardId: wardId || null,
        pollingUnitId: pollingUnitId || null,
      });
      // Fetch the reference code for the confirmation screen (RLS: the
      // submitter can always read their own request).
      const { getMyRequest } = await import("@/lib/supabase");
      const created = await getMyRequest(id);
      setRequestId(id);
      setReference(created?.reference_code ?? null);
      toast.success("Your request has been submitted.");
    } catch (err) {
      console.error("Governance submit failed:", err);
      if (err instanceof GovernanceError && err.kind === "module_disabled") {
        toast.error("The Governance module is not enabled for your organization.");
      } else {
        toast.error(getErrorMessage(err, "Unable to submit your request."));
      }
    } finally {
      setSubmitting(false);
    }
  };

  // ─── SUCCESS STATE ───
  if (reference !== null) {
    return (
      <div className="mx-auto max-w-xl px-4 py-16 text-center">
        <CheckCircle2 className="mx-auto mb-4 h-12 w-12 text-green-600" />
        <h1 className="text-xl font-semibold text-gray-900">
          Request submitted
        </h1>
        <p className="mt-2 text-sm text-gray-600">
          Keep this reference for tracking:
        </p>
        <p className="mt-3 rounded-lg border border-gray-200 bg-gray-50 px-4 py-3 font-mono text-lg font-semibold tracking-wide text-gray-900">
          {reference}
        </p>
        <div className="mt-6 flex flex-col justify-center gap-3 sm:flex-row">
          <Link
            href={`/portal/governance/requests/${requestId}`}
            className="inline-flex items-center justify-center rounded-lg bg-apc-primary px-4 py-2.5 text-sm font-semibold text-white hover:bg-apc-primary/90"
          >
            Track this request
          </Link>
          <Link
            href="/portal/governance/requests"
            className="inline-flex items-center justify-center rounded-lg border border-gray-300 px-4 py-2.5 text-sm font-medium text-gray-700 hover:bg-gray-50"
          >
            My Requests
          </Link>
        </div>
      </div>
    );
  }

  if (authLoading || loading) {
    return (
      <div className="flex min-h-[50vh] items-center justify-center">
        <Loader2 className="h-8 w-8 animate-spin text-apc-primary" />
      </div>
    );
  }

  if (!access?.moduleEnabled) {
    return (
      <div className="mx-auto max-w-2xl px-4 py-16 text-center">
        <ShieldAlert className="mx-auto mb-4 h-10 w-10 text-gray-400" />
        <h1 className="text-xl font-semibold text-gray-900">
          Governance is not available
        </h1>
        <p className="mt-2 text-sm text-gray-600">
          The Governance module is not enabled for your organization.
        </p>
      </div>
    );
  }

  return (
    <div className="mx-auto max-w-2xl space-y-6">
      <header>
        <h1 className="text-2xl font-bold text-gray-900">Submit a Request</h1>
        <p className="mt-1 text-sm text-gray-600">
          Describe the issue or service need. You will receive a reference
          code to track progress.
        </p>
      </header>

      <Card>
        <CardHeader>
          <CardTitle className="text-base font-semibold text-gray-900">
            Request details
          </CardTitle>
        </CardHeader>
        <CardContent>
          <form onSubmit={handleSubmit} className="space-y-4">
            <div className="space-y-1.5">
              <Label htmlFor="gov-category">Category</Label>
              <select
                id="gov-category"
                value={categoryId}
                onChange={(e) => setCategoryId(e.target.value)}
                className="w-full rounded-lg border border-gray-300 bg-white px-3 py-2 text-sm focus:border-apc-primary focus:outline-none"
              >
                <option value="">General (no category)</option>
                {categories.map((c) => (
                  <option key={c.id} value={c.id}>
                    {c.name}
                  </option>
                ))}
              </select>
            </div>

            <div className="space-y-1.5">
              <Label htmlFor="gov-title">Subject</Label>
              <Input
                id="gov-title"
                value={title}
                onChange={(e) => setTitle(e.target.value)}
                placeholder="Short summary of the issue"
                maxLength={200}
                required
              />
            </div>

            <div className="space-y-1.5">
              <Label htmlFor="gov-details">Description</Label>
              <textarea
                id="gov-details"
                value={details}
                onChange={(e) => setDetails(e.target.value)}
                rows={6}
                placeholder="What is happening, where, and what is needed?"
                className="w-full rounded-lg border border-gray-300 bg-white px-3 py-2 text-sm focus:border-apc-primary focus:outline-none"
                required
              />
            </div>

            <fieldset className="space-y-4 rounded-lg border border-gray-200 p-4">
              <legend className="px-1 text-xs font-semibold uppercase tracking-wide text-gray-500">
                Location (optional)
              </legend>

              <div className="space-y-1.5">
                <Label htmlFor="gov-lga">LGA</Label>
                <select
                  id="gov-lga"
                  value={lgaId}
                  onChange={(e) => handleLgaChange(e.target.value)}
                  className="w-full rounded-lg border border-gray-300 bg-white px-3 py-2 text-sm focus:border-apc-primary focus:outline-none"
                >
                  <option value="">Not specified</option>
                  {lgas.map((l) => (
                    <option key={l.id} value={l.id}>
                      {l.name}
                    </option>
                  ))}
                </select>
              </div>

              <div className="space-y-1.5">
                <Label htmlFor="gov-ward">Ward</Label>
                <select
                  id="gov-ward"
                  value={wardId}
                  onChange={(e) => handleWardChange(e.target.value)}
                  disabled={!lgaId}
                  className="w-full rounded-lg border border-gray-300 bg-white px-3 py-2 text-sm focus:border-apc-primary focus:outline-none disabled:bg-gray-100"
                >
                  <option value="">Not specified</option>
                  {wards.map((w) => (
                    <option key={w.id} value={w.id}>
                      {w.code} — {w.name}
                    </option>
                  ))}
                </select>
              </div>

              <div className="space-y-1.5">
                <Label htmlFor="gov-pu">Polling Unit</Label>
                <select
                  id="gov-pu"
                  value={pollingUnitId}
                  onChange={(e) => setPollingUnitId(e.target.value)}
                  disabled={!wardId}
                  className="w-full rounded-lg border border-gray-300 bg-white px-3 py-2 text-sm focus:border-apc-primary focus:outline-none disabled:bg-gray-100"
                >
                  <option value="">Not specified</option>
                  {pus.map((p) => (
                    <option key={p.id} value={p.id}>
                      {p.code} — {p.name}
                    </option>
                  ))}
                </select>
              </div>
            </fieldset>

            <button
              type="submit"
              disabled={!canSubmit}
              className="inline-flex w-full items-center justify-center gap-2 rounded-lg bg-apc-primary px-4 py-2.5 text-sm font-semibold text-white transition-colors hover:bg-apc-primary/90 disabled:cursor-not-allowed disabled:opacity-50"
            >
              {submitting ? (
                <Loader2 className="h-4 w-4 animate-spin" />
              ) : (
                <Send className="h-4 w-4" />
              )}
              {submitting ? "Submitting…" : "Submit Request"}
            </button>
          </form>
        </CardContent>
      </Card>
    </div>
  );
}
