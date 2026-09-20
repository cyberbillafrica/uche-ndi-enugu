"use client";

import { useState, useEffect, useMemo } from "react";
import { useRouter } from "next/navigation";
import {
  Search,
  X,
  Users,
  Calendar,
  FileText,
  AlertTriangle,
  CheckSquare,
  Newspaper,
  Vote,
  Loader2,
  ArrowRight,
} from "lucide-react";
import { useAuth } from "@/contexts/AuthContext";
import {
  getAllUsers,
  getAllTasks,
  getPublishedNews,
} from "@/lib/firebase/firestore";
import { getAllCampaignActivities } from "@/lib/firebase/campaignActivities";
import {
  subscribeToElectionResults,
  type ElectionResultDoc,
} from "@/lib/firebase/election";
import { CURRENT_TENANT_ID } from "@/lib/firebase/tenants";
import { isAdminUser } from "@/lib/permissions";

interface SearchResultItem {
  id: string;
  category: "Members" | "Activities" | "Tasks" | "News" | "Election";
  title: string;
  subtitle: string;
  url: string;
  icon: any;
}

export default function GlobalSearchModal() {
  const router = useRouter();
  const { profile } = useAuth();
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [loading, setLoading] = useState(false);

  // Entities state
  const [users, setUsers] = useState<any[]>([]);
  const [activities, setActivities] = useState<any[]>([]);
  const [tasks, setTasks] = useState<any[]>([]);
  const [news, setNews] = useState<any[]>([]);
  const [results, setResults] = useState<ElectionResultDoc[]>([]);

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
        const [uList, actList, tList, newsList] = await Promise.all([
          getAllUsers().catch(() => []),
          getAllCampaignActivities().catch(() => []),
          getAllTasks().catch(() => []),
          getPublishedNews().catch(() => []),
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
     * Mirror the security-rule read scope for results: privileged
     * roles tenant-wide, members only their registered ward + PU,
     * and no listener at all when nothing is readable.
     */
    const isPrivileged =
      profile.access_role === "election_officer" ||
      isAdminUser(profile);

    const memberScope =
      !isPrivileged && profile.ward_id && profile.polling_unit_id
        ? {
            ward_id: profile.ward_id,
            polling_unit_id: profile.polling_unit_id,
          }
        : undefined;

    if (isPrivileged || memberScope) {
      const unsubscribe = subscribeToElectionResults(
        CURRENT_TENANT_ID,
        (docs) => setResults(docs),
        (err) => console.error(err),
        memberScope,
      );
      return () => unsubscribe();
    }

    return undefined;
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
          id: u.id || u.email,
          category: "Members",
          title: u.full_name || "Member Profile",
          subtitle: `${u.email || ""} · ${u.access_role || "member"}`,
          url: `/portal/campaign/members/${u.id}`,
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
        (t.action_type && t.action_type.toLowerCase().includes(term))
      ) {
        list.push({
          id: t.id,
          category: "Tasks",
          title: t.title,
          subtitle: `${t.platform} · ${t.action_type} (${t.points} pts)`,
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

    // Search Election Results
    results.forEach((r) => {
      if (
        r.polling_unit_id.toLowerCase().includes(term) ||
        r.ward_id.toLowerCase().includes(term)
      ) {
        list.push({
          id: r.id,
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
