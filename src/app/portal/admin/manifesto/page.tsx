// src/app/portal/admin/manifesto/page.tsx

"use client";

import { useState, useEffect, useCallback } from "react";
import { useRouter } from "next/navigation";
import Image from "next/image";
import {
  Loader2,
  Plus,
  Trash2,
  Download,
  Upload,
  X,
  Eye,
  Save,
  FileText,
  CheckCircle,
  AlertCircle,
} from "lucide-react";

import { useAuth } from "@/contexts/AuthContext";
import { getManifesto, updateManifesto } from "@/lib/firebase/manifesto";
import { uploadPDFToCloudinary } from "@/lib/cloudinary";
import { useToast } from "@/components/ui/toast";
import { getErrorMessage } from "@/lib/errors";
import { getCurrentTenant } from "@/lib/firebase/tenants";
import type { ManifestoData, ManifestoSection } from "@/types";

// ─────────────────────────────────────────────
// DEFAULTS
// ─────────────────────────────────────────────

const DEFAULT_SECTION: Omit<ManifestoSection, "id"> = {
  title: "",
  icon: "📋",
  description: "",
  points: [""],
};

const DEFAULT_MANIFESTO: Omit<
  ManifestoData,
  "tenant_id" | "created_at" | "updated_at"
> = {
  title: "Our Manifesto",
  subtitle: "A blueprint for progress",
  introduction: "",
  candidate_name: "",
  candidate_title: "",
  sections: [],
  closing: "",
  call_to_action: "Join the Movement",
  call_to_action_link: "/volunteer",
  pdf_url: null,
  status: "draft",
};

// ─────────────────────────────────────────────
// PAGE
// ─────────────────────────────────────────────

