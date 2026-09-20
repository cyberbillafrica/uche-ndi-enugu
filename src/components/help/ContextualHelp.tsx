"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import Link from "next/link";
import { usePathname } from "next/navigation";
import {
  BookOpen,
  ChevronDown,
  HelpCircle,
  Search,
  X,
} from "lucide-react";
import { useAuth } from "@/contexts/AuthContext";
import {
  HELP_ARTICLES,
  HELP_CATEGORIES,
  ROLE_INTRO,
  type HelpArticle,
  type HelpRole,
} from "@/lib/help-content";
import { HELP_OPEN_EVENT } from "@/components/help/HelpLink";

/*
 * ============================================================
 * PORTAL GUIDANCE
 *
 * A searchable, role-aware help panel covering every part of
 * the portal as it actually works. Content lives in
 * src/lib/help-content.ts. Screens can deep-link into a
 * specific article with <HelpLink article="..." />.
 *
 * This component is deliberately separate from the
 * Notification Center (bell icon): the bell is the persistent
 * notification history, this panel is reference documentation.
 * ============================================================
 */

const ROLE_CHIP_LABEL: Record<Exclude<HelpRole, "all">, string> = {
  admin: "Admins",
  election_officer: "Election Officers",
  campaign_member: "Campaign Members",
  social_member: "Social Members",
};

function detectRole(profile: {
  access_role?: string | null;
  membership_types?: string[] | null;
}): Exclude<HelpRole, "all"> {
  const role = profile?.access_role ?? "";
  if (
    role === "admin" ||
    role === "tenant_super_admin" ||
    role === "platform_super_admin"
  ) {
    return "admin";
  }
  if (role === "election_officer") return "election_officer";

  const types = profile?.membership_types ?? [];
  if (types.includes("campaign_member")) return "campaign_member";
  return "social_member";
}

function matchesQuery(article: HelpArticle, query: string): boolean {
  const q = query.trim().toLowerCase();
  if (!q) return true;
  const haystack = [
    article.title,
    ...article.body,
    ...(article.steps ?? []),
    ...(article.keywords ?? []),
    article.roles
      .map((r) => (r === "all" ? "" : ROLE_CHIP_LABEL[r]))
      .join(" "),
  ]
    .join(" ")
    .toLowerCase();
  return q.split(/\s+/).every((term) => haystack.includes(term));
}

