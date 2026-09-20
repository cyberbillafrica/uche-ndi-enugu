// src/app/portal/admin/gallery/page.tsx

"use client";

import { useState, useEffect, useCallback } from "react";
import { useRouter } from "next/navigation";
import Image from "next/image";
import {
  Loader2,
  Upload,
  Trash2,
  AlertCircle,
  CheckCircle,
  X,
  Plus,
  Image as ImageIcon,
} from "lucide-react";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";

import { useAuth } from "@/contexts/AuthContext";
import { useToast } from "@/components/ui/toast";
import { getErrorMessage } from "@/lib/errors";
import {
  getGallery,
  updateGallery,
  addGalleryImage,
  removeGalleryImage,
} from "@/lib/firebase/gallery";
import { uploadToCloudinary } from "@/lib/cloudinary";
import { getCurrentTenant } from "@/lib/firebase/tenants";
import type { GalleryImage } from "@/types";

export default function AdminGalleryPage() {
  const { profile, loading: authLoading } = useAuth();
  const router = useRouter();
  const toast = useToast();

  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [images, setImages] = useState<GalleryImage[]>([]);
  const [uploading, setUploading] = useState(false);
  const [tenantId, setTenantId] = useState<string>("");
  const [pendingUploadUrl, setPendingUploadUrl] = useState<string | null>(null);
  const [imageTitle, setImageTitle] = useState("");
  const [imageDescription, setImageDescription] = useState("");
  const [detailsOpen, setDetailsOpen] = useState(false);

  // ─── AUTH GUARD ───

  useEffect(() => {
    if (authLoading) return;
    if (!profile || profile.access_role !== "admin") {
      router.replace("/portal/dashboard");
    }
  }, [authLoading, profile, router]);

  // ─── LOAD ───

  const loadGallery = useCallback(async () => {
    try {
      setLoading(true);
      const tenant = await getCurrentTenant();
      setTenantId(tenant.id);
      const data = await getGallery(tenant.id);
      setImages(data?.images || []);
    } catch (err) {
      console.error("Failed to load gallery:", err);
      toast.error("We couldn't load the gallery. Please refresh and try again.");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    if (!authLoading && profile?.access_role === "admin") {
      loadGallery();
    }
  }, [authLoading, profile, loadGallery]);

  // ─── UPLOAD ───

  const handleImageUpload = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;

    setUploading(true);

    try {
      const url = await uploadToCloudinary(file, "ifeanyi-2027/gallery");

      setPendingUploadUrl(url);
      setImageTitle("");
      setImageDescription("");
      setDetailsOpen(true);
    } catch (err) {
      console.error("Failed to upload image:", err);
      toast.error(getErrorMessage(err, "We couldn't upload the image. Please try again."));
    } finally {
      setUploading(false);
      e.target.value = "";
    }
  };

  const handleSaveImageDetails = async () => {
    if (!pendingUploadUrl) return;

    setSaving(true);

    try {
      await addGalleryImage(tenantId, {
        url: pendingUploadUrl,
        title: imageTitle.trim() || "Gallery image",
        description: imageDescription.trim() || undefined,
      });
      setDetailsOpen(false);
      setPendingUploadUrl(null);
      await loadGallery();
      toast.success("Image added to the gallery.");
    } catch (err) {
      console.error("Failed to save image details:", err);
      toast.error(getErrorMessage(err, "We couldn't save the image details. Please try again."));
    } finally {
      setSaving(false);
    }
  };

  // ─── DELETE ───

  const handleDelete = async (imageId: string) => {
    if (!confirm("Remove this image from the gallery?")) return;

    try {
      await removeGalleryImage(tenantId, imageId);
      await loadGallery();
      toast.success("Image removed from the gallery.");
    } catch (err) {
      console.error("Failed to remove image:", err);
      toast.error(getErrorMessage(err, "We couldn't remove the image. Please try again."));
    }
  };

  // ─── LOADING ───

  if (authLoading || loading) {
    return (
      <div className="flex items-center justify-center min-h-[50vh]">
        <Loader2 className="h-8 w-8 animate-spin text-apc-primary" />
        <span className="ml-3 text-gray-500">Loading gallery...</span>
      </div>
    );
  }

  if (!profile || profile.access_role !== "admin") {
    return null;
  }

  return (
    <div className="max-w-6xl mx-auto space-y-6 pb-12">
      {/* ─── HEADER ─── */}
      <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-4">
        <div>
          <h1 className="text-2xl font-bold text-gray-900">Gallery Editor</h1>
          <p className="text-sm text-gray-500">
            Manage campaign photos. {images.length} images in gallery.
          </p>
        </div>
        <div>
          <label className="cursor-pointer inline-flex items-center gap-2 rounded-lg bg-apc-primary px-4 py-2.5 text-sm font-semibold text-white hover:bg-apc-dark transition-colors disabled:opacity-50">
            <Upload className="h-4 w-4" />
            {uploading ? "Uploading..." : "Upload Image"}
            <input
              type="file"
              accept="image/jpeg,image/png,image/webp"
              onChange={handleImageUpload}
              disabled={uploading}
              className="hidden"
            />
          </label>
        </div>
      </div>

      <Dialog open={detailsOpen} onOpenChange={setDetailsOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Add image details</DialogTitle>
            <DialogDescription>
              Add an optional title and description before publishing this
              image.
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-4">
            <div>
              <label
                htmlFor="gallery-title"
                className="mb-1.5 block text-sm font-medium text-gray-700"
              >
                Title
              </label>
              <Input
                id="gallery-title"
                value={imageTitle}
                onChange={(event) => setImageTitle(event.target.value)}
                placeholder="Gallery image"
              />
            </div>
            <div>
              <label
                htmlFor="gallery-description"
                className="mb-1.5 block text-sm font-medium text-gray-700"
              >
                Description
              </label>
              <textarea
                id="gallery-description"
                value={imageDescription}
                onChange={(event) => setImageDescription(event.target.value)}
                placeholder="Optional description"
                rows={3}
                className="w-full rounded-md border border-input bg-transparent px-3 py-2 text-sm outline-none focus:border-ring focus:ring-3 focus:ring-ring/50"
              />
            </div>
          </div>
          <DialogFooter>
            <button
              type="button"
              onClick={() => setDetailsOpen(false)}
              className="rounded-lg border border-gray-300 px-4 py-2 text-sm font-medium text-gray-700 hover:bg-gray-50"
              disabled={saving}
            >
              Cancel
            </button>
            <button
              type="button"
              onClick={handleSaveImageDetails}
              className="rounded-lg bg-apc-primary px-4 py-2 text-sm font-semibold text-white hover:bg-apc-dark disabled:opacity-50"
              disabled={saving}
            >
              {saving ? "Saving..." : "Save image"}
            </button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* ─── GALLERY GRID ─── */}
      {images.length === 0 ? (
        <div className="rounded-2xl bg-white border-2 border-dashed border-gray-300 p-16 text-center">
          <ImageIcon className="h-16 w-16 text-gray-300 mx-auto mb-4" />
          <p className="text-gray-500">No images uploaded yet.</p>
          <p className="text-sm text-gray-400 mt-1">
            Click "Upload Image" to add photos.
          </p>
        </div>
      ) : (
        <div className="grid grid-cols-2 md:grid-cols-3 lg:grid-cols-4 gap-4">
          {images.map((image) => (
            <div
              key={image.id}
              className="group relative aspect-square overflow-hidden rounded-xl bg-gray-100 shadow-sm border"
            >
              <Image
                src={image.url}
                alt={image.title || "Gallery image"}
                fill
                unoptimized
                className="object-cover"
                sizes="(max-width: 768px) 50vw, 25vw"
              />
              <div className="absolute inset-0 bg-black/0 group-hover:bg-black/40 transition-all">
                <button
                  onClick={() => handleDelete(image.id)}
                  className="absolute top-2 right-2 rounded-full bg-red-600 p-1.5 text-white opacity-0 group-hover:opacity-100 transition-opacity hover:bg-red-700"
                  aria-label="Delete image"
                >
                  <Trash2 className="h-4 w-4" />
                </button>
                {image.title && (
                  <div className="absolute bottom-0 inset-x-0 bg-gradient-to-t from-black/60 to-transparent p-3">
                    <p className="text-sm font-medium text-white truncate">
                      {image.title}
                    </p>
                    {image.description && (
                      <p className="text-xs text-white/80 truncate">
                        {image.description}
                      </p>
                    )}
                  </div>
                )}
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
