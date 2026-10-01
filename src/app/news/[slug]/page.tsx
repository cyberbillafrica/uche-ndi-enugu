// src/app/news/[slug]/page.tsx

import { cache } from "react";
import { notFound } from "next/navigation";
import type { Metadata } from "next";
import Image from "next/image";
import Link from "next/link";

import { Calendar, Tag, ArrowLeft, User, MessageCircle } from "lucide-react";

import Header from "@/components/layout/Header";
import Footer from "@/components/layout/Footer";
import { getNewsBySlug } from "@/lib/supabase";

interface PageProps {
  params: Promise<{
    slug: string;
  }>;
}

const SITE_URL = (
  process.env.NEXT_PUBLIC_SITE_URL || "https://ifeanyichukwu-2027.vercel.app"
).replace(/\/+$/, "");

// ─────────────────────────────────────────────
// HELPERS
// ─────────────────────────────────────────────

function formatDate(rawTimestamp: any) {
  if (!rawTimestamp) return "Recent";

  let date: Date;

  if (rawTimestamp.seconds) {
    date = new Date(rawTimestamp.seconds * 1000);
  } else if (
    typeof rawTimestamp === "string" ||
    typeof rawTimestamp === "number"
  ) {
    date = new Date(rawTimestamp);
  } else {
    return "Recent";
  }

  return date.toLocaleDateString("en-US", {
    year: "numeric",
    month: "long",
    day: "numeric",
  });
}

function getArticleUrl(slug: string) {
  return `${SITE_URL}/news/${slug}`;
}

function getAbsoluteImageUrl(image?: string) {
  if (!image) return undefined;

  if (image.startsWith("http://") || image.startsWith("https://")) {
    return image;
  }

  const cleanPath = image.replace(/^\/+/, "");
  return `${SITE_URL}/${cleanPath}`;
}

// ─────────────────────────────────────────────
// CACHED FETCH – prevents duplicate requests
// ─────────────────────────────────────────────

const getArticle = cache(async (slug: string) => {
  // Canonical Supabase read; published rows only (RLS + explicit filter).
  const article = await getNewsBySlug(slug);

  if (!article || article.status !== "published") {
    return null;
  }

  return article;
});

// ─────────────────────────────────────────────
// METADATA – SEO + Social Previews
// ─────────────────────────────────────────────

export async function generateMetadata({
  params,
}: PageProps): Promise<Metadata> {
  const { slug } = await params;
  const article = await getArticle(slug);

  if (!article) {
    return {
      title: "Article Not Found | Campaign News",
      robots: {
        index: false,
        follow: false,
      },
    };
  }

  const articleUrl = getArticleUrl(article.slug);
  const imageUrl = getAbsoluteImageUrl(article.featured_image ?? undefined);

  const description =
    article.excerpt ||
    article.content?.substring(0, 160) ||
    "Latest campaign news and updates.";

  return {
    title: `${article.title} | Campaign News`,
    description,

    alternates: {
      canonical: articleUrl,
    },

    openGraph: {
      title: article.title,
      description,
      url: articleUrl,
      siteName: "Ifeanyi 2027 Campaign News",
      type: "article",

      ...(imageUrl && {
        images: [
          {
            url: imageUrl,
            width: 1200,
            height: 675,
            alt: article.title,
          },
        ],
      }),
    },

    twitter: {
      card: imageUrl ? "summary_large_image" : "summary",
      title: article.title,
      description,

      ...(imageUrl && {
        images: [imageUrl],
      }),
    },
  };
}

// ─────────────────────────────────────────────
// PAGE COMPONENT
// ─────────────────────────────────────────────