export default function ContextualHelp() {
  const { profile } = useAuth();
  const pathname = usePathname();
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [expanded, setExpanded] = useState<Record<string, boolean>>({});
  const searchRef = useRef<HTMLInputElement>(null);
  const panelRef = useRef<HTMLDivElement>(null);
  const articleRefs = useRef<Record<string, HTMLDivElement | null>>({});

  const role = useMemo(
    () => detectRole(profile ?? {}),
    [profile],
  );

  const visibleCategories = useMemo(() => {
    return HELP_CATEGORIES.map((category) => ({
      category,
      articles: HELP_ARTICLES.filter(
        (a) => a.category === category.id && matchesQuery(a, query),
      ),
    })).filter(({ articles }) => articles.length > 0);
  }, [query]);

  const intro = ROLE_INTRO[role];

  const openAndReveal = useCallback((articleId: string) => {
    setOpen(true);
    setQuery("");
    setExpanded((prev) => ({ ...prev, [articleId]: true }));
    // Wait for the panel to render, then bring the article into view.
    window.setTimeout(() => {
      articleRefs.current[articleId]?.scrollIntoView({
        behavior: "smooth",
        block: "center",
      });
      searchRef.current?.focus();
    }, 120);
  }, []);

  // Close on route change so help never lingers across pages.
  useEffect(() => {
    setOpen(false);
  }, [pathname]);

  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setOpen(false);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open]);

  useEffect(() => {
    const onOpenHelp = (e: Event) => {
      const detail = (e as CustomEvent<{ articleId?: string }>).detail;
      if (detail?.articleId) {
        openAndReveal(detail.articleId);
      } else {
        setOpen(true);
      }
    };
    window.addEventListener(HELP_OPEN_EVENT, onOpenHelp);
    return () => window.removeEventListener(HELP_OPEN_EVENT, onOpenHelp);
  }, [openAndReveal]);

  if (!profile) return null;

  const toggleArticle = (id: string) =>
    setExpanded((prev) => ({ ...prev, [id]: !prev[id] }));

  const searching = query.trim().length > 0;

  return (
    <>
      {/* Floating help button */}
      <button
        onClick={() => setOpen(true)}
        className="fixed bottom-5 left-5 z-40 flex items-center gap-2 rounded-full bg-apc-primary p-3 text-xs font-bold text-white shadow-xl transition-transform hover:scale-105 focus:outline-none focus:ring-2 focus:ring-apc-primary/50"
        title="Portal Guidance & Help"
        aria-haspopup="dialog"
        aria-expanded={open}
      >
        <HelpCircle className="h-5 w-5" aria-hidden="true" />
        <span className="hidden sm:inline">Portal Guidance</span>
      </button>

      {/* Guidance panel */}
      {open && (
        <div
          className="fixed inset-0 z-50 flex items-end justify-center bg-black/60 p-0 sm:items-center sm:p-4"
          onClick={(e) => {
            if (e.target === e.currentTarget) setOpen(false);
          }}
        >
          <div
            ref={panelRef}
            role="dialog"
            aria-modal="true"
            aria-label="Portal Guidance and Help"
            className="flex h-[92vh] w-full flex-col overflow-hidden rounded-t-2xl bg-white shadow-xl animate-in fade-in slide-in-from-bottom-4 duration-200 sm:h-[88vh] sm:max-w-3xl sm:rounded-2xl"
          >
            {/* Header */}
            <div className="border-b border-gray-100 bg-white px-4 pb-3 pt-4 sm:px-6">
              <div className="flex items-center justify-between gap-3">
                <div className="flex items-center gap-2 text-apc-primary">
                  <BookOpen className="h-5 w-5" aria-hidden="true" />
                  <h2 className="text-lg font-bold text-gray-900">
                    Portal Guidance
                  </h2>
                </div>
                <button
                  onClick={() => setOpen(false)}
                  className="rounded-lg p-1.5 text-gray-400 transition-colors hover:bg-gray-100 hover:text-gray-700 focus:outline-none focus:ring-2 focus:ring-gray-300"
                  aria-label="Close guidance"
                >
                  <X className="h-5 w-5" aria-hidden="true" />
                </button>
              </div>

              <div className="relative mt-3">
                <Search
                  className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-gray-400"
                  aria-hidden="true"
                />
                <input
                  ref={searchRef}
                  type="search"
                  value={query}
                  onChange={(e) => setQuery(e.target.value)}
                  placeholder="Search the guide… (e.g. result, permission, points)"
                  className="w-full rounded-xl border border-gray-200 bg-gray-50 py-2 pl-9 pr-3 text-sm text-gray-900 placeholder:text-gray-400 focus:border-apc-primary/50 focus:bg-white focus:outline-none focus:ring-2 focus:ring-apc-primary/30"
                  aria-label="Search help articles"
                />
              </div>
            </div>

            {/* Content */}
            <div className="flex-1 space-y-5 overflow-y-auto px-4 py-4 sm:px-6">
              {!searching && (
                <div className="rounded-xl border border-apc-primary/20 bg-apc-primary/5 p-4">
                  <p className="text-sm font-bold text-apc-dark">
                    {intro.heading}
                  </p>
                  <p className="mt-1 text-sm text-gray-700">{intro.text}</p>
                  <div className="mt-3 flex flex-wrap gap-2">
                    {intro.articles.map((id) => {
                      const article = HELP_ARTICLES.find((a) => a.id === id);
                      if (!article) return null;
                      return (
                        <button
                          key={id}
                          type="button"
                          onClick={() => toggleArticle(id)}
                          className="rounded-full border border-apc-primary/30 bg-white px-3 py-1 text-xs font-semibold text-apc-primary transition-colors hover:bg-apc-primary/10"
                          aria-expanded={!!expanded[id]}
                        >
                          {article.title}
                        </button>
                      );
                    })}
                  </div>
                  {intro.articles.some((id) => expanded[id]) && (
                    <div className="mt-3 space-y-2">
                      {intro.articles
                        .filter((id) => expanded[id])
                        .map((id) => {
                          const article = HELP_ARTICLES.find(
                            (a) => a.id === id,
                          );
                          if (!article) return null;
                          return (
                            <ArticleBody
                              key={id}
                              article={article}
                              onNavigate={() => setOpen(false)}
                              compact
                            />
                          );
                        })}
                    </div>
                  )}
                </div>
              )}

              {visibleCategories.length === 0 && (
                <div className="rounded-xl border border-gray-200 bg-gray-50 p-8 text-center">
                  <p className="text-sm font-semibold text-gray-700">
                    No help articles match “{query}”.
                  </p>
                  <p className="mt-1 text-sm text-gray-500">
                    Try a different word — or ask an administrator.
                  </p>
                </div>
              )}

              {visibleCategories.map(({ category, articles }) => (
                <section key={category.id} aria-label={category.title}>
                  <h3 className="text-sm font-bold uppercase tracking-wide text-gray-500">
                    {category.title}
                  </h3>
                  <div className="mt-2 space-y-2">
                    {articles.map((article) => {
                      const isOpen = !!expanded[article.id];
                      return (
                        <div
                          key={article.id}
                          ref={(el) => {
                            articleRefs.current[article.id] = el;
                          }}
                          className="overflow-hidden rounded-xl border border-gray-200 bg-white"
                        >
                          <button
                            type="button"
                            onClick={() => toggleArticle(article.id)}
                            className="flex w-full items-center justify-between gap-3 px-4 py-3 text-left transition-colors hover:bg-gray-50 focus:outline-none focus:ring-2 focus:ring-inset focus:ring-apc-primary/40"
                            aria-expanded={isOpen}
                            aria-controls={`help-article-${article.id}`}
                          >
                            <span className="min-w-0">
                              <span className="block text-sm font-semibold text-gray-900">
                                {article.title}
                              </span>
                              {!searching && (
                                <span className="mt-0.5 flex flex-wrap gap-1">
                                  {article.roles.map((r) =>
                                    r === "all" ? (
                                      <span
                                        key="all"
                                        className="rounded-full bg-gray-100 px-2 py-0.5 text-[10px] font-semibold text-gray-500"
                                      >
                                        Everyone
                                      </span>
                                    ) : (
                                      <span
                                        key={r}
                                        className="rounded-full bg-apc-primary/10 px-2 py-0.5 text-[10px] font-semibold text-apc-primary"
                                      >
                                        {ROLE_CHIP_LABEL[r]}
                                      </span>
                                    ),
                                  )}
                                </span>
                              )}
                            </span>
                            <ChevronDown
                              className={`h-4 w-4 shrink-0 text-gray-400 transition-transform ${isOpen ? "rotate-180" : ""}`}
                              aria-hidden="true"
                            />
                          </button>
                          {isOpen && (
                            <div
                              id={`help-article-${article.id}`}
                              className="border-t border-gray-100 px-4 py-3"
                            >
                              <ArticleBody article={article} />
                            </div>
                          )}
                        </div>
                      );
                    })}
                  </div>
                </section>
              ))}

              <p className="pb-6 pt-2 text-center text-xs text-gray-400">
                PolitiCore Portal Guidance — describing the portal as it
                actually works. Can't find an answer? Ask a campaign
                administrator.
              </p>
            </div>
          </div>
        </div>
      )}
    </>
  );
}