export default function AdminManifestoPage() {
  const { profile, loading: authLoading } = useAuth();
  const toast = useToast();
  const router = useRouter();

  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [manifesto, setManifesto] = useState<ManifestoData | null>(null);
  const [uploadingPDF, setUploadingPDF] = useState(false);

  // ─── AUTH GUARD ───

  useEffect(() => {
    if (authLoading) return;
    if (!profile || profile.access_role !== "admin") {
      router.replace("/portal/dashboard");
    }
  }, [authLoading, profile, router]);

  // ─── LOAD ───

  const loadManifesto = useCallback(async () => {
    try {
      setLoading(true);
      const tenant = await getCurrentTenant();
      const data = await getManifesto(tenant.id);

      if (data) {
        setManifesto(data);
      } else {
        // Start with empty manifesto
        setManifesto({
          ...DEFAULT_MANIFESTO,
          tenant_id: tenant.id,
        } as ManifestoData);
      }
    } catch (err) {
      console.error("Failed to load manifesto:", err);
      toast.error("We couldn't load the manifesto. Please refresh and try again.");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    if (!authLoading && profile?.access_role === "admin") {
      loadManifesto();
    }
  }, [authLoading, profile, loadManifesto]);

  // ─── SAVE ───

  const handleSave = async (status: "draft" | "published") => {
    if (!manifesto) return;

    // Validate required fields
    if (!manifesto.title.trim()) {
      toast.warning("Please enter a title for the manifesto.");
      return;
    }
    if (!manifesto.introduction.trim()) {
      toast.warning("Please write the introduction section.");
      return;
    }
    if (manifesto.sections.length === 0) {
      toast.warning("Please add at least one manifesto section.");
      return;
    }

    setSaving(true);

    try {
      const tenant = await getCurrentTenant();
      await updateManifesto(tenant.id, {
        ...manifesto,
        status,
      });
      toast.success(
        `Manifesto ${status === "published" ? "published" : "saved as draft"} successfully.`,
      );
      await loadManifesto();
    } catch (err) {
      console.error("Failed to save manifesto:", err);
      toast.error(getErrorMessage(err, "We couldn't save the manifesto. Please try again."));
    } finally {
      setSaving(false);
    }
  };

  // ─── SECTION HELPERS ───

  const addSection = () => {
    setManifesto((prev) => {
      if (!prev) return prev;
      return {
        ...prev,
        sections: [
          ...prev.sections,
          {
            ...DEFAULT_SECTION,
            id: `section-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
          },
        ],
      };
    });
  };

  const removeSection = (id: string) => {
    if (!confirm("Remove this section?")) return;
    setManifesto((prev) => {
      if (!prev) return prev;
      return {
        ...prev,
        sections: prev.sections.filter((s) => s.id !== id),
      };
    });
  };

  const updateSection = (id: string, updates: Partial<ManifestoSection>) => {
    setManifesto((prev) => {
      if (!prev) return prev;
      return {
        ...prev,
        sections: prev.sections.map((s) =>
          s.id === id ? { ...s, ...updates } : s,
        ),
      };
    });
  };

  const addPoint = (sectionId: string) => {
    setManifesto((prev) => {
      if (!prev) return prev;
      return {
        ...prev,
        sections: prev.sections.map((s) =>
          s.id === sectionId ? { ...s, points: [...s.points, ""] } : s,
        ),
      };
    });
  };

  const removePoint = (sectionId: string, index: number) => {
    setManifesto((prev) => {
      if (!prev) return prev;
      return {
        ...prev,
        sections: prev.sections.map((s) =>
          s.id === sectionId
            ? { ...s, points: s.points.filter((_, i) => i !== index) }
            : s,
        ),
      };
    });
  };

  const updatePoint = (sectionId: string, index: number, value: string) => {
    setManifesto((prev) => {
      if (!prev) return prev;
      return {
        ...prev,
        sections: prev.sections.map((s) =>
          s.id === sectionId
            ? {
                ...s,
                points: s.points.map((p, i) => (i === index ? value : p)),
              }
            : s,
        ),
      };
    });
  };

  // ─── PDF UPLOAD ───

  const handlePDFUpload = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;

    // Validate file type
    if (file.type !== "application/pdf") {
      toast.warning("Please upload a PDF file.");
      return;
    }

    // Validate size (max 10MB)
    if (file.size > 10 * 1024 * 1024) {
      toast.warning("The PDF file must be smaller than 10MB.");
      return;
    }

    setUploadingPDF(true);

    try {
      const tenant = await getCurrentTenant();
      // Upload to Cloudinary with tenant-specific folder
      const url = await uploadPDFToCloudinary(
        file,
        `ifeanyi-2027/manifestos/${tenant.id}`,
      );

      setManifesto((prev) => {
        if (!prev) return prev;
        return { ...prev, pdf_url: url };
      });
      toast.success("PDF uploaded successfully.");
    } catch (err) {
      console.error("Failed to upload PDF:", err);
      toast.error(getErrorMessage(err, "We couldn't upload the PDF. Please try again."));
    } finally {
      setUploadingPDF(false);
      // Reset the input
      e.target.value = "";
    }
  };

  const removePDF = () => {
    if (!confirm("Remove the uploaded PDF?")) return;
    setManifesto((prev) => {
      if (!prev) return prev;
      return { ...prev, pdf_url: null };
    });
    toast.info("PDF removed from the manifesto.");
  };

  // ─── LOADING ───

  if (authLoading || loading) {
    return (
      <div className="flex items-center justify-center min-h-[50vh]">
        <Loader2 className="h-8 w-8 animate-spin text-apc-primary" />
        <span className="ml-3 text-gray-500">Loading manifesto editor...</span>
      </div>
    );
  }

  if (!profile || profile.access_role !== "admin") {
    return null;
  }

  if (!manifesto) {
    return (
      <div className="flex items-center justify-center min-h-[50vh]">
        <div className="text-center">
          <AlertCircle className="h-12 w-12 text-gray-300 mx-auto mb-4" />
          <p className="text-gray-500">Unable to load manifesto data.</p>
          <button
            onClick={loadManifesto}
            className="mt-4 text-apc-primary hover:underline"
          >
            Retry
          </button>
        </div>
      </div>
    );
  }

  // ─── PAGE ───

  const isPublished = manifesto.status === "published";

  return (
    <div className="max-w-5xl mx-auto space-y-6 pb-12">
      {/* ─── HEADER ─── */}
      <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-4">
        <div>
          <h1 className="text-2xl font-bold text-gray-900">Manifesto Editor</h1>
          <p className="text-sm text-gray-500">
            Create and manage your campaign manifesto.
          </p>
        </div>
        <div className="flex flex-wrap gap-3">
          {/* Status Badge */}
          <span
            className={`inline-flex items-center gap-2 px-3 py-1.5 rounded-full text-sm font-medium ${
              isPublished
                ? "bg-green-100 text-green-700"
                : "bg-yellow-100 text-yellow-700"
            }`}
          >
            {isPublished ? (
              <>
                <CheckCircle className="h-4 w-4" />
                Published
              </>
            ) : (
              <>
                <FileText className="h-4 w-4" />
                Draft
              </>
            )}
          </span>

          {/* Save as Draft */}
          <button
            onClick={() => handleSave("draft")}
            disabled={saving}
            className="inline-flex items-center gap-2 px-4 py-2 rounded-lg border border-gray-300 bg-white text-gray-700 font-semibold hover:bg-gray-50 transition-colors disabled:opacity-50"
          >
            <Save className="h-4 w-4" />
            {saving ? "Saving..." : "Save Draft"}
          </button>

          {/* Publish / Unpublish */}
          <button
            onClick={() => handleSave(isPublished ? "draft" : "published")}
            disabled={saving}
            className={`inline-flex items-center gap-2 px-4 py-2 rounded-lg font-semibold transition-colors disabled:opacity-50 ${
              isPublished
                ? "bg-yellow-500 text-white hover:bg-yellow-600"
                : "bg-apc-primary text-white hover:bg-apc-dark"
            }`}
          >
            {isPublished ? (
              <>
                <X className="h-4 w-4" />
                Unpublish
              </>
            ) : (
              <>
                <CheckCircle className="h-4 w-4" />
                Publish
              </>
            )}
          </button>

          {/* Preview */}
          <a
            href="/manifesto"
            target="_blank"
            rel="noopener noreferrer"
            className="inline-flex items-center gap-2 px-4 py-2 rounded-lg border border-gray-300 bg-white text-gray-700 font-semibold hover:bg-gray-50 transition-colors"
          >
            <Eye className="h-4 w-4" />
            Preview
          </a>
        </div>
      </div>


      {/* ─── FORM ─── */}
      <div className="space-y-8">
        {/* Basic Info */}
        <section className="bg-white rounded-xl shadow-sm border border-gray-100 p-6">
          <h2 className="text-lg font-semibold text-gray-900 mb-4">
            Basic Information
          </h2>

          <div className="grid gap-4 md:grid-cols-2">
            <div>
              <label className="block text-sm font-medium text-gray-700 mb-1">
                Title *
              </label>
              <input
                value={manifesto.title}
                onChange={(e) =>
                  setManifesto({ ...manifesto, title: e.target.value })
                }
                placeholder="e.g. Our Manifesto"
                className="w-full px-3 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-apc-primary focus:border-transparent"
              />
            </div>

            <div>
              <label className="block text-sm font-medium text-gray-700 mb-1">
                Subtitle
              </label>
              <input
                value={manifesto.subtitle}
                onChange={(e) =>
                  setManifesto({ ...manifesto, subtitle: e.target.value })
                }
                placeholder="e.g. A blueprint for progress"
                className="w-full px-3 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-apc-primary focus:border-transparent"
              />
            </div>

            <div>
              <label className="block text-sm font-medium text-gray-700 mb-1">
                Candidate Name *
              </label>
              <input
                value={manifesto.candidate_name}
                onChange={(e) =>
                  setManifesto({ ...manifesto, candidate_name: e.target.value })
                }
                placeholder="e.g. Ifeanyi Barth"
                className="w-full px-3 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-apc-primary focus:border-transparent"
              />
            </div>

            <div>
              <label className="block text-sm font-medium text-gray-700 mb-1">
                Candidate Title
              </label>
              <input
                value={manifesto.candidate_title}
                onChange={(e) =>
                  setManifesto({
                    ...manifesto,
                    candidate_title: e.target.value,
                  })
                }
                placeholder="e.g. APC Candidate, Nkanu West"
                className="w-full px-3 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-apc-primary focus:border-transparent"
              />
            </div>

            <div className="md:col-span-2">
              <label className="block text-sm font-medium text-gray-700 mb-1">
                Introduction *
              </label>
              <textarea
                rows={4}
                value={manifesto.introduction}
                onChange={(e) =>
                  setManifesto({ ...manifesto, introduction: e.target.value })
                }
                placeholder="A compelling introduction to your manifesto..."
                className="w-full px-3 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-apc-primary focus:border-transparent"
              />
            </div>

            <div className="md:col-span-2">
              <label className="block text-sm font-medium text-gray-700 mb-1">
                Closing Statement
              </label>
              <textarea
                rows={2}
                value={manifesto.closing}
                onChange={(e) =>
                  setManifesto({ ...manifesto, closing: e.target.value })
                }
                placeholder="A powerful closing message..."
                className="w-full px-3 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-apc-primary focus:border-transparent"
              />
            </div>

            <div>
              <label className="block text-sm font-medium text-gray-700 mb-1">
                Call to Action
              </label>
              <input
                value={manifesto.call_to_action}
                onChange={(e) =>
                  setManifesto({ ...manifesto, call_to_action: e.target.value })
                }
                placeholder="e.g. Join the Movement"
                className="w-full px-3 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-apc-primary focus:border-transparent"
              />
            </div>

            <div>
              <label className="block text-sm font-medium text-gray-700 mb-1">
                Call to Action Link
              </label>
              <input
                value={manifesto.call_to_action_link}
                onChange={(e) =>
                  setManifesto({
                    ...manifesto,
                    call_to_action_link: e.target.value,
                  })
                }
                placeholder="/volunteer"
                className="w-full px-3 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-apc-primary focus:border-transparent"
              />
            </div>
          </div>
        </section>

        {/* ─── SECTIONS ─── */}
        <section className="bg-white rounded-xl shadow-sm border border-gray-100 p-6">
          <div className="flex items-center justify-between mb-4">
            <div>
              <h2 className="text-lg font-semibold text-gray-900">Sections</h2>
              <p className="text-sm text-gray-500">
                Each section represents a key pillar of your manifesto.
              </p>
            </div>
            <button
              onClick={addSection}
              className="inline-flex items-center gap-2 px-3 py-1.5 rounded-lg bg-apc-primary/10 text-apc-primary text-sm font-medium hover:bg-apc-primary/20 transition-colors"
            >
              <Plus className="h-4 w-4" />
              Add Section
            </button>
          </div>

          {manifesto.sections.length === 0 ? (
            <div className="text-center py-12 border-2 border-dashed border-gray-200 rounded-lg">
              <FileText className="h-12 w-12 text-gray-300 mx-auto mb-3" />
              <p className="text-gray-500">No sections yet</p>
              <button
                onClick={addSection}
                className="mt-3 text-apc-primary hover:underline font-medium"
              >
                + Add your first section
              </button>
            </div>
          ) : (
            <div className="space-y-6">
              {manifesto.sections.map((section) => (
                <div
                  key={section.id}
                  className="border border-gray-200 rounded-lg p-4 space-y-4 relative"
                >
                  <div className="flex items-start justify-between gap-4">
                    <div className="flex-1 grid gap-3 md:grid-cols-2">
                      <div>
                        <label className="block text-xs font-medium text-gray-700 mb-1">
                          Icon (emoji)
                        </label>
                        <input
                          value={section.icon || ""}
                          onChange={(e) =>
                            updateSection(section.id, { icon: e.target.value })
                          }
                          placeholder="📋"
                          className="w-full px-2 py-1.5 border border-gray-300 rounded text-sm"
                        />
                      </div>
                      <div>
                        <label className="block text-xs font-medium text-gray-700 mb-1">
                          Title *
                        </label>
                        <input
                          value={section.title}
                          onChange={(e) =>
                            updateSection(section.id, { title: e.target.value })
                          }
                          placeholder="e.g. Infrastructure Development"
                          className="w-full px-2 py-1.5 border border-gray-300 rounded text-sm"
                        />
                      </div>
                      <div className="md:col-span-2">
                        <label className="block text-xs font-medium text-gray-700 mb-1">
                          Description
                        </label>
                        <input
                          value={section.description}
                          onChange={(e) =>
                            updateSection(section.id, {
                              description: e.target.value,
                            })
                          }
                          placeholder="Brief description of this pillar"
                          className="w-full px-2 py-1.5 border border-gray-300 rounded text-sm"
                        />
                      </div>
                    </div>
                    <button
                      onClick={() => removeSection(section.id)}
                      className="text-red-400 hover:text-red-600 p-1 shrink-0"
                      aria-label="Remove section"
                    >
                      <Trash2 className="h-4 w-4" />
                    </button>
                  </div>

                  {/* Points */}
                  <div className="pl-4 border-l-2 border-gray-200 space-y-2">
                    <div className="flex items-center justify-between">
                      <label className="text-xs font-medium text-gray-700">
                        Commitments / Points
                      </label>
                      <button
                        onClick={() => addPoint(section.id)}
                        className="text-xs text-apc-primary hover:underline"
                      >
                        + Add point
                      </button>
                    </div>

                    {section.points.map((point, idx) => (
                      <div key={idx} className="flex gap-2">
                        <input
                          value={point}
                          onChange={(e) =>
                            updatePoint(section.id, idx, e.target.value)
                          }
                          placeholder={`Point ${idx + 1}`}
                          className="flex-1 px-2 py-1.5 border border-gray-300 rounded text-sm"
                        />
                        <button
                          onClick={() => removePoint(section.id, idx)}
                          className="text-red-400 hover:text-red-600 p-1"
                          aria-label="Remove point"
                        >
                          <Trash2 className="h-3.5 w-3.5" />
                        </button>
                      </div>
                    ))}
                  </div>
                </div>
              ))}
            </div>
          )}
        </section>

        {/* ─── PDF UPLOAD ─── */}
        <section className="bg-white rounded-xl shadow-sm border border-gray-100 p-6">
          <h2 className="text-lg font-semibold text-gray-900 mb-4">
            Manifesto PDF
          </h2>

          <div className="space-y-4">
            {manifesto.pdf_url ? (
              <div className="flex items-center gap-4 p-4 bg-green-50 border border-green-200 rounded-lg">
                <FileText className="h-8 w-8 text-green-600" />
                <div className="flex-1 min-w-0">
                  <p className="text-sm font-medium text-green-800 truncate">
                    PDF uploaded
                  </p>
                  <a
                    href={manifesto.pdf_url}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="text-xs text-apc-primary hover:underline"
                  >
                    View PDF
                  </a>
                </div>
                <button
                  onClick={removePDF}
                  className="text-red-500 hover:text-red-700 p-1"
                >
                  <Trash2 className="h-4 w-4" />
                </button>
              </div>
            ) : (
              <div className="border-2 border-dashed border-gray-300 rounded-lg p-8 text-center">
                <Upload className="h-10 w-10 text-gray-400 mx-auto mb-3" />
                <p className="text-sm text-gray-600">
                  Upload a PDF version of your manifesto
                </p>
                <p className="text-xs text-gray-400 mt-1">
                  PDF files up to 10MB
                </p>
                <label className="mt-4 inline-flex items-center gap-2 px-4 py-2 rounded-lg bg-apc-primary text-white text-sm font-medium cursor-pointer hover:bg-apc-dark transition-colors">
                  <Upload className="h-4 w-4" />
                  {uploadingPDF ? "Uploading..." : "Choose PDF"}
                  <input
                    type="file"
                    accept=".pdf"
                    onChange={handlePDFUpload}
                    disabled={uploadingPDF}
                    className="hidden"
                  />
                </label>
              </div>
            )}
          </div>
        </section>
      </div>
    </div>
  );
}
