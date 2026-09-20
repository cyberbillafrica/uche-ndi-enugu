"use client";

import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { useAuth } from "@/contexts/AuthContext";
import {
  createElectionIncident,
  subscribeToElectionIncidents,
  type ElectionIncidentDoc,
  type ElectionListenerScope,
} from "@/lib/firebase/election";
import { uploadToCloudinary } from "@/lib/cloudinary";
import { getAllLGAs } from "@/lib/constants";
import { assignmentCoversScope, isAdminUser } from "@/lib/permissions";
import type { LGA } from "@/types";

import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { useToast } from "@/components/ui/toast";
import { getErrorMessage } from "@/lib/errors";
import { HelpLink } from "@/components/help/HelpLink";
import {
  AlertTriangle,
  Plus,
  Loader2,
  AlertCircle,
  Upload,
  X,
  ShieldAlert,
} from "lucide-react";

export default function IncidentsPage() {
  const { profile, assignments, accessLoading } = useAuth();
  const router = useRouter();
  const isAdmin = isAdminUser(profile);
  const toast = useToast();

  const [lgas, setLgas] = useState<LGA[]>([]);
  const [incidents, setIncidents] = useState<ElectionIncidentDoc[]>([]);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState("");

  // Form State
  const [showForm, setShowForm] = useState(false);
  const [submitting, setSubmitting] = useState(false);

  const [form, setForm] = useState({
    lga_id: profile?.lga_id ?? "nkanu-west",
    ward_id: profile?.ward_id ?? "",
    polling_unit_id: profile?.polling_unit_id ?? "",
    incident_type: "bavas_malfunction" as ElectionIncidentDoc["incident_type"],
    severity: "medium" as ElectionIncidentDoc["severity"],
    description: "",
  });

  const [evidenceFile, setEvidenceFile] = useState<File | null>(null);
  const [evidencePreview, setEvidencePreview] = useState<string | null>(null);

  // Load LGAs
  useEffect(() => {
    async function loadLgas() {
      const data = await getAllLGAs();
      setLgas(data);
    }
    loadLgas();
  }, []);

  // Real-time Incidents Listener
  useEffect(() => {
    if (!profile?.tenant_id) return;

    /*
     * Mirror the security-rule read scope: Admins/Election
     * Officers tenant-wide, everyone else only their registered
     * ward + polling unit. An unconstrained query is denied.
     */
    const isPrivileged =
      isAdmin || profile.access_role === "election_officer";

    const memberScope: ElectionListenerScope | undefined =
      !isPrivileged && profile.ward_id && profile.polling_unit_id
        ? {
            ward_id: profile.ward_id,
            polling_unit_id: profile.polling_unit_id,
          }
        : undefined;

    if (!isPrivileged && !memberScope) {
      setLoading(false);
      return;
    }

    const unsubscribe = subscribeToElectionIncidents(
      profile.tenant_id,
      (docs) => {
        setIncidents(docs);
        setLoading(false);
      },
      (err) => {
        console.error("Failed to load election incidents:", err);
        setLoadError(
          "Election incidents could not be loaded. Please try again.",
        );
        setLoading(false);
      },
      memberScope,
    );

    return () => unsubscribe();
  }, [
    profile?.tenant_id,
    profile?.access_role,
    profile?.ward_id,
    profile?.polling_unit_id,
    isAdmin,
  ]);

  // Social-only members have zero Election module access.
  useEffect(() => {
    if (accessLoading || !profile) return;

    const isSocialOnly =
      profile.membership_types?.includes("social_member") &&
      !profile.membership_types?.includes("campaign_member") &&
      profile.access_role !== "election_officer" &&
      !isAdmin;

    if (isSocialOnly) {
      router.replace("/portal/dashboard");
    }
  }, [profile, accessLoading, isAdmin, router]);

  const selectedLga = lgas.find((l) => l.id === form.lga_id);
  const wards = selectedLga?.wards ?? [];
  const selectedWard = wards.find((w) => w.id === form.ward_id);
  const pollingUnits = selectedWard?.pollingUnits ?? [];

  // Scoped Filter for Non-Admins
  const filteredIncidents = incidents.filter((inc) => {
    if (isAdmin) return true;
    const activeAssignments = assignments.filter((a) => a.status === "active");
    if (activeAssignments.length === 0) {
      return inc.reported_by === profile?.id;
    }
    return (
      activeAssignments.some((a) =>
        assignmentCoversScope(
          a,
          { scope_type: "ward", scope_id: inc.ward_id },
          lgas,
        ),
      ) || inc.reported_by === profile?.id
    );
  });

  const handleImageChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (file) {
      setEvidenceFile(file);
      setEvidencePreview(URL.createObjectURL(file));
    }
  };

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();

    if (!form.ward_id) {
      toast.warning("Please select a ward for the incident.");
      return;
    }

    if (!form.description.trim()) {
      toast.warning("Please describe what happened before submitting.");
      return;
    }

    // Scoping check for non-admin
    if (!isAdmin) {
      if (form.ward_id !== profile?.ward_id) {
        toast.error(
          "You can only report incidents within your registered Ward.",
        );
        return;
      }
    }

    setSubmitting(true);
    try {
      let cloudinaryUrl: string | null = null;
      if (evidenceFile) {
        try {
          cloudinaryUrl = await uploadToCloudinary(
            evidenceFile,
            "ifeanyi-2027/incidents",
          );
        } catch (uploadErr) {
          console.warn("Cloudinary evidence upload fallback:", uploadErr);
        }
      }

      await createElectionIncident({
        ward_id: form.ward_id,
        polling_unit_id: form.polling_unit_id || null,
        incident_type: form.incident_type,
        severity: form.severity,
        description: form.description.trim(),
        reported_by: profile?.id || "unknown",
        cloudinary_url: cloudinaryUrl,
      });

      toast.success("Election incident reported. Administrators and Election Officers have been notified.");
      setShowForm(false);
      setForm({
        lga_id: profile?.lga_id ?? "nkanu-west",
        ward_id: profile?.ward_id ?? "",
        polling_unit_id: profile?.polling_unit_id ?? "",
        incident_type: "bavas_malfunction",
        severity: "medium",
        description: "",
      });
      setEvidenceFile(null);
      setEvidencePreview(null);
    } catch (err: any) {
      console.error("Failed to report election incident:", err);
      toast.error(
        getErrorMessage(err, "We couldn't submit the incident report. Please try again."),
      );
    } finally {
      setSubmitting(false);
    }
  };

  if (accessLoading || loading) {
    return (
      <div className="flex items-center justify-center min-h-[50vh]">
        <Loader2 className="h-8 w-8 animate-spin text-apc-primary" />
        <span className="ml-3 text-gray-500">Loading incident reports...</span>
      </div>
    );
  }

  return (
    <div className="max-w-5xl mx-auto space-y-6 pb-12">
      {/* Header */}
      <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-4">
        <div>
          <div className="flex flex-wrap items-center justify-between gap-3">
            <h1 className="text-2xl font-bold text-gray-900">
              Election Incident Reports
            </h1>
            <HelpLink article="election-incidents" label="Incidents guide" />
          </div>
          <p className="text-sm text-gray-500">
            Report and track irregularities, BVAS malfunctions, late arrivals,
            or security incidents.
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
              <button
                onClick={() => setShowForm(false)}
                className="p-1 hover:bg-gray-100 rounded"
              >
                <X className="h-5 w-5 text-gray-400" />
              </button>
            </div>
          </CardHeader>
          <CardContent>
            <form onSubmit={handleSubmit} className="space-y-4">
              {/* Location Selectors */}
              <div className="grid md:grid-cols-3 gap-4">
                <div>
                  <label className="block text-xs font-semibold text-gray-700 mb-1">
                    LGA *
                  </label>
                  <select
                    value={form.lga_id}
                    onChange={(e) =>
                      setForm({
                        ...form,
                        lga_id: e.target.value,
                        ward_id: "",
                        polling_unit_id: "",
                      })
                    }
                    className="w-full px-3 py-2 border rounded-lg text-sm bg-white"
                    required
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
                  <label className="block text-xs font-semibold text-gray-700 mb-1">
                    Ward *
                  </label>
                  <select
                    value={form.ward_id}
                    onChange={(e) =>
                      setForm({
                        ...form,
                        ward_id: e.target.value,
                        polling_unit_id: "",
                      })
                    }
                    disabled={!form.lga_id}
                    className="w-full px-3 py-2 border rounded-lg text-sm bg-white disabled:bg-gray-100"
                    required
                  >
                    <option value="">
                      {form.lga_id ? "Select ward" : "Select LGA first"}
                    </option>
                    {wards.map((w) => (
                      <option key={w.id} value={w.id}>
                        {w.code} — {w.name}
                      </option>
                    ))}
                  </select>
                </div>

                <div>
                  <label className="block text-xs font-semibold text-gray-700 mb-1">
                    Polling Unit (Optional)
                  </label>
                  <select
                    value={form.polling_unit_id}
                    onChange={(e) =>
                      setForm({ ...form, polling_unit_id: e.target.value })
                    }
                    disabled={!form.ward_id}
                    className="w-full px-3 py-2 border rounded-lg text-sm bg-white disabled:bg-gray-100"
                  >
                    <option value="">Entire Ward / Select Polling Unit</option>
                    {pollingUnits.map((pu) => (
                      <option key={pu.id} value={pu.id}>
                        {pu.code} — {pu.name}
                      </option>
                    ))}
                  </select>
                </div>
              </div>

              <div className="grid md:grid-cols-2 gap-4">
                <div>
                  <label className="block text-xs font-semibold text-gray-700 mb-1">
                    Incident Type *
                  </label>
                  <select
                    value={form.incident_type}
                    onChange={(e) =>
                      setForm({ ...form, incident_type: e.target.value as ElectionIncidentDoc["incident_type"] })
                    }
                    className="w-full px-3 py-2 border rounded-lg text-sm bg-white"
                    required
                  >
                    <option value="bavas_malfunction">
                      BVAS / Technical Failure
                    </option>
                    <option value="late_arrival">
                      Late Arrival of Materials
                    </option>
                    <option value="vote_buying">
                      Vote Buying / Inducement
                    </option>
                    <option value="ballot_snatching">
                      Ballot Snatching / Tampering
                    </option>
                    <option value="violence">
                      Disruption / Security Concern
                    </option>
                    <option value="other">Other Incident</option>
                  </select>
                </div>

                <div>
                  <label className="block text-xs font-semibold text-gray-700 mb-1">
                    Severity *
                  </label>
                  <select
                    value={form.severity}
                    onChange={(e) =>
                      setForm({ ...form, severity: e.target.value as ElectionIncidentDoc["severity"] })
                    }
                    className="w-full px-3 py-2 border rounded-lg text-sm bg-white"
                    required
                  >
                    <option value="low">Low — Minor Delay</option>
                    <option value="medium">Medium — Operational Concern</option>
                    <option value="high">High — Serious Disturbance</option>
                    <option value="critical">
                      Critical — Immediate Intervention Needed
                    </option>
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
                  value={form.description}
                  onChange={(e) =>
                    setForm({ ...form, description: e.target.value })
                  }
                  placeholder="Describe the incident in detail..."
                  className="w-full px-3 py-2 border rounded-lg text-sm bg-white"
                />
              </div>

              {/* Photo Evidence */}
              <div>
                <label className="block text-xs font-semibold text-gray-700 mb-1">
                  Photo / Video Evidence (Optional)
                </label>
                <div className="flex items-center gap-4">
                  <input
                    type="file"
                    accept="image/jpeg,image/png,image/webp"
                    onChange={handleImageChange}
                    className="text-xs text-gray-600 file:mr-3 file:py-2 file:px-3 file:rounded-lg file:border-0 file:text-xs file:font-semibold file:bg-red-600 file:text-white"
                  />
                  {evidencePreview && (
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
          <CardTitle>Reported Incidents ({filteredIncidents.length})</CardTitle>
        </CardHeader>
        <CardContent>
          {loadError ? (
            <p className="py-10 text-center text-sm text-red-600">
              {loadError}
            </p>
          ) : filteredIncidents.length === 0 ? (
            <div className="text-center py-10">
              <AlertTriangle className="h-12 w-12 text-gray-300 mx-auto mb-4" />
              <p className="text-gray-500">
                No election incidents reported in this scope.
              </p>
            </div>
          ) : (
            <div className="space-y-4">
              {filteredIncidents.map((inc) => (
                <div
                  key={inc.id}
                  className="bg-white border rounded-xl p-5 space-y-2"
                >
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
                    </div>

                    <span className="text-xs text-gray-400">
                      Ward: {inc.ward_id}{" "}
                      {inc.polling_unit_id
                        ? `· PU: ${inc.polling_unit_id}`
                        : ""}
                    </span>
                  </div>

                  <p className="text-sm text-gray-700 whitespace-pre-wrap">
                    {inc.description}
                  </p>

                  {inc.cloudinary_url && (
                    <div className="pt-2">
                      <a
                        href={inc.cloudinary_url}
                        target="_blank"
                        rel="noreferrer"
                        className="inline-flex items-center gap-1 text-xs font-semibold text-red-600 hover:underline"
                      >
                        <Upload className="h-3.5 w-3.5" /> View Photo Evidence
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
