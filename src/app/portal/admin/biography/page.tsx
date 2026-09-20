// src/app/portal/admin/biography/page.tsx

"use client";

import { useState, useEffect, useCallback } from "react";
import { useRouter } from "next/navigation";
import Image from "next/image";
import {
  Loader2,
  Save,
  Eye,
  CheckCircle,
  AlertCircle,
  FileText,
  X,
  Upload,
  Trash2,
} from "lucide-react";

import { useAuth } from "@/contexts/AuthContext";
import { useToast } from "@/components/ui/toast";
import { getErrorMessage } from "@/lib/errors";
import { getBiography, updateBiography } from "@/lib/firebase/biography";
import { uploadToCloudinary } from "@/lib/cloudinary";
import { getCurrentTenant } from "@/lib/firebase/tenants";
import type { BiographyData } from "@/types";

const DEFAULT_BIOGRAPHY: Omit<
  BiographyData,
  "tenant_id" | "created_at" | "updated_at"
> = {
  full_name: "",
  title: "",
  about: "",
  image_url: null,
  stats: {
    years_experience: 0,
    communities_served: 0,
    volunteers: 0,
  },
  social_links: {
    facebook: "",
    x: "",
    instagram: "",
    tiktok: "",
  },
  status: "draft",
};

export default function AdminBiographyPage() {
  const { profile, loading: authLoading } = useAuth();
  const router = useRouter();
  const toast = useToast();

  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [bio, setBio] = useState<BiographyData | null>(null);
  const [uploadingImage, setUploadingImage] = useState(false);

  // ─── AUTH GUARD ───

  useEffect(() => {
    if (authLoading) return;
    if (!profile || profile.access_role !== "admin") {
      router.replace("/portal/dashboard");
    }
  }, [authLoading, profile, router]);

  // ─── LOAD ───

  const loadBiography = useCallback(async () => {
    try {
      setLoading(true);
      const tenant = await getCurrentTenant();
      const data = await getBiography(tenant.id);

      if (data) {
        setBio(data);
      } else {
        setBio({
          ...DEFAULT_BIOGRAPHY,
          tenant_id: tenant.id,
        } as BiographyData);
      }
    } catch (err) {
      console.error("Failed to load biography:", err);
      toast.error("We couldn't load the biography. Please refresh and try again.");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    if (!authLoading && profile?.access_role === "admin") {
      loadBiography();
    }
  }, [authLoading, profile, loadBiography]);

  // ─── SAVE ───

  const handleSave = async (status: "draft" | "published") => {
    if (!bio) return;

    if (!bio.full_name.trim()) {
      toast.warning("Please enter the candidate's full name.");
      return;
    }
    if (!bio.about.trim()) {
      toast.warning("Please write the biography content before saving.");
      return;
    }

    setSaving(true);

    try {
      const tenant = await getCurrentTenant();
      await updateBiography(tenant.id, {
        ...bio,
        status,
      });
      toast.success(
        `Biography ${status === "published" ? "published" : "saved as draft"} successfully.`,
      );
      await loadBiography();
    } catch (err) {
      console.error("Failed to save biography:", err);
      toast.error(getErrorMessage(err, "We couldn't save the biography. Please try again."));
    } finally {
      setSaving(false);
    }
  };

  // ─── IMAGE UPLOAD ───

  const handleImageUpload = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;

    setUploadingImage(true);

    try {
      const tenant = await getCurrentTenant();
      const url = await uploadToCloudinary(file, "ifeanyi-2027/candidate");
      setBio((prev) => {
        if (!prev) return prev;
        return { ...prev, image_url: url };
      });
      toast.success("Image uploaded successfully.");
    } catch (err) {
      console.error("Failed to upload image:", err);
      toast.error(getErrorMessage(err, "We couldn't upload the image. Please try again."));
    } finally {
      setUploadingImage(false);
      e.target.value = "";
    }
  };

  const removeImage = () => {
    setBio((prev) => {
      if (!prev) return prev;
      return { ...prev, image_url: null };
    });
  };

  // ─── LOADING ───

  if (authLoading || loading) {
    return (
      <div className="flex items-center justify-center min-h-[50vh]">
        <Loader2 className="h-8 w-8 animate-spin text-apc-primary" />
        <span className="ml-3 text-gray-500">Loading biography editor...</span>
      </div>
    );
  }

  if (!profile || profile.access_role !== "admin") {
    return null;
  }

  if (!bio) {
    return (
      <div className="flex items-center justify-center min-h-[50vh]">
        <div className="text-center">
          <AlertCircle className="h-12 w-12 text-gray-300 mx-auto mb-4" />
          <p className="text-gray-500">Unable to load biography data.</p>
          <button
            onClick={loadBiography}
            className="mt-4 text-apc-primary hover:underline"
          >
            Retry
          </button>
        </div>
      </div>
    );
  }

  const isPublished = bio.status === "published";

  return (
    <div className="max-w-4xl mx-auto space-y-6 pb-12">
      {/* ─── HEADER ─── */}
      <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-4">
        <div>
          <h1 className="text-2xl font-bold text-gray-900">Biography Editor</h1>
          <p className="text-sm text-gray-500">
            Manage your candidate biography.
          </p>
        </div>
        <div className="flex flex-wrap gap-3">
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

          <button
            onClick={() => handleSave("draft")}
            disabled={saving}
            className="inline-flex items-center gap-2 px-4 py-2 rounded-lg border border-gray-300 bg-white text-gray-700 font-semibold hover:bg-gray-50 transition-colors disabled:opacity-50"
          >
            <Save className="h-4 w-4" />
            {saving ? "Saving..." : "Save Draft"}
          </button>

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

          <a
            href="/biography"
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
      <div className="bg-white rounded-xl shadow-sm border border-gray-100 p-6 space-y-6">
        {/* Full Name */}
        <div>
          <label className="block text-sm font-medium text-gray-700 mb-1">
            Full Name *
          </label>
          <input
            value={bio.full_name}
            onChange={(e) => setBio({ ...bio, full_name: e.target.value })}
            placeholder="e.g. Ifeanyi Barth"
            className="w-full px-3 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-apc-primary focus:border-transparent"
          />
        </div>

        {/* Title */}
        <div>
          <label className="block text-sm font-medium text-gray-700 mb-1">
            Title
          </label>
          <input
            value={bio.title}
            onChange={(e) => setBio({ ...bio, title: e.target.value })}
            placeholder="e.g. APC Candidate, Nkanu West"
            className="w-full px-3 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-apc-primary focus:border-transparent"
          />
        </div>

        {/* About */}
        <div>
          <label className="block text-sm font-medium text-gray-700 mb-1">
            About / Biography *
          </label>
          <textarea
            rows={8}
            value={bio.about}
            onChange={(e) => setBio({ ...bio, about: e.target.value })}
            placeholder="Write a compelling biography..."
            className="w-full px-3 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-apc-primary focus:border-transparent"
          />
        </div>

        {/* Image Upload */}
        <div>
          <label className="block text-sm font-medium text-gray-700 mb-1">
            Profile Image
          </label>
          <div className="space-y-3">
            {bio.image_url ? (
              <div className="relative w-48 aspect-[4/5] overflow-hidden rounded-lg border bg-gray-100">
                <Image
                  src={bio.image_url}
                  alt="Profile image"
                  fill
                  unoptimized
                  className="object-cover"
                />
                <button
                  onClick={removeImage}
                  className="absolute top-2 right-2 rounded-full bg-black/60 p-1.5 text-white hover:bg-black"
                >
                  <Trash2 className="h-4 w-4" />
                </button>
              </div>
            ) : (
              <div className="flex items-center gap-3">
                <label className="cursor-pointer inline-flex items-center gap-2 rounded-lg bg-apc-primary px-4 py-2 text-sm font-semibold text-white hover:bg-apc-dark transition-colors">
                  <Upload className="h-4 w-4" />
                  {uploadingImage ? "Uploading..." : "Upload Image"}
                  <input
                    type="file"
                    accept="image/jpeg,image/png,image/webp"
                    onChange={handleImageUpload}
                    disabled={uploadingImage}
                    className="hidden"
                  />
                </label>
                <span className="text-xs text-gray-500">
                  JPG, PNG, WebP • Max 5MB
                </span>
              </div>
            )}
          </div>
        </div>

        {/* Stats */}
        <div className="border-t pt-6">
          <h3 className="text-sm font-semibold text-gray-700 mb-4">
            Statistics
          </h3>
          <div className="grid gap-4 md:grid-cols-3">
            <div>
              <label className="block text-sm font-medium text-gray-700 mb-1">
                Years Experience
              </label>
              <input
                type="number"
                min="0"
                value={bio.stats.years_experience}
                onChange={(e) =>
                  setBio({
                    ...bio,
                    stats: {
                      ...bio.stats,
                      years_experience: parseInt(e.target.value) || 0,
                    },
                  })
                }
                className="w-full px-3 py-2 border border-gray-300 rounded-lg"
              />
            </div>
            <div>
              <label className="block text-sm font-medium text-gray-700 mb-1">
                Communities Served
              </label>
              <input
                type="number"
                min="0"
                value={bio.stats.communities_served}
                onChange={(e) =>
                  setBio({
                    ...bio,
                    stats: {
                      ...bio.stats,
                      communities_served: parseInt(e.target.value) || 0,
                    },
                  })
                }
                className="w-full px-3 py-2 border border-gray-300 rounded-lg"
              />
            </div>
            <div>
              <label className="block text-sm font-medium text-gray-700 mb-1">
                Volunteers
              </label>
              <input
                type="number"
                min="0"
                value={bio.stats.volunteers}
                onChange={(e) =>
                  setBio({
                    ...bio,
                    stats: {
                      ...bio.stats,
                      volunteers: parseInt(e.target.value) || 0,
                    },
                  })
                }
                className="w-full px-3 py-2 border border-gray-300 rounded-lg"
              />
            </div>
          </div>
        </div>

        {/* Social Links */}
        <div className="border-t pt-6">
          <h3 className="text-sm font-semibold text-gray-700 mb-4">
            Social Links
          </h3>
          <div className="grid gap-4 md:grid-cols-2">
            <div>
              <label className="block text-sm font-medium text-gray-700 mb-1">
                Facebook
              </label>
              <input
                value={bio.social_links?.facebook || ""}
                onChange={(e) =>
                  setBio({
                    ...bio,
                    social_links: {
                      ...bio.social_links,
                      facebook: e.target.value,
                    },
                  })
                }
                placeholder="https://facebook.com/..."
                className="w-full px-3 py-2 border border-gray-300 rounded-lg"
              />
            </div>
            <div>
              <label className="block text-sm font-medium text-gray-700 mb-1">
                X
              </label>
              <input
                value={bio.social_links?.x || ""}
                onChange={(e) =>
                  setBio({
                    ...bio,
                    social_links: { ...bio.social_links, x: e.target.value },
                  })
                }
                placeholder="https://x.com/..."
                className="w-full px-3 py-2 border border-gray-300 rounded-lg"
              />
            </div>
            <div>
              <label className="block text-sm font-medium text-gray-700 mb-1">
                Instagram
              </label>
              <input
                value={bio.social_links?.instagram || ""}
                onChange={(e) =>
                  setBio({
                    ...bio,
                    social_links: {
                      ...bio.social_links,
                      instagram: e.target.value,
                    },
                  })
                }
                placeholder="https://instagram.com/..."
                className="w-full px-3 py-2 border border-gray-300 rounded-lg"
              />
            </div>
            <div>
              <label className="block text-sm font-medium text-gray-700 mb-1">
                TikTok
              </label>
              <input
                value={bio.social_links?.tiktok || ""}
                onChange={(e) =>
                  setBio({
                    ...bio,
                    social_links: {
                      ...bio.social_links,
                      tiktok: e.target.value,
                    },
                  })
                }
                placeholder="https://tiktok.com/@..."
                className="w-full px-3 py-2 border border-gray-300 rounded-lg"
              />
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
