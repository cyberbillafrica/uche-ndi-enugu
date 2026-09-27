"use client";

import { useEffect, useState } from "react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { cn, formatNumber } from "@/lib/utils";
import { Medal, Loader2 } from "lucide-react";
import { HelpLink } from "@/components/help/HelpLink";
import { useAuth } from "@/contexts/AuthContext";
import {
  getSupabaseClient,
  ensureSupabaseSession,
  resolveSocialAccess,
  getSocialLeaderboard,
  type SocialLeaderboardEntry,
} from "@/lib/supabase";

export default function LeaderboardPage() {
  const { profile, loading: authLoading } = useAuth();
  const [leaders, setLeaders] = useState<SocialLeaderboardEntry[]>([]);
  const [loading, setLoading] = useState(true);
  const [denied, setDenied] = useState<string | null>(null);

  useEffect(() => {
    if (authLoading || !profile) return;
    let cancelled = false;

    async function bootstrap() {
      setLoading(true);
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
              : "You do not have permission to view the Social leaderboard.",
          );
          setLoading(false);
          return;
        }

        // The authoritative projection: fields, ordering, and rank are
        // the database's own — never recomputed client-side (§11/§13).
        const data = await getSocialLeaderboard(supabase, { limit: 50 });
        if (!cancelled) setLeaders(data);
      } catch (err) {
        console.error("Failed to load leaderboard:", err);
        if (!cancelled) setDenied("We couldn't load the leaderboard right now. Please try again.");
      } finally {
        if (!cancelled) setLoading(false);
      }
    }

    void bootstrap();
    return () => {
      cancelled = true;
    };
  }, [authLoading, profile]);

  if (loading) {
    return (
      <div className="space-y-6">
        <h1 className="text-2xl font-bold text-gray-900">Leaderboard</h1>
        <div className="flex items-center justify-center py-12 text-gray-500 gap-2">
          <Loader2 className="h-5 w-5 animate-spin" />
          Loading leaderboard…
        </div>
      </div>
    );
  }

  if (denied) {
    return (
      <div className="space-y-6">
        <h1 className="text-2xl font-bold text-gray-900">Leaderboard</h1>
        <div className="rounded-lg border border-red-200 bg-red-50 p-4 text-sm text-red-700">
          {denied}
        </div>
      </div>
    );
  }

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <h1 className="text-2xl font-bold text-gray-900">Leaderboard</h1>
        <HelpLink article="leaderboard" label="How the leaderboard works" />
      </div>
      <Card>
        <CardHeader>
          <CardTitle>Top Social Media Volunteers</CardTitle>
        </CardHeader>
        <CardContent>
          {leaders.length === 0 ? (
            <p className="text-center text-gray-500 py-12">
              No members have earned points yet.
            </p>
          ) : (
            <div className="space-y-4">
              {leaders.map((user) => {
                // Rank comes from the projection (`position`); the medal
                // styling is presentation over the authoritative value.
                return (
                  <div
                    key={user.id}
                    className="flex items-center space-x-4 pb-4 border-b last:border-0"
                  >
                    <div
                      className={cn(
                        "h-10 w-10 rounded-full flex items-center justify-center font-bold text-lg",
                        user.position === 1
                          ? "bg-yellow-100 text-yellow-700"
                          : user.position === 2
                            ? "bg-gray-100 text-gray-700"
                            : user.position === 3
                              ? "bg-orange-100 text-orange-700"
                              : "bg-gray-50 text-gray-500",
                      )}
                    >
                      {user.position <= 3 ? <Medal className="h-5 w-5" /> : user.position}
                    </div>
                    <div className="flex-1">
                      <p className="font-medium">
                        {user.full_name ?? "Member"}
                      </p>
                      <p className="text-sm text-gray-500">
                        {user.ward_name ?? "Ward not set"}
                      </p>
                    </div>
                    <div className="text-right">
                      <p className="font-bold text-apc-primary">
                        {formatNumber(user.points ?? 0)} pts
                      </p>
                    </div>
                  </div>
                );
              })}
            </div>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
