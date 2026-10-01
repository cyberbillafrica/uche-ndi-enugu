// src/app/gallery/page.tsx

import type { Metadata } from "next";
import Image from "next/image";
import Link from "next/link";
import { Camera } from "lucide-react";

import Header from "@/components/layout/Header";
import Footer from "@/components/layout/Footer";
import { getGallery } from "@/lib/supabase";

export const dynamic = "force-dynamic";

export async function generateMetadata(): Promise<Metadata> {
  return {
    title: "Gallery | Campaign",
    description:
      "Photos from campaign events, community visits, and volunteer activities.",
  };
}

export default async function GalleryPage() {
  // Canonical Supabase read; RLS shows anonymous visitors the published row only.
  const gallery = await getGallery();
  const images = gallery?.images || [];

  return (
    <div className="min-h-screen bg-gray-50 flex flex-col">
      <Header />

      <main className="flex-1 max-w-6xl w-full mx-auto px-4 py-12 sm:px-6 lg:px-8">
        <div className="mb-10">
          <h1 className="text-4xl font-bold text-brand-primary">Gallery</h1>
          <p className="mt-2 text-lg text-gray-600">
            Photos from campaign events, community visits, and volunteer
            activities.
          </p>
        </div>

        {images.length === 0 ? (
          <div className="rounded-2xl bg-white p-16 text-center shadow-sm border">
            <Camera className="h-16 w-16 text-gray-300 mx-auto mb-4" />
            <p className="text-gray-500">No images uploaded yet.</p>
            <p className="text-sm text-gray-400 mt-1">
              Check back soon for photos.
            </p>
          </div>
        ) : (
          <div className="grid grid-cols-2 md:grid-cols-3 lg:grid-cols-4 gap-4">
            {images.map((image) => (
              <div
                key={image.id}
                className="group relative aspect-square overflow-hidden rounded-xl bg-gray-100 shadow-sm hover:shadow-md transition-shadow"
              >
                <Image
                  src={image.url}
                  alt={image.title || "Gallery image"}
                  fill
                  unoptimized
                  className="object-cover transition-transform duration-300 group-hover:scale-105"
                  sizes="(max-width: 768px) 50vw, 25vw"
                />
                {image.title && (
                  <div className="absolute inset-x-0 bottom-0 bg-gradient-to-t from-black/60 via-transparent to-transparent p-4">
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
            ))}
          </div>
        )}
      </main>

      <Footer />
    </div>
  );
}
