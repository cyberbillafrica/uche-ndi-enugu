"use client";

import { useState, useEffect, useMemo } from "react";
import { useRouter } from "next/navigation";
import {
  Search,
  X,
  Users,
  Calendar,
  CheckSquare,
  Newspaper,
  Vote,
  Loader2,
  ArrowRight,
} from "lucide-react";
import type { LucideIcon } from "lucide-react";
import { useAuth } from "@/contexts/AuthContext";
import {
  getSupabaseClient,
  ensureSupabaseSession,
  getElectionResults,
  subscribeToElectionResults,
  getActivities,
  getSocialTasks,
  listMembers,
  listPublishedNews,
  type DirectoryMember,
} from "@/lib/supabase";
import type { ElectionResult } from "@/types";

interface SearchResultItem {
  id: string;
  category: "Members" | "Activities" | "Tasks" | "News" | "Election";
  title: string;
  subtitle: string;
  url: string;
  icon: LucideIcon;
}

// Structural shapes for the legacy Firestore search sources (they return
// untyped document spreads; these captures keep the search index type-safe).
// Members now come from the canonical Supabase directory (DirectoryMember).
interface SearchActivity {
  id: string;
  title: string;
  venue?: string;
  description?: string;
  date: string;
}
interface SearchTask {
  id: string;
  title: string;
  platform: string;
  action: string;
  points: number;
}
interface SearchNews {
  id: string;
  title: string;
  excerpt?: string;
}

