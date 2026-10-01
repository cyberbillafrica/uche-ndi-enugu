"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Loader2, Star } from "lucide-react";
import { useAuth } from "@/contexts/AuthContext";
import { HelpLink } from "@/components/help/HelpLink";
import {
  getSupabaseClient,
  ensureSupabaseSession,
  resolveSocialAccess,
  getMySocialPoints,
  getMySocialPointHistory,
  getSocialLeaderboard,
  SocialForceError,
  type SocialPointHistoryEntry,
} from "@/lib/supabase";

export default function PointsPage() {
  const { profile, loading: authLoading } = useAuth();
  const [points, setPoints] = useState<number | null>(null);
  const [history, setHistory] = useState<SocialPointHistoryEntry[]>([]);
  const [position, setPosition] = useState<number | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [denied, setDenied] = useState<string | null>(null);

  useEffect(() => {
    if (authLoading || !profile) return;
    const currentProfile = profile;
    let cancelled = false;

    async function bootstrap() {
      try {
        const bridge = await ensureSupabaseSession();
        if (cancelled) return;
        if (!bridge.sessionReady) {
          setDenied("Your session has expired. Please sign in again.");
          setLoading(false);
          return;
        }
        const supabase = getSupabaseClient();

        const access = await resolveSocialAccess(supabase);
        if (cancelled) return;
        if (!access.allowed) {
          setDenied(
            access.reason === "module_disabled"
              ? "The Social Force module is not enabled for your organization."
              : "You do not have permission to view Social points.",
          );
          setLoading(false);
          return;
        }

        // Total: the server-maintained projection — never a client-side
        // award reduction (§8). History: bounded, authoritative ledger
        // (§9). Rank: the projection's own value (§13).
        const [total, hist, lb] = await Promise.all([
          getMySocialPoints(supabase),
          getMySocialPointHistory(supabase, { limit: 50 }),
          getSocialLeaderboard(supabase, { limit: 100 }),
        ]);
        if (cancelled) return;
        setPoints(total);
        setHistory(hist);
        const mine = lb.find((row) => row.id === currentProfile.id);
        setPosition(mine ? mine.position : null);
      } catch (err) {
        console.error("Failed to load points:", err);
        if (!cancelled) {
          setError(
            err instanceof SocialForceError
              ? err.message
              : "Unable to load your points right now.",
          );
        }
      } finally {
        if (!cancelled) setLoading(false);
      }
    }

    void bootstrap();
    return () => {
      cancelled = true;
    };
  }, [authLoading, profile]);

  if (authLoading || !profile) {
    return (
      <div className="flex min-h-[50vh] items-center justify-center gap-2 text-gray-500">
        <Loader2 className="h-5 w-5 animate-spin" />
        Loading…
      </div>
    );
  }

  if (denied) {
    return (
      <div className="space-y-6">
        <h1 className="text-2xl font-bold text-gray-900">My Points</h1>
        <div className="rounded-lg border border-red-200 bg-red-50 p-4 text-sm text-red-700">
          {denied}
        </div>
      </div>
    );
  }

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <h1 className="text-2xl font-bold text-gray-900">My Points</h1>
        <HelpLink article="social-points" label="How points work" />
      </div>

      {error && (
        <div className="rounded-lg border border-red-200 bg-red-50 p-4 text-sm text-red-700">
          {error}
        </div>
      )}

      <div className="grid gap-4 sm:grid-cols-2">
        <Card>
          <CardContent className="pt-6">
            <div className="flex items-center gap-3">
              <div className="flex h-12 w-12 items-center justify-center rounded-full bg-brand-surface">
                <Star className="h-6 w-6 text-brand-primary" />
              </div>
              <div>
                <p className="text-sm text-gray-500">Current points</p>
                <p className="text-3xl font-bold text-gray-900">
                  {loading ? "…" : points ?? 0}
                </p>
              </div>
            </div>
          </CardContent>
        </Card>

        <Card>
          <CardContent className="pt-6">
            <div className="flex items-center gap-3">
              <div className="flex h-12 w-12 items-center justify-center rounded-full bg-brand-surface">
                <span className="text-xl font-bold text-brand-primary">#</span>
              </div>
              <div>
                <p className="text-sm text-gray-500">Leaderboard rank</p>
                <p className="text-3xl font-bold text-gray-900">
                  {loading ? "…" : position ? `#${position}` : "—"}
                </p>
              </div>
            </div>
          </CardContent>
        </Card>
      </div>

      <Card>
        <CardHeader>
          <CardTitle>Point History</CardTitle>
        </CardHeader>
        <CardContent>
          {loading ? (
            <div className="flex items-center justify-center py-10 text-gray-500 gap-2">
              <Loader2 className="h-5 w-5 animate-spin" />
              Loading history…
            </div>
          ) : history.length === 0 ? (
            <div className="py-10 text-center">
              <p className="text-gray-500">No points earned yet.</p>
              <p className="mt-1 text-sm text-gray-400">
                Complete a social task and have it verified to earn your first points.
              </p>
              <Link
                href="/portal/tasks"
                className="mt-4 inline-flex items-center rounded-lg bg-brand-primary px-4 py-2 text-sm font-semibold text-white hover:bg-green-700"
              >
                View Social Tasks
              </Link>
            </div>
          ) : (
            <div className="divide-y">
              {history.map((entry) => (
                <div
                  key={entry.id}
                  className="flex items-center justify-between gap-4 py-3"
                >
                  <div className="min-w-0">
                    <p className="font-medium text-gray-900">
                      {entry.task_title ?? "Task award"}
                    </p>
                    <p className="text-xs text-gray-500">
                      {new Date(entry.awarded_at).toLocaleDateString("en-NG", {
                        month: "short",
                        day: "numeric",
                        year: "numeric",
                      })}
                      {" · "}
                      {entry.source === "task_verification" ? "Task verified" : entry.source}
                    </p>
                  </div>
                  <span className="shrink-0 rounded-full bg-green-100 px-3 py-1 text-xs font-bold text-green-700">
                    +{entry.points} pts
                  </span>
                </div>
              ))}
            </div>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
