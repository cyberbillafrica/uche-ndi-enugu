"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import Image from "next/image";
import Header from "@/components/layout/Header";
import Footer from "@/components/layout/Footer";
import { Calendar, Tag, ArrowRight, Loader2, AlertCircle } from "lucide-react";
import { getPublishedNews } from "@/lib/firebase/firestore";
import { useToast } from "@/components/ui/toast";
import type { NewsArticle } from "@/types";

export default function NewsPage() {
  const [articles, setArticles] = useState<NewsArticle[]>([]);
  const [loading, setLoading] = useState(true);
  const toast = useToast();

  useEffect(() => {
    async function loadNews() {
      try {
        setLoading(true);
        const data = await getPublishedNews(50);
        setArticles(data);
      } catch (err: any) {
        console.error("Error loading news articles:", err);
        toast.error("Unable to load news updates. Please check your connection and try again.");
      } finally {
        setLoading(false);
      }
    }

    loadNews();
  }, []);

  function formatDate(rawTimestamp: any) {
    if (!rawTimestamp) return "Recent";
    let date: Date;
    if (rawTimestamp.seconds) {
      date = new Date(rawTimestamp.seconds * 1000);
    } else if (typeof rawTimestamp === "string" || typeof rawTimestamp === "number") {
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

  return (
    <div className="min-h-screen bg-gray-50 flex flex-col">
      <Header />

      <main className="flex-1 max-w-5xl w-full mx-auto px-4 py-12 sm:px-6 lg:px-8">
        <div className="mb-10 text-center sm:text-left">
          <h1 className="text-3xl font-bold text-apc-primary sm:text-4xl">
            Campaign News & Updates
          </h1>
          <p className="mt-2 text-gray-600 text-lg">
            Stay informed with the latest developments, statements, and community engagements across Nkanu West.
          </p>
        </div>

        {loading && (
          <div className="flex min-h-[300px] flex-col items-center justify-center gap-3 text-gray-500">
            <Loader2 className="h-8 w-8 animate-spin text-apc-primary" />
            <p className="text-sm font-medium">Loading latest articles…</p>
          </div>
        )}

        {!loading && articles.length === 0 && (
          <div className="rounded-2xl bg-white p-12 text-center shadow-sm my-8 border">
            <p className="text-lg font-medium text-gray-700">No news updates published yet.</p>
            <p className="mt-2 text-sm text-gray-500">
              Check back soon for latest campaign coverage and updates.
            </p>
          </div>
        )}

        {!loading && articles.length > 0 && (
          <div className="grid gap-8 md:grid-cols-3">
            {articles.map((article) => (
              <article
                key={article.id}
                className="group flex flex-col overflow-hidden rounded-2xl bg-white shadow-sm transition-all hover:-translate-y-1 hover:shadow-md border border-gray-100"
              >
                {article.featured_image ? (
                  <div className="relative aspect-[16/9] w-full overflow-hidden bg-gray-100">
                    <Image
                      src={article.featured_image}
                      alt={article.title}
                      fill
                      unoptimized
                      className="object-cover transition-transform duration-300 group-hover:scale-105"
                      sizes="(max-width: 768px) 100vw, 50vw"
                    />
                  </div>
                ) : (
                  <div className="relative aspect-[16/9] w-full overflow-hidden bg-gradient-to-br from-apc-primary/10 to-apc-secondary/10 flex items-center justify-center">
                    <span className="text-3xl font-bold text-apc-primary/20">Ifeanyi 2027</span>
                  </div>
                )}

                <div className="flex flex-1 flex-col p-6">
                  <div className="mb-3 flex items-center gap-4 text-xs font-medium text-gray-500">
                    <span className="flex items-center gap-1">
                      <Calendar className="h-3.5 w-3.5 text-apc-primary" />
                      {formatDate(article.published_at || article.created_at)}
                    </span>
                    {article.category && (
                      <span className="flex items-center gap-1 rounded-full bg-apc-primary/10 px-2.5 py-0.5 text-apc-primary">
                        <Tag className="h-3 w-3" />
                        {article.category}
                      </span>
                    )}
                  </div>

                  <h2 className="mb-3 text-xl font-bold text-gray-900 transition-colors group-hover:text-apc-primary">
                    {article.title}
                  </h2>

                  <p className="mb-6 flex-1 text-sm text-gray-600 line-clamp-3 leading-relaxed">
                    {article.excerpt || article.content}
                  </p>

                  <Link
                    href={`/news/${article.slug}`}
                    className="inline-flex items-center text-sm font-semibold text-apc-primary hover:text-apc-dark"
                  >
                    Read full article
                    <ArrowRight className="ml-1.5 h-4 w-4 transition-transform group-hover:translate-x-1" />
                  </Link>
                </div>
              </article>
            ))}
          </div>
        )}
      </main>

      <Footer />
    </div>
  );
}
