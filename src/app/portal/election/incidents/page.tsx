"use client";

/**
 * POLITICORE — Election Incidents (Phase 2 cutover: PostgreSQL/Supabase).
 *
 * Rows are RLS-scoped (admin/officer tenant-wide; members see their
 * registered ward/PU + own reports); inserts are authorized by the
 * incidents_insert policy with tenant/reporter resolved server-side
 * (§25). Social-only accounts are denied at the gate AND by RLS.
 * Evidence via the Media Service (§10); realtime via Supabase (§23).
 */

import { useCallback, useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import {
  createElectionIncident,
  getElectionIncidents,
  subscribeToElectionIncidents,
  uploadElectionEvidence,
  electionErrorMessage,
  getSupabaseClient,
  ensureSupabaseSession,
  resolveElectionAccess,
} from "@/lib/supabase";
import { listWards, listPollingUnits, listLgas } from "@/lib/supabase/geography";
import type { ElectionIncident } from "@/types";

import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { useToast } from "@/components/ui/toast";
import { HelpLink } from "@/components/help/HelpLink";
import {
  AlertTriangle,
  Plus,
  Loader2,
  AlertCircle,
  Upload,
  X,
  ShieldAlert,
  Lock,
} from "lucide-react";

interface GeoOption {
  id: string;
  name: string;
  code?: string;
}

const INCIDENT_TYPES: Array<{ value: ElectionIncident["incident_type"]; label: string }> = [
  { value: "bvas_malfunction", label: "BVAS / Technical Failure" },
  { value: "late_arrival", label: "Late Arrival of Materials" },
  { value: "vote_buying", label: "Vote Buying / Inducement" },
  { value: "ballot_snatching", label: "Ballot Snatching / Tampering" },
  { value: "violence", label: "Disruption / Security Concern" },
  { value: "other", label: "Other Incident" },
];

const SEVERITIES: Array<{ value: ElectionIncident["severity"]; label: string }> = [
  { value: "low", label: "Low — Minor Delay" },
  { value: "medium", label: "Medium — Operational Concern" },
  { value: "high", label: "High — Serious Disturbance" },
  { value: "critical", label: "Critical — Immediate Intervention Needed" },
];

export default function IncidentsPage() {
  const router = useRouter();
  const toast = useToast();

  const [gate, setGate] = useState<"loading" | "denied" | "no_session" | "ready">("loading");
  const [tenantWide, setTenantWide] = useState(false);
  const [registered, setRegistered] = useState<{ wardId: string | null; puId: string | null }>({
    wardId: null,
    puId: null,
  });

  const [incidents, setIncidents] = useState<ElectionIncident[]>([]);
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
  const [incidentType, setIncidentType] =
    useState<ElectionIncident["incident_type"]>("bvas_malfunction");
  const [severity, setSeverity] = useState<ElectionIncident["severity"]>("medium");
  const [description, setDescription] = useState("");

  const [evidenceFile, setEvidenceFile] = useState<File | null>(null);
  const [evidencePreview, setEvidencePreview] = useState<string | null>(null);

  // ── access gate (§14/§16) ──────────────────────────────────────────
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

  // ── incidents fetch + realtime (§23) ───────────────────────────────
  const fetchIncidents = useCallback(async () => {
    try {
      const rows = await getElectionIncidents(getSupabaseClient(), {});
      setIncidents(rows);
      setLoadError("");
    } catch (err) {
      console.error("Failed to load election incidents:", err);
      setLoadError("Election incidents could not be loaded. Please try again.");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    if (gate !== "ready") return;
    let unsub: (() => void) | null = null;
    (async () => {
      await fetchIncidents();
      const handle = subscribeToElectionIncidents(getSupabaseClient(), () =>
        void fetchIncidents()
      );
      unsub = handle.unsubscribe;
    })();
    return () => unsub?.();
  }, [gate, fetchIncidents]);

  // ── geography cascade ──────────────────────────────────────────────
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

    const targetWard = tenantWide ? wardId : registered.wardId;
    if (!targetWard) {
      toast.warning(
        registered.wardId
          ? "Please select a ward for the incident."
          : "Your profile has no registered ward — ask an administrator to set it."
      );
      return;
    }
    if (!description.trim()) {
      toast.warning("Please describe what happened before submitting.");
      return;
    }

    setSubmitting(true);
    try {
      // Evidence via Media Service (§10) — optional for incidents.
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

      // Insert authorized by the incidents_insert RLS policy (§25);
      // tenant + reporter resolved server-side, never from the client.
      await createElectionIncident(getSupabaseClient(), {
        wardId: targetWard,
        pollingUnitId: tenantWide ? pollingUnitId || null : registered.puId,
        incidentType,
        severity,
        description: description.trim(),
        evidenceAssetId,
      });

      toast.success(
        "Election incident reported. Administrators and Election Officers have been notified."
      );
      setShowForm(false);
      setDescription("");
      setEvidenceFile(null);
      setEvidencePreview(null);
      await fetchIncidents();
    } catch (err) {
      console.error("Failed to report election incident:", err);
      toast.error(
        electionErrorMessage(err, "We couldn't submit the incident report. Please try again.")
      );
    } finally {
      setSubmitting(false);
    }
  };

  if (gate === "loading" || loading) {
    return (
      <div className="flex items-center justify-center min-h-[50vh]">
        <Loader2 className="h-8 w-8 animate-spin text-brand-primary" />
        <span className="ml-3 text-gray-500">Loading incident reports...</span>
      </div>
    );
  }

  if (gate === "no_session") {
    return (
      <div className="max-w-xl mx-auto my-12 p-8 bg-white rounded-2xl shadow-sm border border-gray-200 text-center space-y-4">
        <AlertCircle className="w-10 h-10 text-amber-500 mx-auto" />
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
        <h2 className="text-lg font-bold text-gray-900">Incidents access denied</h2>
        <p className="text-sm text-gray-600 leading-relaxed">
          Election incident reporting requires Election access (a registered
          ward/polling unit or an explicit grant). Social-only accounts and
          unauthorized members are denied by the database itself.
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
            <h1 className="text-2xl font-bold text-gray-900">Election Incident Reports</h1>
            <HelpLink article="election-incidents" label="Incidents guide" />
          </div>
          <p className="text-sm text-gray-500">
            Report and track irregularities, BVAS malfunctions, late arrivals, or
            security incidents.
          </p>
        </div>

        <button
          onClick={() => setShowForm((prev) => !prev)}
          className="inline-flex items-center gap-2 rounded-lg bg-red-600 px-4 py-2.5 text-sm font-semibold text-white hover:bg-red-700 transition-colors"
        >
          <AlertTriangle className="h-4 w-4" />
          {showForm ? "Cancel" : "Report Incident"}
        </button>
      </div>

      {/* Form */}
      {showForm && (
        <Card className="border-red-200 bg-red-50/20">
          <CardHeader>
            <div className="flex items-center justify-between">
              <CardTitle className="text-lg text-red-900 flex items-center gap-2">
                <ShieldAlert className="h-5 w-5 text-red-600" />
                Report Election Incident
              </CardTitle>
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
                        className="w-full px-3 py-2 border rounded-lg text-sm bg-white"
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
                        className="w-full px-3 py-2 border rounded-lg text-sm bg-white disabled:bg-gray-100"
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
                        Polling Unit (Optional)
                      </label>
                      <select
                        value={pollingUnitId}
                        onChange={(e) => setPollingUnitId(e.target.value)}
                        disabled={!wardId}
                        className="w-full px-3 py-2 border rounded-lg text-sm bg-white disabled:bg-gray-100"
                      >
                        <option value="">Entire Ward / Select Polling Unit</option>
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
                    Reporting for your registered Ward: {registered.wardId}
                    {registered.puId ? ` · PU: ${registered.puId}` : " (entire ward)"}
                  </div>
                )}
              </div>

              <div className="grid md:grid-cols-2 gap-4">
                <div>
                  <label className="block text-xs font-semibold text-gray-700 mb-1">
                    Incident Type *
                  </label>
                  <select
                    value={incidentType}
                    onChange={(e) =>
                      setIncidentType(e.target.value as ElectionIncident["incident_type"])
                    }
                    className="w-full px-3 py-2 border rounded-lg text-sm bg-white"
                    required
                  >
                    {INCIDENT_TYPES.map((t) => (
                      <option key={t.value} value={t.value}>
                        {t.label}
                      </option>
                    ))}
                  </select>
                </div>

                <div>
                  <label className="block text-xs font-semibold text-gray-700 mb-1">
                    Severity *
                  </label>
                  <select
                    value={severity}
                    onChange={(e) => setSeverity(e.target.value as ElectionIncident["severity"])}
                    className="w-full px-3 py-2 border rounded-lg text-sm bg-white"
                    required
                  >
                    {SEVERITIES.map((s) => (
                      <option key={s.value} value={s.value}>
                        {s.label}
                      </option>
                    ))}
                  </select>
                </div>
              </div>

              <div>
                <label className="block text-xs font-semibold text-gray-700 mb-1">
                  Incident Description *
                </label>
                <textarea
                  rows={4}
                  required
                  value={description}
                  onChange={(e) => setDescription(e.target.value)}
                  placeholder="Describe the incident in detail..."
                  className="w-full px-3 py-2 border rounded-lg text-sm bg-white"
                />
              </div>

              {/* Photo Evidence — Media Service (§10) */}
              <div>
                <label className="block text-xs font-semibold text-gray-700 mb-1">
                  Photo / Video Evidence (Optional)
                </label>
                <div className="flex items-center gap-4">
                  <input
                    type="file"
                    accept="image/jpeg,image/png,image/webp,application/pdf"
                    onChange={handleImageChange}
                    className="text-xs text-gray-600 file:mr-3 file:py-2 file:px-3 file:rounded-lg file:border-0 file:text-xs file:font-semibold file:bg-red-600 file:text-white"
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
                  className="inline-flex items-center gap-2 rounded-lg bg-red-600 px-5 py-2 text-sm font-semibold text-white hover:bg-red-700 disabled:opacity-50"
                >
                  {submitting ? (
                    <>
                      <Loader2 className="h-4 w-4 animate-spin" />
                      <span>Submitting...</span>
                    </>
                  ) : (
                    <span>Submit Incident Report</span>
                  )}
                </button>
              </div>
            </form>
          </CardContent>
        </Card>
      )}

      {/* Incidents Listing */}
      <Card>
        <CardHeader>
          <CardTitle>Reported Incidents ({incidents.length})</CardTitle>
        </CardHeader>
        <CardContent>
          {loadError ? (
            <p className="py-10 text-center text-sm text-red-600">{loadError}</p>
          ) : incidents.length === 0 ? (
            <div className="text-center py-10">
              <AlertTriangle className="h-12 w-12 text-gray-300 mx-auto mb-4" />
              <p className="text-gray-500">No election incidents reported in this scope.</p>
            </div>
          ) : (
            <div className="space-y-4">
              {incidents.map((inc) => (
                <div key={inc.id} className="bg-white border rounded-xl p-5 space-y-2">
                  <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-2">
                    <div className="flex items-center gap-2">
                      <span
                        className={`px-2.5 py-0.5 rounded-full text-xs font-semibold uppercase ${
                          inc.severity === "critical" || inc.severity === "high"
                            ? "bg-red-100 text-red-700"
                            : "bg-yellow-100 text-yellow-700"
                        }`}
                      >
                        {inc.severity} Severity
                      </span>
                      <span className="font-bold text-gray-900 uppercase text-xs">
                        {inc.incident_type.replace("_", " ")}
                      </span>
                      <span className="px-2 py-0.5 rounded-full text-[10px] font-semibold bg-blue-50 text-blue-700 uppercase">
                        {inc.status}
                      </span>
                    </div>

                    <span className="text-xs text-gray-400">
                      Ward: {inc.ward_id}
                      {inc.polling_unit_id ? ` · PU: ${inc.polling_unit_id}` : ""}
                    </span>
                  </div>

                  <p className="text-sm text-gray-700 whitespace-pre-wrap">{inc.description}</p>

                  {inc.evidence_asset_id && (
                    <div className="pt-2">
                      <a
                        href={`/api/election/evidence/${inc.evidence_asset_id}`}
                        target="_blank"
                        rel="noreferrer"
                        className="inline-flex items-center gap-1 text-xs font-semibold text-red-600 hover:underline"
                      >
                        <Upload className="h-3.5 w-3.5" /> View Evidence (signed)
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