export default async function NewsArticleDetailPage({ params }: PageProps) {
  const { slug } = await params;

  const article = await getArticle(slug);

  if (!article) {
    notFound();
  }

  const articleUrl = getArticleUrl(article.slug);
  const shareText = `${article.title}\n\nRead the full article:`;

  return (
    <div className="min-h-screen bg-gray-50 flex flex-col">
      <Header />

      <main className="flex-1 max-w-4xl w-full mx-auto px-4 py-12 sm:px-6 lg:px-8">
        {/* Back Link */}
        <div className="mb-8">
          <Link
            href="/news"
            className="inline-flex items-center text-sm font-semibold text-brand-primary hover:text-brand-primary transition-colors"
          >
            <ArrowLeft className="mr-2 h-4 w-4" />
            Back to News
          </Link>
        </div>

        <article className="overflow-hidden rounded-2xl bg-white shadow-sm border border-gray-100 p-6 sm:p-10">
          {/* Category */}
          {article.category && (
            <div className="mb-4 inline-flex items-center gap-1.5 rounded-full bg-brand-primary/10 px-3 py-1 text-xs font-semibold text-brand-primary">
              <Tag className="h-3.5 w-3.5" />
              {article.category}
            </div>
          )}

          {/* Title */}
          <h1 className="text-3xl font-extrabold text-gray-900 sm:text-4xl leading-tight">
            {article.title}
          </h1>

          {/* Meta */}
          <div className="mt-4 mb-8 flex flex-wrap items-center gap-4 border-b border-gray-100 pb-6 text-sm text-gray-500">
            <span className="flex items-center gap-1.5">
              <Calendar className="h-4 w-4 text-brand-primary" />
              {formatDate(article.published_at || article.created_at)}
            </span>

            {article.author && (
              <span className="flex items-center gap-1.5">
                <User className="h-4 w-4 text-brand-primary" />
                {article.author}
              </span>
            )}
          </div>

          {/* Featured Image */}
          {article.featured_image && (
            <div className="relative mb-8 aspect-[16/9] w-full overflow-hidden rounded-xl bg-gray-100">
              <Image
                src={article.featured_image}
                alt={article.title}
                fill
                priority
                unoptimized
                className="object-cover"
                sizes="(max-width: 1024px) 100vw, 800px"
              />
            </div>
          )}

          {/* Excerpt */}
          {article.excerpt && (
            <p className="mb-8 text-lg font-medium text-gray-700 leading-relaxed italic border-l-4 border-brand-primary pl-4 py-1 bg-gray-50/50 rounded-r">
              {article.excerpt}
            </p>
          )}

          {/* Content */}
          <div className="prose prose-lg max-w-none text-gray-800 leading-relaxed whitespace-pre-wrap">
            {article.content}
          </div>

          {/* Share Section */}
          <div className="mt-12 border-t border-gray-200 pt-8">
            <h2 className="text-xl font-bold text-gray-900">
              Share with friends
            </h2>

            <p className="mt-1 mb-4 text-sm text-gray-500">
              Share this news update with your friends and community.
            </p>

            <div className="flex flex-wrap gap-3">
              {/* WhatsApp */}
              <a
                href={`https://wa.me/?text=${encodeURIComponent(
                  `${shareText}\n${articleUrl}`,
                )}`}
                target="_blank"
                rel="noopener noreferrer"
                className="inline-flex items-center gap-2 rounded-lg bg-[#25D366] px-4 py-2.5 text-sm font-semibold text-white transition-all hover:bg-[#1ebe5d] hover:-translate-y-0.5"
              >
                <MessageCircle className="h-4 w-4" />
                WhatsApp
              </a>

              {/* Facebook */}
              <a
                href={`https://www.facebook.com/sharer/sharer.php?u=${encodeURIComponent(
                  articleUrl,
                )}`}
                target="_blank"
                rel="noopener noreferrer"
                className="inline-flex items-center gap-2 rounded-lg bg-[#1877F2] px-4 py-2.5 text-sm font-semibold text-white transition-all hover:bg-[#166fe5] hover:-translate-y-0.5"
              >
                <span className="text-base font-bold leading-none">f</span>
                Facebook
              </a>

              {/* X */}
              <a
                href={`https://twitter.com/intent/tweet?text=${encodeURIComponent(
                  shareText,
                )}&url=${encodeURIComponent(articleUrl)}`}
                target="_blank"
                rel="noopener noreferrer"
                className="inline-flex items-center gap-2 rounded-lg bg-black px-4 py-2.5 text-sm font-semibold text-white transition-all hover:bg-gray-800 hover:-translate-y-0.5"
              >
                <span className="text-base font-bold leading-none">𝕏</span>X
              </a>
            </div>
          </div>
        </article>
      </main>

      <Footer />
    </div>
  );
}
