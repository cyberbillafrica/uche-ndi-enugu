"use client";

import { useEffect, useState } from "react";
import { useAuth } from "@/contexts/AuthContext";
import {
  createPUReport,
  subscribeToPUReports,
  type PUReportDoc,
} from "@/lib/firebase/election";
import { uploadToCloudinary } from "@/lib/cloudinary";
import { getAllLGAs } from "@/lib/constants";
import { assignmentCoversScope, isAdminUser } from "@/lib/permissions";
import type { LGA } from "@/types";

import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import {
  FileText,
  Plus,
  Loader2,
  CheckCircle2,
  AlertCircle,
  Upload,
  X,
  MapPin,
  Lock,
} from "lucide-react";

export default function PUReportsPage() {
  const { profile, assignments, accessLoading } = useAuth();
  const isAdmin = isAdminUser(profile);

  const [lgas, setLgas] = useState<LGA[]>([]);
  const [reports, setReports] = useState<PUReportDoc[]>([]);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState("");

  // Form State
  const [showForm, setShowForm] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [formError, setFormError] = useState("");
  const [successMsg, setSuccessMessage] = useState("");

  const [form, setForm] = useState({
    lga_id: profile?.lga_id ?? "nkanu-west",
    ward_id: profile?.ward_id ?? "",
    polling_unit_id: profile?.polling_unit_id ?? "",
    report_type: "conduct" as PUReportDoc["report_type"],
    title: "",
    content: "",
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

  // Real-time PU Reports Listener
  useEffect(() => {
    if (!profile?.tenant_id) return;

    const unsubscribe = subscribeToPUReports(
      profile.tenant_id,
      (docs) => {
        setReports(docs);
        setLoading(false);
      },
      (err) => {
        console.error("Failed to load PU reports:", err);
        setLoadError("PU reports could not be loaded. Please try again.");
        setLoading(false);
      },
    );

    return () => unsubscribe();
  }, [profile?.tenant_id]);

  const selectedLga = lgas.find((l) => l.id === form.lga_id);
  const wards = selectedLga?.wards ?? [];
  const selectedWard = wards.find((w) => w.id === form.ward_id);
  const pollingUnits = selectedWard?.pollingUnits ?? [];

  // Scoped Filter for Non-Admins
  const filteredReports = reports.filter((r) => {
    if (isAdmin) return true;
    const activeAssignments = assignments.filter((a) => a.status === "active");
    if (activeAssignments.length === 0) {
      // Members can always view their own submitted PU reports
      return r.submitted_by === profile?.id;
    }
    return (
      activeAssignments.some(
        (a) =>
          assignmentCoversScope(
            a,
            { scope_type: "ward", scope_id: r.ward_id },
            lgas,
          ) ||
          assignmentCoversScope(
            a,
            { scope_type: "polling_unit", scope_id: r.polling_unit_id },
            lgas,
          ),
      ) || r.submitted_by === profile?.id
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
    setFormError("");
    setSuccessMessage("");

    if (!form.ward_id || !form.polling_unit_id) {
      setFormError("Ward and polling unit are required.");
      return;
    }

    if (!form.title.trim() || !form.content.trim()) {
      setFormError("Title and description content are required.");
      return;
    }

    // Scoping check for non-admin
    if (!isAdmin) {
      if (
        form.ward_id !== profile?.ward_id ||
        form.polling_unit_id !== profile?.polling_unit_id
      ) {
        setFormError(
          "You can only submit PU reports for your registered Ward and Polling Unit.",
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
            "ifeanyi-2027/pu-reports",
          );
        } catch (uploadErr) {
          console.warn("Cloudinary evidence upload fallback:", uploadErr);
        }
      }

      await createPUReport({
        ward_id: form.ward_id,
        polling_unit_id: form.polling_unit_id,
        submitted_by: profile?.id || "unknown",
        report_type: form.report_type,
        title: form.title.trim(),
        content: form.content.trim(),
        cloudinary_url: cloudinaryUrl,
      });

      setSuccessMessage("Polling unit report submitted successfully!");
      setShowForm(false);
      setForm({
        lga_id: profile?.lga_id ?? "nkanu-west",
        ward_id: profile?.ward_id ?? "",
        polling_unit_id: profile?.polling_unit_id ?? "",
        report_type: "conduct",
        title: "",
        content: "",
      });
      setEvidenceFile(null);
      setEvidencePreview(null);
    } catch (err: any) {
      console.error("Failed to create PU report:", err);
      setFormError(err.message || "Failed to submit report. Please try again.");
    } finally {
      setSubmitting(false);
    }
  };

  if (accessLoading || loading) {
    return (
      <div className="flex items-center justify-center min-h-[50vh]">
        <Loader2 className="h-8 w-8 animate-spin text-apc-primary" />
        <span className="ml-3 text-gray-500">Loading PU reports...</span>
      </div>
    );
  }

  return (
    <div className="max-w-5xl mx-auto space-y-6 pb-12">
      {/* Header */}
      <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-4">
        <div>
          <h1 className="text-2xl font-bold text-gray-900">
            Polling Unit Reports
          </h1>
          <p className="text-sm text-gray-500">
            Submit and inspect polling unit conduct, opening, turnout, and
            closing reports.
          </p>
        </div>

        <button
          onClick={() => {
            setShowForm((prev) => !prev);
            setFormError("");
            setSuccessMessage("");
          }}
          className="inline-flex items-center gap-2 rounded-lg bg-apc-primary px-4 py-2.5 text-sm font-semibold text-white hover:bg-apc-dark transition-colors"
        >
          <Plus className="h-4 w-4" />
          {showForm ? "Cancel" : "Submit PU Report"}
        </button>
      </div>

      {successMsg && (
        <div className="flex items-center gap-2 p-4 bg-green-50 text-green-700 rounded-lg border border-green-200 text-sm">
          <CheckCircle2 className="h-5 w-5 shrink-0" />
          <span>{successMsg}</span>
        </div>
      )}

      {/* Form */}
      {showForm && (
        <Card className="border-apc-primary/20">
          <CardHeader>
            <div className="flex items-center justify-between">
              <CardTitle className="text-lg">
                Submit Polling Unit Report
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
              {formError && (
                <div className="flex items-center gap-2 p-3 bg-red-50 text-red-700 rounded-lg border border-red-200 text-sm">
                  <AlertCircle className="h-4 w-4 shrink-0" />
                  <span>{formError}</span>
                </div>
              )}

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
                    className="w-full px-3 py-2 border rounded-lg text-sm"
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
                    className="w-full px-3 py-2 border rounded-lg text-sm disabled:bg-gray-100"
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
                    Polling Unit *
                  </label>
                  <select
                    value={form.polling_unit_id}
                    onChange={(e) =>
                      setForm({ ...form, polling_unit_id: e.target.value })
                    }
                    disabled={!form.ward_id}
                    className="w-full px-3 py-2 border rounded-lg text-sm disabled:bg-gray-100"
                    required
                  >
                    <option value="">
                      {form.ward_id
                        ? "Select polling unit"
                        : "Select Ward first"}
                    </option>
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
                    Report Type *
                  </label>
                  <select
                    value={form.report_type}
                    onChange={(e) =>
                      setForm({ ...form, report_type: e.target.value as PUReportDoc["report_type"] })
                    }
                    className="w-full px-3 py-2 border rounded-lg text-sm"
                    required
                  >
                    <option value="opening">PU Opening & Setup</option>
                    <option value="turnout">Voter Turnout</option>
                    <option value="conduct">Voting Conduct</option>
                    <option value="closing">PU Closing & Counting</option>
                    <option value="general">General PU Report</option>
                  </select>
                </div>

                <div>
                  <label className="block text-xs font-semibold text-gray-700 mb-1">
                    Report Title *
                  </label>
                  <input
                    type="text"
                    required
                    value={form.title}
                    onChange={(e) =>
                      setForm({ ...form, title: e.target.value })
                    }
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
                  value={form.content}
                  onChange={(e) =>
                    setForm({ ...form, content: e.target.value })
                  }
                  placeholder="Provide detailed observation of polling unit proceedings..."
                  className="w-full px-3 py-2 border rounded-lg text-sm"
                />
              </div>

              {/* Photo Evidence */}
              <div>
                <label className="block text-xs font-semibold text-gray-700 mb-1">
                  Photo Evidence (Optional)
                </label>
                <div className="flex items-center gap-4">
                  <input
                    type="file"
                    accept="image/jpeg,image/png,image/webp"
                    onChange={handleImageChange}
                    className="text-xs text-gray-600 file:mr-3 file:py-2 file:px-3 file:rounded-lg file:border-0 file:text-xs file:font-semibold file:bg-apc-primary file:text-white"
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
                  className="inline-flex items-center gap-2 rounded-lg bg-apc-primary px-5 py-2 text-sm font-semibold text-white hover:bg-apc-dark disabled:opacity-50"
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
          <CardTitle>Reports ({filteredReports.length})</CardTitle>
        </CardHeader>
        <CardContent>
          {loadError ? (
            <p className="py-10 text-center text-sm text-red-600">
              {loadError}
            </p>
          ) : filteredReports.length === 0 ? (
            <div className="text-center py-10">
              <FileText className="h-12 w-12 text-gray-300 mx-auto mb-4" />
              <p className="text-gray-500">
                No polling unit reports submitted in this scope yet.
              </p>
            </div>
          ) : (
            <div className="space-y-4">
              {filteredReports.map((r) => (
                <div
                  key={r.id}
                  className="bg-white border rounded-xl p-5 space-y-2"
                >
                  <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-2">
                    <div className="flex items-center gap-2">
                      <span className="px-2.5 py-0.5 rounded-full text-xs font-semibold bg-apc-primary/10 text-apc-primary uppercase">
                        {r.report_type}
                      </span>
                      <h3 className="font-bold text-gray-900">{r.title}</h3>
                    </div>

                    <span className="text-xs text-gray-400">
                      PU: {r.polling_unit_id} · Ward: {r.ward_id}
                    </span>
                  </div>

                  <p className="text-sm text-gray-700 whitespace-pre-wrap">
                    {r.content}
                  </p>

                  {r.cloudinary_url && (
                    <div className="pt-2">
                      <a
                        href={r.cloudinary_url}
                        target="_blank"
                        rel="noreferrer"
                        className="inline-flex items-center gap-1 text-xs font-semibold text-apc-primary hover:underline"
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
