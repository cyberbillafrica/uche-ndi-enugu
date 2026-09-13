/**
 * Cloudinary Upload Utility for Ifeanyi 2027 Campaign Application
 *
 * Folder structure conventions:
 * - News: "ifeanyi-2027/news"
 * - Gallery: "ifeanyi-2027/gallery"
 * - Candidate: "ifeanyi-2027/candidate"
 * - Election Results: "ifeanyi-2027/election-results"
 * - Manifestos: "ifeanyi-2027/candidate/{tenantId}/manifestos" (inside candidate)
 */

export const CLOUDINARY_CLOUD_NAME =
  process.env.NEXT_PUBLIC_CLOUDINARY_CLOUD_NAME || "dvvwuktq";

export const CLOUDINARY_UPLOAD_PRESET =
  process.env.NEXT_PUBLIC_CLOUDINARY_UPLOAD_PRESET || "ifeanyichukwu-2027";

export type CloudinaryFolder =
  | "ifeanyi-2027/news"
  | "ifeanyi-2027/gallery"
  | "ifeanyi-2027/candidate"
  | "ifeanyi-2027/election-results"
  | "ifeanyi-2027/pu-reports"
  | "ifeanyi-2027/incidents";

// ─────────────────────────────────────────────
// IMAGE UPLOAD (existing)
// ─────────────────────────────────────────────

export async function uploadToCloudinary(
  file: File,
  folder: CloudinaryFolder = "ifeanyi-2027/news",
): Promise<string> {
  const allowedTypes = ["image/jpeg", "image/png", "image/webp"];
  if (!allowedTypes.includes(file.type)) {
    throw new Error(
      "Invalid file type. Only JPG, PNG, and WebP images are allowed.",
    );
  }

  const maxSize = 5 * 1024 * 1024; // 5 MB
  if (file.size > maxSize) {
    throw new Error("File size exceeds 5MB limit.");
  }

  const formData = new FormData();
  formData.append("file", file);
  formData.append("upload_preset", CLOUDINARY_UPLOAD_PRESET);
  formData.append("folder", folder);

  const endpoint = `https://api.cloudinary.com/v1_1/${CLOUDINARY_CLOUD_NAME}/image/upload`;

  const response = await fetch(endpoint, {
    method: "POST",
    body: formData,
  });

  if (!response.ok) {
    const errorData = await response.json().catch(() => ({}));
    throw new Error(
      errorData.error?.message ||
        `Cloudinary upload failed with status ${response.status}`,
    );
  }

  const data = await response.json();
  if (!data.secure_url) {
    throw new Error("Cloudinary upload succeeded but no URL was returned.");
  }

  return data.secure_url;
}

// ─────────────────────────────────────────────
// PDF UPLOAD (new – for manifestos)
// ─────────────────────────────────────────────

/**
 * Upload a PDF file to Cloudinary.
 * Default folder: "ifeanyi-2027/candidate" – you can pass a subfolder like "ifeanyi-2027/candidate/{tenantId}"
 */
export async function uploadPDFToCloudinary(
  file: File,
  folder: string = "ifeanyi-2027/candidate",
): Promise<string> {
  // Validate file type
  if (file.type !== "application/pdf") {
    throw new Error("Invalid file type. Only PDF files are allowed.");
  }

  // Validate size (max 10MB)
  const maxSize = 10 * 1024 * 1024; // 10 MB
  if (file.size > maxSize) {
    throw new Error("File size exceeds 10MB limit.");
  }

  const formData = new FormData();
  formData.append("file", file);
  formData.append("upload_preset", CLOUDINARY_UPLOAD_PRESET);
  formData.append("folder", folder);

  // IMPORTANT: Tell Cloudinary this is a raw file (not an image)
  formData.append("resource_type", "raw");

  const endpoint = `https://api.cloudinary.com/v1_1/${CLOUDINARY_CLOUD_NAME}/raw/upload`;

  const response = await fetch(endpoint, {
    method: "POST",
    body: formData,
  });

  if (!response.ok) {
    const errorData = await response.json().catch(() => ({}));
    throw new Error(
      errorData.error?.message ||
        `Cloudinary upload failed with status ${response.status}`,
    );
  }

  const data = await response.json();
  if (!data.secure_url) {
    throw new Error("Cloudinary upload succeeded but no URL was returned.");
  }

  return data.secure_url;
}
