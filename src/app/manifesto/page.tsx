// src/app/manifesto/page.tsx

import type { Metadata } from "next";
import Link from "next/link";
import { Download, ArrowRight, CheckCircle2 } from "lucide-react";

import Header from "@/components/layout/Header";
import Footer from "@/components/layout/Footer";
import ShareButtons from "@/components/ShareButtons";

import { getManifesto } from "@/lib/supabase";

// ─────────────────────────────────────────────
// METADATA
// ─────────────────────────────────────────────

export async function generateMetadata(): Promise<Metadata> {
  // Canonical Supabase read; RLS shows anonymous visitors the published row only.
  const manifesto = await getManifesto();

  if (!manifesto || manifesto.status !== "published") {
    return {
      title: "Manifesto | Campaign",
      description: "Our vision and commitments for progress.",
    };
  }

  return {
    title: `${manifesto.title} | ${manifesto.candidate_name}`,
    description: manifesto.subtitle || manifesto.introduction?.slice(0, 160),
  };
}

// ─────────────────────────────────────────────
// PAGE
// ─────────────────────────────────────────────

export default async function ManifestoPage() {
  const manifesto = await getManifesto();

  if (!manifesto || manifesto.status !== "published") {
    return <ManifestoComingSoon />;
  }

  const {
    title,
    subtitle,
    introduction,
    sections,
    closing,
    call_to_action,
    call_to_action_link,
    candidate_name,
    candidate_title,
    pdf_url,
  } = manifesto;

  return (
    <div className="min-h-screen bg-gray-50 flex flex-col">
      <Header />

      <main className="flex-1 max-w-5xl w-full mx-auto px-4 py-12 sm:px-6 lg:px-8">
        {/* ─── HERO ─── */}
        <section className="text-center mb-12">
          <p className="text-sm font-semibold uppercase tracking-wider text-apc-primary">
            {candidate_title}
          </p>

          <h1 className="mt-3 text-4xl sm:text-5xl font-bold text-gray-900">
            {title}
          </h1>

          <p className="mt-4 max-w-3xl mx-auto text-lg text-gray-600">
            {subtitle}
          </p>

          <p className="mt-3 text-sm text-gray-500">{candidate_name}</p>

          {pdf_url && (
            <a
              href={pdf_url}
              target="_blank"
              rel="noopener noreferrer"
              className="mt-6 inline-flex items-center gap-2 rounded-lg bg-apc-primary px-6 py-3 text-sm font-semibold text-white hover:bg-apc-dark transition-colors"
            >
              <Download className="h-5 w-5" />
              Download Manifesto (PDF)
            </a>
          )}
        </section>

        {/* ─── INTRODUCTION ─── */}
        <section className="mb-12 rounded-2xl bg-white border border-gray-100 p-8 shadow-sm">
          <p className="text-lg leading-relaxed text-gray-700">
            {introduction}
          </p>
        </section>

        {/* ─── SECTIONS ─── */}
        <div className="grid gap-8 md:grid-cols-2 lg:grid-cols-3">
          {sections.map((section) => (
            <div
              key={section.id}
              className="rounded-xl bg-white border border-gray-100 p-6 shadow-sm hover:shadow-md transition-shadow"
            >
              {section.icon && (
                <div className="mb-3 text-3xl">{section.icon}</div>
              )}

              <h2 className="text-xl font-semibold text-apc-primary">
                {section.title}
              </h2>

              <p className="mt-2 text-sm leading-relaxed text-gray-600">
                {section.description}
              </p>

              <ul className="mt-5 space-y-3">
                {section.points.map((point, index) => (
                  <li
                    key={index}
                    className="flex items-start gap-2 text-sm text-gray-700"
                  >
                    <CheckCircle2 className="mt-0.5 h-4 w-4 shrink-0 text-apc-green" />
                    <span>{point}</span>
                  </li>
                ))}
              </ul>
            </div>
          ))}
        </div>

        {/* ─── CLOSING ─── */}
        <section className="mt-12 rounded-2xl bg-apc-primary/5 border border-apc-primary/10 p-8 text-center">
          <p className="mx-auto max-w-3xl text-lg font-medium text-gray-800">
            {closing}
          </p>

          {call_to_action_link && (
            <Link
              href={call_to_action_link}
              className="mt-6 inline-flex items-center gap-2 rounded-lg bg-apc-green px-8 py-3 font-semibold text-white hover:bg-green-700 transition-colors"
            >
              {call_to_action}
              <ArrowRight className="h-5 w-5" />
            </Link>
          )}
        </section>

        {/* ─── SHARE ─── */}
        <ShareButtons />
      </main>

      <Footer />
    </div>
  );
}

// ─────────────────────────────────────────────
// COMING SOON
// ─────────────────────────────────────────────

function ManifestoComingSoon() {
  return (
    <div className="min-h-screen bg-gray-50 flex flex-col">
      <Header />

      <main className="flex flex-1 items-center justify-center px-4 py-12">
        <div className="text-center max-w-2xl">
          <div className="text-6xl mb-6">📋</div>
          <h1 className="text-3xl font-bold text-gray-900">
            Manifesto Coming Soon
          </h1>
          <p className="mt-3 text-gray-600 max-w-md mx-auto">
            Our vision and commitments for Nkanu West will be published shortly.
            Check back for updates.
          </p>
          <Link
            href="/"
            className="mt-6 inline-flex items-center gap-2 text-apc-primary font-semibold hover:underline"
          >
            ← Back to Home
          </Link>
        </div>
      </main>

      <Footer />
    </div>
  );
}
