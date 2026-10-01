"use client";

/**
 * POLITICORE — PU Reports (Phase 2 cutover: PostgreSQL/Supabase).
 *
 * Reads and writes go through the Election service layer: rows are
 * scoped by RLS (admin/officer tenant-wide; members see their registered
 * PU/ward + their own submissions — the client never widens it), and
 * inserts are authorized by the pu_reports_insert policy with
 * tenant/submitter resolved server-side (§24). Evidence uploads via the
 * Media Service (§10); realtime via Supabase (§23).
 */

import { useCallback, useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { useAuth } from "@/contexts/AuthContext";
import {
  createPUReport,
  getPUReports,
  subscribeToPUReports,
  uploadElectionEvidence,
  electionErrorMessage,
  getSupabaseClient,
  ensureSupabaseSession,
  resolveElectionAccess,
} from "@/lib/supabase";
import { listWards, listPollingUnits, listLgas } from "@/lib/supabase/geography";
import type { PUReport } from "@/types";

interface GeoOption {
  id: string;
  name: string;
  code?: string;
}

import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { useToast } from "@/components/ui/toast";
import { HelpLink } from "@/components/help/HelpLink";
import {
  FileText,
  Plus,
  Loader2,
  Upload,
  X,
  Lock,
} from "lucide-react";

const REPORT_TYPES: Array<{ value: PUReport["report_type"]; label: string }> = [
  { value: "opening", label: "PU Opening & Setup" },
  { value: "turnout", label: "Voter Turnout" },
  { value: "conduct", label: "Voting Conduct" },
  { value: "closing", label: "PU Closing & Counting" },
  { value: "general", label: "General PU Report" },
];

export default function PUReportsPage() {
  const router = useRouter();
  const toast = useToast();

  const [gate, setGate] = useState<"loading" | "denied" | "no_session" | "ready">("loading");
  const [tenantWide, setTenantWide] = useState(false);
  const [registered, setRegistered] = useState<{ wardId: string | null; puId: string | null }>({
    wardId: null,
    puId: null,
  });

  const [reports, setReports] = useState<PUReport[]>([]);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState("");

  // Form state
  const [showForm, setShowForm] = useState(false);
  const [submitting, setSubmitting] = useState(false);

  const [lgaChoices, setLgaChoices] = useState<GeoOption[]>([]);
  const [lgaId, setLgaId] = useState("");
  const [wards, setWards] = useState<GeoOption[]>([]);
  const [wardId, setWardId] = useState("");
  const [pollingUnits, setPollingUnits] = useState<GeoOption[]>([]);
  const [pollingUnitId, setPollingUnitId] = useState("");
  const [reportType, setReportType] = useState<PUReport["report_type"]>("conduct");
  const [title, setTitle] = useState("");
  const [content, setContent] = useState("");

  const [evidenceFile, setEvidenceFile] = useState<File | null>(null);
  const [evidencePreview, setEvidencePreview] = useState<string | null>(null);

  // ── access gate (module + social-only + authority, §14/§16) ────────
  useEffect(() => {
    let cancelled = false;
    (async () => {
      const bridge = await ensureSupabaseSession();
      if (cancelled) return;
      if (!bridge.sessionReady) {
        setGate(bridge.reason === "no_session" ? "no_session" : "denied");
        setLoading(false);
        return;
      }
      const supabase = bridge.supabase ?? getSupabaseClient();
      const access = await resolveElectionAccess(supabase, { requireAuthority: true });
      if (cancelled) return;
      if (!access.allowed) {
        setGate("denied");
        setLoading(false);
        return;
      }
      setTenantWide(access.tenantWide);
      setRegistered({ wardId: access.wardId, puId: access.pollingUnitId });
      setGate("ready");
    })();
    return () => {
      cancelled = true;
    };
  }, [router]);

  // ── reports fetch + realtime (§23) ─────────────────────────────────
  const fetchReports = useCallback(async () => {
    try {
      // RLS scopes rows; the member filter only narrows rendering.
      const rows = await getPUReports(getSupabaseClient(), {});
      setReports(rows);
      setLoadError("");
    } catch (err) {
      console.error("Failed to load PU reports:", err);
      setLoadError("PU reports could not be loaded. Please try again.");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    if (gate !== "ready") return;
    let unsub: (() => void) | null = null;
    (async () => {
      await fetchReports();
      const handle = subscribeToPUReports(getSupabaseClient(), () => void fetchReports());
      unsub = handle.unsubscribe;
    })();
    return () => unsub?.();
  }, [gate, fetchReports]);

  // ── geography cascade (tenant-wide form) ───────────────────────────
  useEffect(() => {
    if (gate !== "ready" || !tenantWide) return;
    let cancelled = false;
    (async () => {
      const l = await listLgas({}, getSupabaseClient()).catch(() => []);
      if (!cancelled) setLgaChoices(l);
    })();
    return () => {
      cancelled = true;
    };
  }, [gate, tenantWide]);

  useEffect(() => {
    if (!tenantWide || !lgaId) {
      // eslint-disable-next-line react-hooks/set-state-in-effect -- clearing a dependent list when its parent selection empties is synchronous by design
      setWards([]);
      return;
    }
    let cancelled = false;
    (async () => {
      const w = await listWards(lgaId, getSupabaseClient()).catch(() => []);
      if (!cancelled) setWards(w);
    })();
    return () => {
      cancelled = true;
    };
  }, [lgaId, tenantWide]);

  useEffect(() => {
    if (!tenantWide || !wardId) {
      // eslint-disable-next-line react-hooks/set-state-in-effect -- clearing a dependent list when its parent selection empties is synchronous by design
      setPollingUnits([]);
      return;
    }
    let cancelled = false;
    (async () => {
      const pus = await listPollingUnits(wardId, getSupabaseClient()).catch(() => []);
      if (!cancelled) setPollingUnits(pus);
    })();
    return () => {
      cancelled = true;
    };
  }, [wardId, tenantWide]);

  const handleImageChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (file) {
      setEvidenceFile(file);
      setEvidencePreview(URL.createObjectURL(file));
    }
  };

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();

    if (!tenantWide && (!registered.wardId || !registered.puId)) {
      toast.error("Your profile has no registered polling unit — ask an administrator to set it.");
      return;
    }
    const targetWard = tenantWide ? wardId : (registered.wardId as string);
    const targetPu = tenantWide ? pollingUnitId : (registered.puId as string);
    if (!targetWard || !targetPu) {
      toast.warning("Please select both a ward and a polling unit.");
      return;
    }
    if (!title.trim() || !content.trim()) {
      toast.warning("Please add a title and describe what you observed.");
      return;
    }

    setSubmitting(true);
    try {
      // Evidence through the Media Service (§10); optional for PU reports.
      let evidenceAssetId: string | null = null;
      if (evidenceFile) {
        try {
          const { assetId } = await uploadElectionEvidence(evidenceFile);
          evidenceAssetId = assetId;
        } catch (uploadErr) {
          console.error("Evidence upload failed:", uploadErr);
          toast.error("Photo evidence upload failed — submit without it or retry.");
          setSubmitting(false);
          return;
        }
      }

      // Insert authorized by the pu_reports_insert RLS policy (§24);
      // tenant + submitter are resolved server-side, never from the client.
      await createPUReport(getSupabaseClient(), {
        wardId: targetWard,
        pollingUnitId: targetPu,
        reportType,
        title: title.trim(),
        content: content.trim(),
        evidenceAssetId,
      });

      toast.success("Polling unit report submitted.");
      setShowForm(false);
      setTitle("");
      setContent("");
      setReportType("conduct");
      setEvidenceFile(null);
      setEvidencePreview(null);
      await fetchReports();
    } catch (err) {
      console.error("Failed to create PU report:", err);
      toast.error(electionErrorMessage(err, "We couldn't submit the report. Please try again."));
    } finally {
      setSubmitting(false);
    }
  };

  if (gate === "loading" || loading) {
    return (
      <div className="flex items-center justify-center min-h-[50vh]">
        <Loader2 className="h-8 w-8 animate-spin text-brand-primary" />
        <span className="ml-3 text-gray-500">Loading PU reports...</span>
      </div>
    );
  }

  if (gate === "no_session") {
    return (
      <div className="max-w-xl mx-auto my-12 p-8 bg-white rounded-2xl shadow-sm border border-gray-200 text-center space-y-4">
        <Lock className="w-10 h-10 text-amber-500 mx-auto" />
        <h2 className="text-lg font-bold text-gray-900">Sign in required</h2>
        <button
          onClick={() => router.replace("/portal/auth/login")}
          className="px-4 py-2 text-sm font-semibold rounded-lg bg-brand-primary text-white"
        >
          Go to sign in
        </button>
      </div>
    );
  }

  if (gate === "denied") {
    return (
      <div className="max-w-xl mx-auto my-12 p-8 bg-white rounded-2xl shadow-sm border border-gray-200 text-center space-y-4">
        <div className="mx-auto w-12 h-12 rounded-full bg-red-50 border border-red-200 flex items-center justify-center text-red-600">
          <Lock className="w-6 h-6" />
        </div>
        <h2 className="text-lg font-bold text-gray-900">PU Reports access denied</h2>
        <p className="text-sm text-gray-600 leading-relaxed">
          You need Election access (a registered polling unit or an explicit
          grant) to view and submit polling unit reports. The database enforces
          this directly.
        </p>
      </div>
    );
  }

  return (
    <div className="max-w-5xl mx-auto space-y-6 pb-12">
      {/* Header */}
      <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-4">
        <div>
          <div className="flex flex-wrap items-center justify-between gap-3">
            <h1 className="text-2xl font-bold text-gray-900">Polling Unit Reports</h1>
            <HelpLink article="pu-reports" label="PU reports guide" />
          </div>
          <p className="text-sm text-gray-500">
            Submit and inspect polling unit conduct, opening, turnout, and closing reports.
          </p>
        </div>

        <button
          onClick={() => setShowForm((prev) => !prev)}
          className="inline-flex items-center gap-2 rounded-lg bg-brand-primary px-4 py-2.5 text-sm font-semibold text-white hover:bg-brand-primary transition-colors"
        >
          <Plus className="h-4 w-4" />
          {showForm ? "Cancel" : "Submit PU Report"}
        </button>
      </div>

      {/* Form */}
      {showForm && (
        <Card className="border-brand-primary/20">
          <CardHeader>
            <div className="flex items-center justify-between">
              <CardTitle className="text-lg">Submit Polling Unit Report</CardTitle>
              <button onClick={() => setShowForm(false)} className="p-1 hover:bg-gray-100 rounded">
                <X className="h-5 w-5 text-gray-400" />
              </button>
            </div>
          </CardHeader>
          <CardContent>
            <form onSubmit={handleSubmit} className="space-y-4">
              {/* Location — relational geography (§18) */}
              <div className="grid md:grid-cols-3 gap-4">
                {tenantWide ? (
                  <>
                    <div>
                      <label className="block text-xs font-semibold text-gray-700 mb-1">LGA *</label>
                      <select
                        value={lgaId}
                        onChange={(e) => {
                          setLgaId(e.target.value);
                          setWardId("");
                          setPollingUnitId("");
                        }}
                        className="w-full px-3 py-2 border rounded-lg text-sm"
                        required
                      >
                        <option value="">Select LGA</option>
                        {lgaChoices.map((l) => (
                          <option key={l.id} value={l.id}>
                            {l.name}
                          </option>
                        ))}
                      </select>
                    </div>
                    <div>
                      <label className="block text-xs font-semibold text-gray-700 mb-1">Ward *</label>
                      <select
                        value={wardId}
                        onChange={(e) => {
                          setWardId(e.target.value);
                          setPollingUnitId("");
                        }}
                        disabled={!lgaId}
                        className="w-full px-3 py-2 border rounded-lg text-sm disabled:bg-gray-100"
                        required
                      >
                        <option value="">{lgaId ? "Select ward" : "Select LGA first"}</option>
                        {wards.map((w) => (
                          <option key={w.id} value={w.id}>
                            {w.code ? `${w.code} — ${w.name}` : w.name}
                          </option>
                        ))}
                      </select>
                    </div>
                    <div>
                      <label className="block text-xs font-semibold text-gray-700 mb-1">
                        Polling Unit *
                      </label>
                      <select
                        value={pollingUnitId}
                        onChange={(e) => setPollingUnitId(e.target.value)}
                        disabled={!wardId}
                        className="w-full px-3 py-2 border rounded-lg text-sm disabled:bg-gray-100"
                        required
                      >
                        <option value="">
                          {wardId ? "Select polling unit" : "Select Ward first"}
                        </option>
                        {pollingUnits.map((pu) => (
                          <option key={pu.id} value={pu.id}>
                            {pu.code ? `${pu.code} — ${pu.name}` : pu.name}
                          </option>
                        ))}
                      </select>
                    </div>
                  </>
                ) : (
                  <div className="md:col-span-3 p-3 bg-brand-surface/40 border border-brand-primary/20 rounded-lg text-xs text-brand-primary font-semibold">
                    Submitting for your registered Polling Unit: {registered.puId}
                  </div>
                )}
              </div>

              <div className="grid md:grid-cols-2 gap-4">
                <div>
                  <label className="block text-xs font-semibold text-gray-700 mb-1">
                    Report Type *
                  </label>
                  <select
                    value={reportType}
                    onChange={(e) => setReportType(e.target.value as PUReport["report_type"])}
                    className="w-full px-3 py-2 border rounded-lg text-sm"
                    required
                  >
                    {REPORT_TYPES.map((t) => (
                      <option key={t.value} value={t.value}>
                        {t.label}
                      </option>
                    ))}
                  </select>
                </div>

                <div>
                  <label className="block text-xs font-semibold text-gray-700 mb-1">
                    Report Title *
                  </label>
                  <input
                    type="text"
                    required
                    value={title}
                    onChange={(e) => setTitle(e.target.value)}
                    placeholder="e.g. Voting started peacefully at 8:30 AM"
                    className="w-full px-3 py-2 border rounded-lg text-sm"
                  />
                </div>
              </div>

              <div>
                <label className="block text-xs font-semibold text-gray-700 mb-1">
                  Report Content / Description *
                </label>
                <textarea
                  rows={4}
                  required
                  value={content}
                  onChange={(e) => setContent(e.target.value)}
                  placeholder="Provide detailed observation of polling unit proceedings..."
                  className="w-full px-3 py-2 border rounded-lg text-sm"
                />
              </div>

              {/* Photo Evidence — Media Service (§10) */}
              <div>
                <label className="block text-xs font-semibold text-gray-700 mb-1">
                  Photo Evidence (Optional)
                </label>
                <div className="flex items-center gap-4">
                  <input
                    type="file"
                    accept="image/jpeg,image/png,image/webp,application/pdf"
                    onChange={handleImageChange}
                    className="text-xs text-gray-600 file:mr-3 file:py-2 file:px-3 file:rounded-lg file:border-0 file:text-xs file:font-semibold file:bg-brand-primary file:text-white"
                  />
                  {evidencePreview && (
                    // eslint-disable-next-line @next/next/no-img-element
                    <img
                      src={evidencePreview}
                      alt="Preview"
                      className="h-12 w-12 object-cover rounded-lg border"
                    />
                  )}
                </div>
              </div>

              <div className="flex justify-end gap-2 pt-3">
                <button
                  type="button"
                  onClick={() => setShowForm(false)}
                  className="px-4 py-2 text-sm font-medium text-gray-600 hover:text-gray-900"
                >
                  Cancel
                </button>

                <button
                  type="submit"
                  disabled={submitting}
                  className="inline-flex items-center gap-2 rounded-lg bg-brand-primary px-5 py-2 text-sm font-semibold text-white hover:bg-brand-primary disabled:opacity-50"
                >
                  {submitting ? (
                    <>
                      <Loader2 className="h-4 w-4 animate-spin" />
                      <span>Submitting...</span>
                    </>
                  ) : (
                    <span>Submit Report</span>
                  )}
                </button>
              </div>
            </form>
          </CardContent>
        </Card>
      )}

      {/* Reports Listing */}
      <Card>
        <CardHeader>
          <CardTitle>Reports ({reports.length})</CardTitle>
        </CardHeader>
        <CardContent>
          {loadError ? (
            <p className="py-10 text-center text-sm text-red-600">{loadError}</p>
          ) : reports.length === 0 ? (
            <div className="text-center py-10">
              <FileText className="h-12 w-12 text-gray-300 mx-auto mb-4" />
              <p className="text-gray-500">
                No polling unit reports submitted in this scope yet.
              </p>
            </div>
          ) : (
            <div className="space-y-4">
              {reports.map((r) => (
                <div key={r.id} className="bg-white border rounded-xl p-5 space-y-2">
                  <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-2">
                    <div className="flex items-center gap-2">
                      <span className="px-2.5 py-0.5 rounded-full text-xs font-semibold bg-brand-primary/10 text-brand-primary uppercase">
                        {r.report_type}
                      </span>
                      <h3 className="font-bold text-gray-900">{r.title}</h3>
                      <span className="px-2 py-0.5 rounded-full text-[10px] font-semibold bg-blue-50 text-blue-700 uppercase">
                        {r.status}
                      </span>
                    </div>
                    <span className="text-xs text-gray-400">
                      PU: {r.polling_unit_id} · Ward: {r.ward_id}
                    </span>
                  </div>

                  <p className="text-sm text-gray-700 whitespace-pre-wrap">{r.content}</p>

                  {r.evidence_asset_id && (
                    <div className="pt-2">
                      <a
                        href={`/api/election/evidence/${r.evidence_asset_id}`}
                        target="_blank"
                        rel="noreferrer"
                        className="inline-flex items-center gap-1 text-xs font-semibold text-brand-primary hover:underline"
                      >
                        <Upload className="h-3.5 w-3.5" /> View Photo Evidence (signed)
                      </a>
                    </div>
                  )}
                </div>
              ))}
            </div>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