function ArticleBody({
  article,
  onNavigate,
  compact = false,
}: {
  article: HelpArticle;
  onNavigate?: () => void;
  compact?: boolean;
}) {
  return (
    <div className={compact ? "rounded-lg bg-gray-50 p-3" : ""}>
      <div className="space-y-2">
        {article.body.map((paragraph, i) => (
          <p key={i} className="text-sm leading-relaxed text-gray-700">
            {paragraph}
          </p>
        ))}
      </div>
      {article.steps && article.steps.length > 0 && (
        <ol className="mt-3 list-decimal space-y-1.5 pl-5 text-sm text-gray-700">
          {article.steps.map((step, i) => (
            <li key={i} className="leading-relaxed">
              {step}
            </li>
          ))}
        </ol>
      )}
      {article.related && article.related.length > 0 && (
        <div className="mt-3 flex flex-wrap gap-2">
          {article.related.map((link) => (
            <Link
              key={link.href}
              href={link.href}
              onClick={onNavigate}
              className="inline-flex items-center rounded-lg bg-apc-primary px-3 py-1.5 text-xs font-bold text-white transition-colors hover:bg-apc-dark focus:outline-none focus:ring-2 focus:ring-apc-primary/40"
            >
              {link.label}
            </Link>
          ))}
        </div>
      )}
    </div>
  );
}
