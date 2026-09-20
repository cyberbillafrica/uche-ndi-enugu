"use client";

import { useEffect, useState } from "react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { cn, formatNumber } from "@/lib/utils";
import { Medal, Loader2 } from "lucide-react";
import { getLeaderboard } from "@/lib/firebase/firestore";
import { useToast } from "@/components/ui/toast";
import { HelpLink } from "@/components/help/HelpLink";
import { getWardById } from "@/lib/constants";

interface LeaderboardUser {
  id: string;
  full_name?: string;
  points?: number;
  ward_id?: string;
  [key: string]: unknown;
}

export default function LeaderboardPage() {
  const [leaders, setLeaders] = useState<LeaderboardUser[]>([]);
  const [loading, setLoading] = useState(true);

  const toast = useToast();

  useEffect(() => {
    let cancelled = false;

    const load = async () => {
      setLoading(true);
      try {
        const data = await getLeaderboard(50);
        if (!cancelled) setLeaders(data as LeaderboardUser[]);
      } catch (err) {
        console.error("Failed to load leaderboard:", err);
        if (!cancelled) {
          toast.error("We couldn't load the leaderboard right now. Please try again.");
        }
      } finally {
        if (!cancelled) setLoading(false);
      }
    };

    load();

    return () => {
      cancelled = true;
    };
  }, []);

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
          {loading ? (
            <div className="flex items-center justify-center py-12 text-gray-500 gap-2">
              <Loader2 className="h-5 w-5 animate-spin" />
              Loading leaderboard…
            </div>
          ) : leaders.length === 0 ? (
            <p className="text-center text-gray-500 py-12">
              No members have earned points yet.
            </p>
          ) : (
            <div className="space-y-4">
              {leaders.map((user, idx) => {
                const ward = getWardById(user.ward_id);
                return (
                  <div
                    key={user.id}
                    className="flex items-center space-x-4 pb-4 border-b last:border-0"
                  >
                    <div
                      className={cn(
                        "h-10 w-10 rounded-full flex items-center justify-center font-bold text-lg",
                        idx === 0
                          ? "bg-yellow-100 text-yellow-700"
                          : idx === 1
                            ? "bg-gray-100 text-gray-700"
                            : idx === 2
                              ? "bg-orange-100 text-orange-700"
                              : "bg-gray-50 text-gray-500",
                      )}
                    >
                      {idx < 3 ? <Medal className="h-5 w-5" /> : idx + 1}
                    </div>
                    <div className="flex-1">
                      <p className="font-medium">
                        {user.full_name ?? "Member"}
                      </p>
                      <p className="text-sm text-gray-500">
                        {ward ? ward.name : "Ward not set"}
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
