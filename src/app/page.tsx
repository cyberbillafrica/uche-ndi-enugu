"use client";

import { useEffect, useState } from "react";
import Image from "next/image";
import Link from "next/link";
import {
  Calendar,
  ArrowRight,
  Users,
  Target,
  Heart,
  MapPin,
  Tag,
  Loader2,
  FileText,
} from "lucide-react";

import Header from "@/components/layout/Header";
import Footer from "@/components/layout/Footer";
import ElectionCountdown from "@/components/home/ElectionCountdown";

import {
  listPublishedNews,
  listPublishedEvents,
  type NewsArticle,
  type SiteEvent,
} from "@/lib/supabase";

export default function HomePage() {
  const [latestNews, setLatestNews] = useState<NewsArticle[]>([]);
  const [events, setEvents] = useState<SiteEvent[]>([]);
  const [newsLoading, setNewsLoading] = useState(true);

  useEffect(() => {
    async function loadHomepageData() {
      setNewsLoading(true);

      // Load news and events independently so a failure in one data source
      // cannot blank out the other section of the homepage. Both flow from
      // the canonical Supabase content services: published rows only (RLS
      // enforces visibility for anonymous visitors).
      try {
        const newsData = await listPublishedNews(3);
        setLatestNews(newsData);
      } catch (err) {
        console.error("Failed to load homepage news:", err);
      } finally {
        setNewsLoading(false);
      }

      try {
        const eventsData = await listPublishedEvents();
        setEvents(eventsData);
      } catch (err) {
        console.error("Failed to load homepage events:", err);
      }
    }

    loadHomepageData();
  }, []);

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
      month: "short",
      day: "numeric",
    });
  }

  return (
    <div className="min-h-screen bg-gray-50">
      <Header />

      {/* Election Countdown */}
      <ElectionCountdown />

      {/* =========================================================
          HERO SECTION
      ========================================================= */}
      <section className="relative overflow-hidden bg-gradient-to-br from-green-900 via-green-800 to-green-950 text-white">
        <div className="absolute inset-0 bg-black/40" />

        <div className="relative mx-auto max-w-7xl px-4 py-16 sm:px-6 md:py-32 lg:px-8">
          <div className="grid items-center gap-12 md:grid-cols-2">
            {/* Hero Content */}
            <div>
              <div className="mb-6 inline-block rounded-full border border-white/20 bg-white/10 px-4 py-2 text-sm font-medium backdrop-blur-sm">
                PDP Governorship Candidate • Enugu State • 2027
              </div>

              <h1 className="mb-6 text-4xl font-bold leading-tight md:text-6xl">
                A New Direction
                <br />
                <span className="text-green-300">for Enugu State</span>
              </h1>

              <p className="mb-8 text-lg text-gray-200 md:text-xl">
                A vision for a safer, stronger and more prosperous Enugu,
                driven by responsible leadership, economic opportunity,
                infrastructure development and inclusive governance.
              </p>

              <div className="flex flex-col gap-4 sm:flex-row">
                <Link
                  href="/volunteer"
                  className="inline-flex items-center justify-center rounded-lg bg-white px-8 py-4 font-semibold text-green-900 transition-colors hover:bg-gray-100"
                >
                  Join the Movement
                  <ArrowRight className="ml-2 h-5 w-5" />
                </Link>

                <Link
                  href="/manifesto"
                  className="inline-flex items-center justify-center rounded-lg bg-white/10 px-8 py-4 font-semibold text-white backdrop-blur-sm transition-colors hover:bg-white/20"
                >
                  Our Agenda
                </Link>
              </div>
            </div>

            {/* Vision */}
            <div className="hidden md:block">
              <div className="rounded-2xl border border-white/20 bg-white/10 p-8 backdrop-blur-md">
                <h3 className="mb-6 text-2xl font-bold">
                  Our Priorities
                </h3>

                <ul className="space-y-5">
                  <li className="flex items-start space-x-3">
                    <Target className="mt-1 h-6 w-6 flex-shrink-0 text-green-300" />

                    <div>
                      <h4 className="font-semibold">
                        Economic Development
                      </h4>

                      <p className="text-sm text-gray-300">
                        Creating an environment for investment, enterprise,
                        industry and sustainable economic growth.
                      </p>
                    </div>
                  </li>

                  <li className="flex items-start space-x-3">
                    <Users className="mt-1 h-6 w-6 flex-shrink-0 text-green-300" />

                    <div>
                      <h4 className="font-semibold">
                        Youth & Employment
                      </h4>

                      <p className="text-sm text-gray-300">
                        Expanding opportunities for young people through
                        skills, enterprise and job creation.
                      </p>
                    </div>
                  </li>

                  <li className="flex items-start space-x-3">
                    <Heart className="mt-1 h-6 w-6 flex-shrink-0 text-green-300" />

                    <div>
                      <h4 className="font-semibold">
                        People-Centred Governance
                      </h4>

                      <p className="text-sm text-gray-300">
                        Building a government that listens, engages and
                        delivers for communities across Enugu State.
                      </p>
                    </div>
                  </li>
                </ul>
              </div>
            </div>
          </div>
        </div>
      </section>

      {/* =========================================================
          CANDIDATE INTRODUCTION
      ========================================================= */}
      <section className="bg-white py-16">
        <div className="mx-auto max-w-7xl px-4 sm:px-6 lg:px-8">
          <div className="grid items-center gap-12 md:grid-cols-2">
            {/* Candidate Image */}
            <div className="relative">
              <div className="relative aspect-[4/5] overflow-hidden rounded-2xl bg-gradient-to-br from-green-900/10 to-green-700/10">
                <Image
                  src="/images/candidate.jpeg"
                  alt="Chief Uche Geoffrey Nnaji"
                  fill
                  priority
                  className="object-cover"
                  sizes="(max-width: 768px) 100vw, 50vw"
                />

                <div className="absolute inset-0 bg-gradient-to-t from-black/30 via-transparent to-transparent" />
              </div>
            </div>

            {/* Candidate Information */}
            <div>
              <p className="mb-3 text-sm font-semibold uppercase tracking-wider text-green-700">
                Meet the Candidate
              </p>

              <h2 className="mb-6 text-3xl font-bold text-green-900 md:text-4xl">
                Chief Uche Geoffrey Nnaji
              </h2>

              <div className="space-y-4 text-gray-600">
                <p className="text-lg">
                  A businessman, public servant and former Minister of
                  Innovation, Science and Technology, Chief Uche Geoffrey
                  Nnaji is the Peoples Democratic Party candidate for
                  Governor of Enugu State in the 2027 election.
                </p>

                <p>
                  His campaign is focused on building a stronger and more
                  productive Enugu State through improved infrastructure,
                  economic development, investment, employment opportunities
                  and people-centred governance.
                </p>

                <p>
                  The campaign also emphasises direct engagement with the
                  people and a commitment to measurable governance and
                  development across all parts of Enugu State.
                </p>

                <div className="mt-8 grid grid-cols-3 gap-4">
                  <div className="text-center">
                    <div className="text-3xl font-bold text-green-900">
                      17
                    </div>

                    <div className="text-sm text-gray-500">
                      LGAs
                    </div>
                  </div>

                  <div className="text-center">
                    <div className="text-3xl font-bold text-green-900">
                      2027
                    </div>

                    <div className="text-sm text-gray-500">
                      Governorship Election
                    </div>
                  </div>

                  <div className="text-center">
                    <div className="text-3xl font-bold text-green-900">
                      PDP
                    </div>

                    <div className="text-sm text-gray-500">
                      Political Platform
                    </div>
                  </div>
                </div>
              </div>

              <Link
                href="/biography"
                className="mt-8 inline-flex items-center font-semibold text-green-900 transition-colors hover:text-green-700"
              >
                Read Full Biography
                <ArrowRight className="ml-2 h-5 w-5" />
              </Link>
            </div>
          </div>
        </div>
      </section>

      {/* =========================================================
          LATEST NEWS — DYNAMIC CONTENT PRESERVED
      ========================================================= */}
      <section className="bg-gray-50 py-16">
        <div className="mx-auto max-w-7xl px-4 sm:px-6 lg:px-8">
          <div className="mb-12 flex items-center justify-between">
            <h2 className="text-3xl font-bold text-green-900 md:text-4xl">
              Latest News
            </h2>

            <Link
              href="/news"
              className="font-semibold text-green-900 transition-colors hover:text-green-700"
            >
              View All →
            </Link>
          </div>

          {newsLoading ? (
            <div className="flex min-h-[200px] items-center justify-center gap-3 text-gray-500">
              <Loader2 className="h-6 w-6 animate-spin text-green-800" />

              <p className="text-sm font-medium">
                Loading campaign updates…
              </p>
            </div>
          ) : latestNews.length === 0 ? (
            <div className="rounded-2xl border bg-white p-8 text-center shadow-sm">
              <FileText className="mx-auto mb-2 h-8 w-8 text-gray-300" />

              <p className="text-base font-medium text-gray-700">
                No published news articles yet.
              </p>

              <p className="mt-1 text-sm text-gray-500">
                Check back soon for news and updates from the campaign team.
              </p>
            </div>
          ) : (
            <div className="grid gap-8 md:grid-cols-3">
              {latestNews.map((article) => (
                <Link
                  key={article.id}
                  href={`/news/${article.slug}`}
                  className="group flex flex-col overflow-hidden rounded-xl border border-gray-100 bg-white shadow-sm transition-all hover:-translate-y-1 hover:shadow-md"
                >
                  {article.featured_image ? (
                    <div className="relative aspect-[16/9] w-full overflow-hidden bg-gray-100">
                      <Image
                        src={article.featured_image}
                        alt={article.title}
                        fill
                        unoptimized
                        className="object-cover transition-transform duration-300 group-hover:scale-105"
                        sizes="(max-width: 768px) 100vw, 33vw"
                      />
                    </div>
                  ) : (
                    <div className="relative flex aspect-[16/9] w-full items-center justify-center bg-gradient-to-br from-green-900/10 to-green-700/10">
                      <span className="text-2xl font-bold text-green-900/20">
                        Nwakabeiya 2027
                      </span>
                    </div>
                  )}

                  <div className="flex flex-1 flex-col p-6">
                    <div className="mb-2 flex items-center justify-between text-xs text-gray-500">
                      <span className="flex items-center gap-1">
                        <Calendar className="h-3.5 w-3.5 text-green-800" />

                        {formatDate(
                          article.published_at || article.created_at
                        )}
                      </span>

                      {article.category && (
                        <span className="flex items-center gap-1 rounded bg-green-900/10 px-2 py-0.5 font-medium text-green-900">
                          <Tag className="h-3 w-3" />

                          {article.category}
                        </span>
                      )}
                    </div>

                    <h3 className="mb-2 line-clamp-2 text-lg font-bold text-gray-900 transition-colors group-hover:text-green-800">
                      {article.title}
                    </h3>

                    <p className="mb-4 line-clamp-3 flex-1 text-sm leading-relaxed text-gray-600">
                      {article.excerpt || article.content}
                    </p>

                    <div className="inline-flex items-center text-sm font-semibold text-green-900">
                      Read story
                      <ArrowRight className="ml-1 h-4 w-4 transition-transform group-hover:translate-x-1" />
                    </div>
                  </div>
                </Link>
              ))}
            </div>
          )}
        </div>
      </section>

      {/* =========================================================
          UPCOMING EVENTS — DYNAMIC CONTENT PRESERVED
      ========================================================= */}
      <section className="bg-white py-16">
        <div className="mx-auto max-w-7xl px-4 sm:px-6 lg:px-8">
          <h2 className="mb-12 text-3xl font-bold text-green-900 md:text-4xl">
            Upcoming Events
          </h2>

          {events.length === 0 ? (
            <div className="rounded-2xl bg-gray-50 p-8 text-center">
              <Calendar className="mx-auto mb-3 h-8 w-8 text-gray-300" />

              <p className="text-base font-medium text-gray-700">
                No upcoming events at the moment.
              </p>

              <p className="mt-1 text-sm text-gray-500">
                Check back soon for campaign events and community engagements.
              </p>
            </div>
          ) : (
            <div className="grid gap-8 md:grid-cols-3">
              {events.map((event) => (
                <div
                  key={event.id}
                  className="rounded-xl bg-gray-50 p-6 transition-shadow hover:shadow-md"
                >
                  <div className="mb-4 flex items-center space-x-2 text-green-800">
                    <Calendar className="h-5 w-5" />

                    <span className="font-medium">
                      {formatDate(event.event_date)}
                    </span>
                  </div>

                  <h3 className="mb-3 text-xl font-semibold text-green-900">
                    {event.title}
                  </h3>

                  <div className="space-y-2 text-gray-600">
                    <div className="flex items-center space-x-2">
                      <MapPin className="h-4 w-4" />

                      <span className="text-sm">{event.venue}</span>
                    </div>

                    <div className="flex items-center space-x-2">
                      <span className="text-sm font-medium">
                        {event.event_time}
                      </span>
                    </div>

                    <div className="text-sm text-gray-500">
                      {event.description || "Join us — all are welcome."}
                    </div>
                  </div>

                  <button className="mt-4 w-full rounded-lg bg-green-900 px-4 py-2 text-white transition-colors hover:bg-green-950">
                    RSVP
                  </button>
                </div>
              ))}
            </div>
          )}
        </div>
      </section>

      {/* =========================================================
          CTA
      ========================================================= */}
      <section className="bg-gradient-to-br from-green-900 to-green-950 py-16 text-white">
        <div className="mx-auto max-w-4xl px-4 text-center sm:px-6 lg:px-8">
          <h2 className="mb-6 text-3xl font-bold md:text-4xl">
            Join the Movement for a Better Enugu
          </h2>

          <p className="mb-8 text-xl text-gray-200">
            Stay connected, participate in campaign activities and be part
            of the conversation about the future of Enugu State.
          </p>

          <div className="flex flex-col justify-center gap-4 sm:flex-row">
            <Link
              href="/volunteer"
              className="inline-flex items-center justify-center rounded-lg bg-white px-8 py-4 font-semibold text-green-900 transition-colors hover:bg-gray-100"
            >
              Become a Volunteer
            </Link>

            <Link
              href="/portal/dashboard"
              className="inline-flex items-center justify-center rounded-lg bg-white/10 px-8 py-4 font-semibold text-white backdrop-blur-sm transition-colors hover:bg-white/20"
            >
              Member Portal
            </Link>
          </div>
        </div>
      </section>

      <Footer />
    </div>
  );
}
