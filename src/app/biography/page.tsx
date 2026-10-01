// src/app/biography/page.tsx

import type { Metadata } from "next";
import Image from "next/image";
import Link from "next/link";
import { User, Users, MapPin, Heart, ArrowRight } from "lucide-react";

import Header from "@/components/layout/Header";
import Footer from "@/components/layout/Footer";
import { getBiography } from "@/lib/supabase";
import ShareButtons from "@/components/ShareButtons";

export async function generateMetadata(): Promise<Metadata> {
  // Canonical Supabase read; RLS shows anonymous visitors the published row only.
  const bio = await getBiography();

  if (!bio || bio.status !== "published") {
    return {
      title: "Biography | Campaign",
      description: "Learn about our candidate and their vision for progress.",
    };
  }

  return {
    title: `${bio.full_name} | Biography`,
    description: bio.about?.slice(0, 160) || `Learn about ${bio.full_name}`,
  };
}

export default async function BiographyPage() {
  const bio = await getBiography();

  if (!bio || bio.status !== "published") {
    return <BiographyComingSoon />;
  }

  const { full_name, title, about, image_url, stats, social_links } = bio;

  return (
    <div className="min-h-screen bg-gray-50 flex flex-col">
      <Header />

      <main className="flex-1 max-w-5xl w-full mx-auto px-4 py-12 sm:px-6 lg:px-8">
        {/* ─── HERO ─── */}
        <section className="text-center mb-12">
          <p className="text-sm font-semibold uppercase tracking-wider text-brand-primary">
            {title}
          </p>
          <h1 className="mt-3 text-4xl sm:text-5xl font-bold text-gray-900">
            {full_name}
          </h1>
        </section>

        {/* ─── BIOGRAPHY CONTENT ─── */}
        <div className="grid gap-12 md:grid-cols-2">
          {/* Image */}
          <div className="relative aspect-[4/5] overflow-hidden rounded-2xl bg-gradient-to-br from-brand-primary/10 to-brand-secondary/10">
            {image_url ? (
              <Image
                src={image_url}
                alt={full_name}
                fill
                unoptimized
                className="object-cover"
                sizes="(max-width: 768px) 100vw, 50vw"
                priority
              />
            ) : (
              <div className="flex h-full items-center justify-center text-brand-primary/20">
                <User className="h-24 w-24" />
              </div>
            )}
          </div>

          {/* About */}
          <div className="space-y-6">
            <h2 className="text-2xl font-bold text-brand-primary">About</h2>
            <div className="text-gray-700 leading-relaxed whitespace-pre-wrap">
              {about}
            </div>

            {/* Stats */}
            <div className="grid grid-cols-3 gap-4 pt-4 border-t border-gray-200">
              <div className="text-center">
                <div className="text-3xl font-bold text-brand-primary">
                  {stats?.years_experience || "—"}
                </div>
                <div className="text-sm text-gray-500">Years Experience</div>
              </div>
              <div className="text-center">
                <div className="text-3xl font-bold text-brand-primary">
                  {stats?.communities_served || "—"}
                </div>
                <div className="text-sm text-gray-500">Communities Served</div>
              </div>
              <div className="text-center">
                <div className="text-3xl font-bold text-brand-primary">
                  {stats?.volunteers || "—"}
                </div>
                <div className="text-sm text-gray-500">Volunteers</div>
              </div>
            </div>

            {/* Social Links */}
            {social_links && (
              <div className="pt-4 border-t border-gray-200">
                <h3 className="text-sm font-semibold text-gray-700 mb-3">
                  Connect
                </h3>
                <div className="flex gap-3">
                  {social_links.facebook && (
                    <a
                      href={social_links.facebook}
                      target="_blank"
                      rel="noopener noreferrer"
                      className="p-2 rounded-lg bg-[#1877F2] text-white hover:opacity-80"
                    >
                      <span className="sr-only">Facebook</span>
                      <span className="font-bold">f</span>
                    </a>
                  )}
                  {social_links.x && (
                    <a
                      href={social_links.x}
                      target="_blank"
                      rel="noopener noreferrer"
                      className="p-2 rounded-lg bg-black text-white hover:opacity-80"
                    >
                      <span className="sr-only">X</span>
                      <span className="font-bold">𝕏</span>
                    </a>
                  )}
                  {social_links.instagram && (
                    <a
                      href={social_links.instagram}
                      target="_blank"
                      rel="noopener noreferrer"
                      className="p-2 rounded-lg bg-gradient-to-r from-[#833AB4] to-[#F77737] text-white hover:opacity-80"
                    >
                      <span className="sr-only">Instagram</span>
                      <span className="font-bold">📷</span>
                    </a>
                  )}
                  {social_links.tiktok && (
                    <a
                      href={social_links.tiktok}
                      target="_blank"
                      rel="noopener noreferrer"
                      className="p-2 rounded-lg bg-black text-white hover:opacity-80"
                    >
                      <span className="sr-only">TikTok</span>
                      <span className="font-bold">♪</span>
                    </a>
                  )}
                </div>
              </div>
            )}

            <Link
              href="/volunteer"
              className="inline-flex items-center gap-2 bg-brand-primary text-white px-6 py-3 rounded-lg font-semibold hover:bg-green-700 transition-colors"
            >
              Join the Movement
              <ArrowRight className="h-5 w-5" />
            </Link>
          </div>
        </div>

        {/* ─── SHARE ─── */}
        <ShareButtons />
      </main>

      <Footer />
    </div>
  );
}

function BiographyComingSoon() {
  return (
    <div className="min-h-screen bg-gray-50 flex flex-col">
      <Header />
      <main className="flex flex-1 items-center justify-center px-4 py-12">
        <div className="text-center max-w-2xl">
          <div className="text-6xl mb-6">👤</div>
          <h1 className="text-3xl font-bold text-gray-900">
            Biography Coming Soon
          </h1>
          <p className="mt-3 text-gray-600">
            Our candidate's biography will be published shortly.
          </p>
          <Link
            href="/"
            className="mt-6 inline-flex items-center gap-2 text-brand-primary font-semibold hover:underline"
          >
            ← Back to Home
          </Link>
        </div>
      </main>
      <Footer />
    </div>
  );
}