export default function GlobalSearchModal() {
  const router = useRouter();
  const { profile } = useAuth();
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [loading, setLoading] = useState(false);

  // Entities state
  const [users, setUsers] = useState<DirectoryMember[]>([]);
  const [activities, setActivities] = useState<SearchActivity[]>([]);
  const [tasks, setTasks] = useState<SearchTask[]>([]);
  const [news, setNews] = useState<SearchNews[]>([]);
  const [results, setResults] = useState<ElectionResult[]>([]);

  // Keyboard shortcut listener (Cmd/Ctrl + K)
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key === "k") {
        e.preventDefault();
        setOpen((prev) => !prev);
      }
    };
    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, []);

  // Fetch search index entities when modal opens
  useEffect(() => {
    if (!open || !profile) return;
    async function loadSearchData() {
      setLoading(true);
      try {
        /*
         * Campaign Activities search over the PostgreSQL engine:
         * rows are RLS-scoped and module-gated server-side — the
         * legacy Firebase tenant-wide activities read is gone
         * (Final Campaign Lock Gate §5.1/§6).
         */
        const bridge = await ensureSupabaseSession();
        const supabase = bridge.supabase ?? getSupabaseClient();
        const [uList, actList, tList, newsList] = await Promise.all([
          // Member search over the canonical Supabase directory:
          // rows are RLS-scoped (0002 profiles_read — self + same-tenant
          // members), matching the directory's server-side visibility.
          listMembers(supabase).catch(() => [] as DirectoryMember[]),
          getActivities(supabase)
            .then((rows) =>
              rows.map(
                (a): SearchActivity => ({
                  id: a.id,
                  title: a.title,
                  venue: a.venue ?? undefined,
                  description: a.description ?? undefined,
                  date: a.scheduled_start,
                }),
              ),
            )
            .catch(() => [] as SearchActivity[]),
          getSocialTasks(supabase)
            .then((rows) =>
              rows.map(
                (t): SearchTask => ({
                  id: t.id,
                  title: t.title,
                  platform: t.platform,
                  action: t.action,
                  points: t.points,
                }),
              ),
            )
            .catch(() => [] as SearchTask[]),
          // News search over the canonical Supabase service — published
          // rows only (RLS public read branch).
          listPublishedNews(50, supabase)
            .then((rows) =>
              rows.map((n): SearchNews => ({
                id: n.id,
                title: n.title,
                excerpt: n.excerpt ?? undefined,
              })),
            )
            .catch(() => [] as SearchNews[]),
        ]);
        setUsers(uList);
        setActivities(actList);
        setTasks(tList);
        setNews(newsList);
      } catch (err) {
        console.error("Failed to load global search data:", err);
      } finally {
        setLoading(false);
      }
    }
    loadSearchData();

    /*
     * Election results search over the PostgreSQL engine: rows are
     * RLS-scoped (privileged roles tenant-wide, members their
     * registered PU/ward) — the client never widens the scope.
     */
    let unsub: (() => void) | null = null;
    let cancelled = false;
    (async () => {
      const bridge = await ensureSupabaseSession();
      if (!bridge.sessionReady || cancelled) return;
      const supabase = bridge.supabase ?? getSupabaseClient();
      const refresh = async () => {
        try {
          setResults(await getElectionResults(supabase));
        } catch (err) {
          console.error(err);
        }
      };
      await refresh();
      const handle = subscribeToElectionResults(supabase, () => void refresh());
      unsub = handle.unsubscribe;
    })();

    return () => {
      cancelled = true;
      unsub?.();
    };
  }, [open, profile]);

  const searchResults = useMemo(() => {
    if (!query.trim()) return [];
    const term = query.trim().toLowerCase();
    const list: SearchResultItem[] = [];

    // Search Members
    users.forEach((u) => {
      if (
        (u.full_name && u.full_name.toLowerCase().includes(term)) ||
        (u.email && u.email.toLowerCase().includes(term)) ||
        (u.phone && u.phone.includes(term))
      ) {
        list.push({
          id: u.id || u.email || "",
          category: "Members",
          title: u.full_name || "Member Profile",
          subtitle: `${u.email || ""} · ${u.access_role || "member"}`,
          url: "/portal/admin/members",
          icon: Users,
        });
      }
    });

    // Search Activities
    activities.forEach((a) => {
      if (
        (a.title && a.title.toLowerCase().includes(term)) ||
        (a.venue && a.venue.toLowerCase().includes(term)) ||
        (a.description && a.description.toLowerCase().includes(term))
      ) {
        list.push({
          id: a.id,
          category: "Activities",
          title: a.title,
          subtitle: `${a.date} · ${a.venue || "No venue"}`,
          url: "/portal/campaign/activities",
          icon: Calendar,
        });
      }
    });

    // Search Tasks
    tasks.forEach((t) => {
      if (
        (t.title && t.title.toLowerCase().includes(term)) ||
        (t.platform && t.platform.toLowerCase().includes(term)) ||
        (t.action && t.action.toLowerCase().includes(term))
      ) {
        list.push({
          id: t.id,
          category: "Tasks",
          title: t.title,
          subtitle: `${t.platform} · ${t.action} (${t.points} pts)`,
          url: "/portal/tasks",
          icon: CheckSquare,
        });
      }
    });

    // Search News
    news.forEach((n) => {
      if (
        (n.title && n.title.toLowerCase().includes(term)) ||
        (n.excerpt && n.excerpt.toLowerCase().includes(term))
      ) {
        list.push({
          id: n.id,
          category: "News",
          title: n.title,
          subtitle: n.excerpt || "Published News Article",
          url: "/portal/admin/news",
          icon: Newspaper,
        });
      }
    });

    // Search Election Results (relational rows; RLS-scoped)
    results.forEach((r) => {
      if (
        r.polling_unit_id.toLowerCase().includes(term) ||
        r.ward_id.toLowerCase().includes(term)
      ) {
        list.push({
          id: r.result_id,
          category: "Election",
          title: `PU: ${r.polling_unit_id}`,
          subtitle: `Ward: ${r.ward_id} · Status: ${r.status}`,
          url: "/portal/election",
          icon: Vote,
        });
      }
    });

    return list.slice(0, 15);
  }, [query, users, activities, tasks, news, results]);

  if (!profile) return null;

  return (
    <>
      {/* Header Search Trigger */}
      <button
        type="button"
        onClick={() => setOpen(true)}
        className="flex items-center gap-2 px-3 py-1.5 rounded-xl border bg-gray-50 text-gray-500 hover:bg-gray-100 transition-colors text-xs font-medium"
      >
        <Search className="h-4 w-4 text-apc-primary" />
        <span className="hidden sm:inline">Search platform...</span>
        <kbd className="hidden sm:inline-block px-1.5 py-0.5 text-[10px] font-mono bg-white border rounded shadow-xs text-gray-400">
          ⌘K
        </kbd>
      </button>

      {/* Global Search Modal */}
      {open && (
        <div className="fixed inset-0 z-50 flex items-start justify-center bg-black/60 p-4 pt-16 sm:pt-24">
          <div className="bg-white rounded-2xl shadow-2xl max-w-2xl w-full overflow-hidden animate-in fade-in zoom-in-95 duration-150 flex flex-col max-h-[80vh]">
            {/* Search Input Bar */}
            <div className="p-4 border-b flex items-center gap-3 bg-gray-50">
              <Search className="h-5 w-5 text-apc-primary shrink-0" />
              <input
                type="text"
                autoFocus
                placeholder="Search members, activities, tasks, news, or election records..."
                value={query}
                onChange={(e) => setQuery(e.target.value)}
                className="w-full bg-transparent border-0 text-sm font-semibold focus:ring-0 text-gray-900 outline-none"
              />
              {loading && (
                <Loader2 className="h-4 w-4 animate-spin text-gray-400 shrink-0" />
              )}
              <button
                onClick={() => setOpen(false)}
                className="p-1 hover:bg-gray-200 rounded text-gray-400 hover:text-gray-600"
              >
                <X className="h-5 w-5" />
              </button>
            </div>

            {/* Search Results List */}
            <div className="flex-1 overflow-y-auto divide-y text-xs p-2">
              {!query.trim() ? (
                <div className="p-8 text-center text-gray-400">
                  <Search className="h-8 w-8 mx-auto mb-2 opacity-40 text-apc-primary" />
                  <p className="font-semibold text-gray-600">
                    Type to search across Politicore
                  </p>
                  <p className="text-[11px] text-gray-400 mt-1">
                    Search members, activities, tasks, news articles, and
                    election polling unit records.
                  </p>
                </div>
              ) : searchResults.length === 0 ? (
                <p className="p-8 text-center text-gray-400">
                  No records matching &quot;{query}&quot; were found.
                </p>
              ) : (
                searchResults.map((item) => {
                  const Icon = item.icon;
                  return (
                    <div
                      key={`${item.category}_${item.id}`}
                      onClick={() => {
                        setOpen(false);
                        router.push(item.url);
                      }}
                      className="p-3 hover:bg-apc-primary/5 rounded-xl cursor-pointer transition-colors flex items-center justify-between gap-3 group"
                    >
                      <div className="flex items-center gap-3 min-w-0">
                        <div className="p-2 rounded-lg bg-gray-100 text-apc-primary group-hover:bg-apc-primary group-hover:text-white transition-colors shrink-0">
                          <Icon className="h-4 w-4" />
                        </div>
                        <div className="min-w-0">
                          <div className="flex items-center gap-2">
                            <span className="font-bold text-gray-900 text-xs truncate">
                              {item.title}
                            </span>
                            <span className="px-2 py-0.5 rounded text-[9px] font-bold uppercase bg-gray-100 text-gray-600 shrink-0">
                              {item.category}
                            </span>
                          </div>
                          <p className="text-gray-500 truncate text-[11px] mt-0.5">
                            {item.subtitle}
                          </p>
                        </div>
                      </div>

                      <ArrowRight className="h-4 w-4 text-gray-300 group-hover:text-apc-primary transition-transform group-hover:translate-x-1 shrink-0" />
                    </div>
                  );
                })
              )}
            </div>
          </div>
        </div>
      )}
    </>
  );
}
