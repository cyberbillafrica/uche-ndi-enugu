"use client";

import { useEffect, useMemo, useState } from "react";
import {
  ArrowRight,
  CheckCircle2,
  Clock3,
  ExternalLink,
  Loader2,
  Medal,
  Send,
  ShieldCheck,
  Star,
  Target,
  TrendingUp,
  Trophy,
  Users,
} from "lucide-react";

import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";

import { cn, formatNumber } from "@/lib/utils";
import { useAuth } from "@/contexts/AuthContext";

import {
  getSupabaseClient,
  ensureSupabaseSession,
  resolveSocialAccess,
  SocialForceError,
  getSocialTasks,
  getMySubmissions,
  getSocialLeaderboard,
  type SocialLeaderboardEntry,
} from "@/lib/supabase";

import { SiFacebook, SiInstagram, SiTiktok, SiX } from "react-icons/si";

interface ActiveTask {
  id: string;
  platform?: string;
  action?: string;
  points?: number;
  url?: string;
  expiration_date?: string | null;
  status?: string;
}

interface DashboardSubmission {
  id: string;
  task_id: string;
  status: "pending" | "verified";
  submitted_at: string | null;
}

function formatSubmittedAt(value: string | null) {
  if (!value) return "Recently";

  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "Recently";

  return date.toLocaleDateString("en-NG", {
    month: "short",
    day: "numeric",
  });
}

function getPlatformStyle(platform?: string) {
  switch (platform?.toLowerCase()) {
    case "facebook":
      return "bg-blue-100 text-blue-700";

    case "instagram":
      return "bg-pink-100 text-pink-700";

    case "tiktok":
      return "bg-gray-900 text-white";

    case "x":
      return "bg-gray-100 text-gray-900";

    default:
      return "bg-brand-primary/10 text-brand-primary";
  }
}

function getPlatformInitial(platform?: string) {
  switch (platform?.toLowerCase()) {
    case "facebook":
      return "f";

    case "instagram":
      return "ig";

    case "tiktok":
      return "tk";

    case "x":
      return "X";

    default:
      return "•";
  }
}

function formatDeadline(deadline?: string | null) {
  if (!deadline) return null;

  const date = new Date(deadline);

  if (Number.isNaN(date.getTime())) {
    return deadline;
  }

  return date.toLocaleDateString("en-NG", {
    month: "short",
    day: "numeric",
    year: "numeric",
  });
}

export default function MemberDashboard() {
  const { profile, loading: authLoading } = useAuth();

  const [leaderboard, setLeaderboard] = useState<SocialLeaderboardEntry[]>([]);
  const [submissions, setSubmissions] = useState<DashboardSubmission[]>([]);
  const [activeTasks, setActiveTasks] = useState<ActiveTask[]>([]);
  const [authoritativePoints, setAuthoritativePoints] = useState<number | null>(
    null,
  );

  const [loadingData, setLoadingData] = useState(true);
  const [loadError, setLoadError] = useState("");

  useEffect(() => {
    if (authLoading || !profile?.id) return;

    let cancelled = false;

    const loadDashboard = async () => {
      setLoadingData(true);
      setLoadError("");

      try {
        const bridge = await ensureSupabaseSession();
        if (cancelled) return;
        if (!bridge.sessionReady) {
          setLoadError("Your session has expired. Please sign in again.");
          setLoadingData(false);
          return;
        }

        const supabase = getSupabaseClient();

        const access = await resolveSocialAccess(supabase);
        if (cancelled) return;
        if (!access.allowed) {
          // Fail closed with the standard module/authorization message —
          // identical contract to the Tasks/Points/Leaderboard pages.
          setLoadError(
            access.reason === "module_disabled"
              ? "The Social Force module is not enabled for your organization."
              : "You do not have permission to view the Social dashboard.",
          );
          setLoadingData(false);
          return;
        }

        // Three authoritative reads, all RLS-scoped by resolveSocialAccess
        // plus the security_invoker view policies:
        //   tasks        → active, unexpired (RLS member policy)
        //   submissions  → the caller's own rows only (Phase C path)
        //   leaderboard  → social_leaderboard projection with its own rank
        const [taskData, submissionData, leaderboardData] = await Promise.all([
          getSocialTasks(supabase, { status: "active" }),
          getMySubmissions(supabase),
          getSocialLeaderboard(supabase, { limit: 100 }),
        ]);

        if (cancelled) return;

        setActiveTasks(taskData as ActiveTask[]);
        setSubmissions(submissionData as DashboardSubmission[]);
        setLeaderboard(leaderboardData);
      } catch (error) {
        console.error("Failed to load dashboard data:", error);

        if (!cancelled) {
          setLoadError(
            error instanceof SocialForceError
              ? error.message
              : "Some dashboard data could not be loaded right now.",
          );
        }
      } finally {
        if (!cancelled) {
          setLoadingData(false);
        }
      }
    };

    loadDashboard();

    return () => {
      cancelled = true;
    };
  }, [authLoading, profile?.id]);

  // Points come from the server-maintained projection (politicore_profiles
  // view), never a client-side award reduction and never the legacy
  // Firebase users.points document (§6). The profile row already carries
  // the same projection; reading it through the service keeps one source.
  useEffect(() => {
    if (authLoading || !profile?.id) return;
    let cancelled = false;

    const loadPoints = async () => {
      try {
        const supabase = getSupabaseClient();
        const { getMySocialPoints } = await import("@/lib/supabase");
        const total = await getMySocialPoints(supabase);
        if (!cancelled) setAuthoritativePoints(total);
      } catch (error) {
        console.error("Failed to load points:", error);
        // Leave the profile fallback displayed rather than zeroing.
      }
    };

    loadPoints();
    return () => {
      cancelled = true;
    };
  }, [authLoading, profile?.id]);

  const submittedTaskIds = useMemo(() => {
    return new Set(submissions.map((submission) => submission.task_id));
  }, [submissions]);

  const pendingTasks = useMemo(() => {
    return activeTasks.filter((task) => !submittedTaskIds.has(task.id));
  }, [activeTasks, submittedTaskIds]);

  const tasksCompleted = useMemo(() => {
    return submissions.filter((submission) => submission.status === "verified")
      .length;
  }, [submissions]);

  const tasksPendingReview = useMemo(() => {
    return submissions.filter((submission) => submission.status === "pending")
      .length;
  }, [submissions]);

  // §7: the position IS the projection's own `position` column —
  // findIndex()+1 client ranking is gone.
  const leaderboardPosition = useMemo(() => {
    if (!profile?.id) return null;
    const mine = leaderboard.find((entry) => entry.id === profile.id);
    return mine ? mine.position : null;
  }, [leaderboard, profile]);

  const topPerformers = leaderboard.slice(0, 5);

  const recentSubmissions = submissions.slice(0, 5);

  const nextTasks = pendingTasks.slice(0, 3);

  if (authLoading || !profile) {
    return (
      <div className="flex min-h-[50vh] items-center justify-center gap-2 text-gray-500">
        <Loader2 className="h-5 w-5 animate-spin" />
        Loading your dashboard…
      </div>
    );
  }

  const roleLabel =
    profile.access_role === "admin"
      ? "Administrator"
      : profile.access_role === "election_officer"
        ? "Election Officer"
        : profile.membership_types?.includes("social_member")
          ? "Social Member"
          : "Campaign Member";

  return (
    <div className="space-y-6 pb-8">
      {/* ─────────────────────────────────────────────
          Header
      ───────────────────────────────────────────── */}

      <div className="flex flex-col gap-4 sm:flex-row sm:items-center sm:justify-between">
        <div>
          <p className="text-sm font-medium text-brand-primary">
            Member Dashboard
          </p>

          <h1 className="mt-1 text-2xl font-bold text-gray-900 sm:text-3xl">
            Welcome back, {profile.full_name || "Member"}
          </h1>

          <p className="mt-1 text-gray-600">
            Track your campaign activity, complete tasks, and climb the
            leaderboard.
          </p>
        </div>

        <div className="flex w-fit items-center gap-2 rounded-lg bg-brand-primary px-4 py-2 text-white shadow-sm">
          <ShieldCheck className="h-5 w-5" />

          <span className="font-semibold">{roleLabel}</span>
        </div>
      </div>

      {loadError && (
        <div className="rounded-lg border border-red-200 bg-red-50 p-4 text-sm text-red-700">
          {loadError}
        </div>
      )}

      {/* ─────────────────────────────────────────────
          Main Stats
      ───────────────────────────────────────────── */}

      <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 xl:grid-cols-4">
        {/* Points */}

        <Card className="border-0 shadow-sm">
          <CardContent className="p-5">
            <div className="flex items-center justify-between">
              <div>
                <p className="text-sm font-medium text-gray-500">
                  Total Points
                </p>

                <p className="mt-1 text-3xl font-bold text-brand-primary">
                  {authoritativePoints === null
                    ? formatNumber(profile.points ?? 0)
                    : formatNumber(authoritativePoints)}
                </p>

                <p className="mt-1 text-xs text-gray-500">
                  Earned from verified tasks
                </p>
              </div>

              <div className="flex h-12 w-12 items-center justify-center rounded-full bg-brand-primary/10">
                <Star className="h-6 w-6 text-brand-primary" />
              </div>
            </div>
          </CardContent>
        </Card>

        {/* Pending Tasks */}

        <Card className="border-0 shadow-sm">
          <CardContent className="p-5">
            <div className="flex items-center justify-between">
              <div>
                <p className="text-sm font-medium text-gray-500">
                  Pending Tasks
                </p>

                <p className="mt-1 text-3xl font-bold text-orange-600">
                  {loadingData ? "…" : pendingTasks.length}
                </p>

                <p className="mt-1 text-xs text-gray-500">
                  Tasks waiting for you
                </p>
              </div>

              <div className="flex h-12 w-12 items-center justify-center rounded-full bg-orange-100">
                <Target className="h-6 w-6 text-orange-600" />
              </div>
            </div>
          </CardContent>
        </Card>

        {/* Completed */}

        <Card className="border-0 shadow-sm">
          <CardContent className="p-5">
            <div className="flex items-center justify-between">
              <div>
                <p className="text-sm font-medium text-gray-500">
                  Tasks Completed
                </p>

                <p className="mt-1 text-3xl font-bold text-green-600">
                  {loadingData ? "…" : tasksCompleted}
                </p>

                <p className="mt-1 text-xs text-gray-500">Verified by admin</p>
              </div>

              <div className="flex h-12 w-12 items-center justify-center rounded-full bg-green-100">
                <CheckCircle2 className="h-6 w-6 text-green-600" />
              </div>
            </div>
          </CardContent>
        </Card>

        {/* Pending Review */}

        <Card className="border-0 shadow-sm">
          <CardContent className="p-5">
            <div className="flex items-center justify-between">
              <div>
                <p className="text-sm font-medium text-gray-500">
                  Pending Review
                </p>

                <p className="mt-1 text-3xl font-bold text-blue-600">
                  {loadingData ? "…" : tasksPendingReview}
                </p>

                <p className="mt-1 text-xs text-gray-500">Submitted to admin</p>
              </div>

              <div className="flex h-12 w-12 items-center justify-center rounded-full bg-blue-100">
                <Clock3 className="h-6 w-6 text-blue-600" />
              </div>
            </div>
          </CardContent>
        </Card>
      </div>

      {/* ─────────────────────────────────────────────
          Social Media
      ───────────────────────────────────────────── */}

      <Card className="border-0 shadow-sm">
        <CardHeader>
          <CardTitle className="text-lg font-semibold">Social Media</CardTitle>

          <p className="mt-1 text-sm text-gray-500">
            Your connected campaign social platforms
          </p>
        </CardHeader>

        <CardContent>
          <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
            {/* Facebook */}
            <div className="rounded-xl border border-gray-200 bg-gray-50 p-4">
              <div className="flex items-start justify-between gap-3">
                <div className="flex min-w-0 items-center gap-3">
                  <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-full bg-blue-100">
                    <SiFacebook className="h-5 w-5 text-[#1877F2]" />
                  </div>

                  <div className="min-w-0">
                    <p className="text-sm font-semibold text-gray-900">
                      Facebook
                    </p>

                    <p className="truncate text-sm text-gray-600">
                      {profile.facebook_name || "Not connected"}
                    </p>
                  </div>
                </div>

                {profile.facebook_profile_url && (
                  <a
                    href={profile.facebook_profile_url}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="shrink-0 text-gray-400 transition hover:text-brand-primary"
                    title="Open Facebook profile"
                  >
                    <ExternalLink className="h-4 w-4" />
                  </a>
                )}
              </div>
            </div>

            {/* Instagram */}
            <div className="rounded-xl border border-gray-200 bg-gray-50 p-4">
              <div className="flex items-start justify-between gap-3">
                <div className="flex min-w-0 items-center gap-3">
                  <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-full bg-pink-100">
                    <SiInstagram className="h-5 w-5 text-[#E4405F]" />
                  </div>

                  <div className="min-w-0">
                    <p className="text-sm font-semibold text-gray-900">
                      Instagram
                    </p>

                    <p className="truncate text-sm text-gray-600">
                      {profile.instagram_name || "Not connected"}
                    </p>
                  </div>
                </div>

                {profile.instagram_profile_url && (
                  <a
                    href={profile.instagram_profile_url}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="shrink-0 text-gray-400 transition hover:text-brand-primary"
                    title="Open Instagram profile"
                  >
                    <ExternalLink className="h-4 w-4" />
                  </a>
                )}
              </div>
            </div>

            {/* X */}
            <div className="rounded-xl border border-gray-200 bg-gray-50 p-4">
              <div className="flex items-start justify-between gap-3">
                <div className="flex min-w-0 items-center gap-3">
                  <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-full bg-gray-200">
                    <SiX className="h-5 w-5 text-gray-900" />
                  </div>

                  <div className="min-w-0">
                    <p className="text-sm font-semibold text-gray-900">X</p>

                    <p className="truncate text-sm text-gray-600">
                      {profile.x_name || "Not connected"}
                    </p>
                  </div>
                </div>

                {profile.x_profile_url && (
                  <a
                    href={profile.x_profile_url}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="shrink-0 text-gray-400 transition hover:text-brand-primary"
                    title="Open X profile"
                  >
                    <ExternalLink className="h-4 w-4" />
                  </a>
                )}
              </div>
            </div>

            {/* TikTok */}
            <div className="rounded-xl border border-gray-200 bg-gray-50 p-4">
              <div className="flex items-start justify-between gap-3">
                <div className="flex min-w-0 items-center gap-3">
                  <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-full bg-gray-900">
                    <SiTiktok className="h-5 w-5 text-white" />
                  </div>

                  <div className="min-w-0">
                    <p className="text-sm font-semibold text-gray-900">
                      TikTok
                    </p>

                    <p className="truncate text-sm text-gray-600">
                      {profile.tiktok_name || "Not connected"}
                    </p>
                  </div>
                </div>

                {profile.tiktok_profile_url && (
                  <a
                    href={profile.tiktok_profile_url}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="shrink-0 text-gray-400 transition hover:text-brand-primary"
                    title="Open TikTok profile"
                  >
                    <ExternalLink className="h-4 w-4" />
                  </a>
                )}
              </div>
            </div>
          </div>

          <div className="mt-4 rounded-lg bg-brand-primary/5 px-4 py-3">
            <p className="text-xs leading-5 text-gray-600">
              Keep your social handles updated so administrators can correctly
              verify your social media task submissions.
            </p>
          </div>
        </CardContent>
      </Card>

      {/* ─────────────────────────────────────────────
          Primary Task CTA
      ───────────────────────────────────────────── */}

      <Card className="overflow-hidden border-0 bg-gradient-to-r from-brand-primary to-brand-primary text-white shadow-md">
        <CardContent className="p-6">
          <div className="flex flex-col gap-5 md:flex-row md:items-center md:justify-between">
            <div>
              <div className="mb-2 flex items-center gap-2">
                <Target className="h-5 w-5" />

                <span className="text-sm font-semibold uppercase tracking-wide text-white/80">
                  Keep making an impact
                </span>
              </div>

              <h2 className="text-xl font-bold sm:text-2xl">
                {pendingTasks.length > 0
                  ? `You have ${pendingTasks.length} task${
                      pendingTasks.length === 1 ? "" : "s"
                    } waiting for you.`
                  : "You're all caught up!"}
              </h2>

              <p className="mt-1 max-w-2xl text-sm text-white/80">
                {pendingTasks.length > 0
                  ? "Complete a task, submit it for review, and earn points when it is verified."
                  : "Check back later for new campaign tasks."}
              </p>
            </div>

            <a
              href="/portal/tasks"
              className="inline-flex shrink-0 items-center justify-center gap-2 rounded-lg bg-white px-5 py-3 text-sm font-semibold text-brand-primary transition hover:bg-gray-100"
            >
              View Tasks
              <ArrowRight className="h-4 w-4" />
            </a>
          </div>
        </CardContent>
      </Card>

      {/* ─────────────────────────────────────────────
          Next Tasks + Leaderboard
      ───────────────────────────────────────────── */}

      <div className="grid gap-6 lg:grid-cols-2">
        {/* Next Tasks */}

        <Card className="border-0 shadow-sm">
          <CardHeader className="flex flex-row items-center justify-between">
            <div>
              <CardTitle className="text-lg font-semibold">
                Tasks Waiting for You
              </CardTitle>

              <p className="mt-1 text-sm text-gray-500">
                Complete these to earn more points.
              </p>
            </div>

            <a
              href="/portal/tasks"
              className="hidden items-center gap-1 text-sm font-medium text-brand-primary hover:underline sm:flex"
            >
              View all
              <ArrowRight className="h-4 w-4" />
            </a>
          </CardHeader>

          <CardContent>
            {loadingData ? (
              <div className="flex items-center justify-center gap-2 py-8 text-gray-500">
                <Loader2 className="h-5 w-5 animate-spin" />
                Loading tasks…
              </div>
            ) : nextTasks.length === 0 ? (
              <div className="rounded-lg bg-green-50 p-6 text-center">
                <CheckCircle2 className="mx-auto h-8 w-8 text-green-600" />

                <p className="mt-2 font-semibold text-green-800">
                  All caught up!
                </p>

                <p className="mt-1 text-sm text-green-700">
                  You have completed or submitted all currently available tasks.
                </p>
              </div>
            ) : (
              <div className="space-y-3">
                {nextTasks.map((task) => {
                  const deadline = formatDeadline(task.expiration_date);

                  return (
                    <div
                      key={task.id}
                      className="rounded-lg border bg-white p-4 transition hover:border-brand-primary/40 hover:shadow-sm"
                    >
                      <div className="flex items-start gap-3">
                        <div
                          className={cn(
                            "flex h-10 w-10 shrink-0 items-center justify-center rounded-lg text-xs font-bold uppercase",
                            getPlatformStyle(task.platform),
                          )}
                        >
                          {getPlatformInitial(task.platform)}
                        </div>

                        <div className="min-w-0 flex-1">
                          <div className="flex flex-wrap items-center gap-2">
                            <p className="font-semibold text-gray-900">
                              {task.platform || "Social Media"} ·{" "}
                              {task.action || "Task"}
                            </p>

                            <span className="rounded-full bg-brand-primary/10 px-2 py-1 text-xs font-semibold text-brand-primary">
                              {formatNumber(task.points ?? 0)} pts
                            </span>
                          </div>

                          {deadline && (
                            <p className="mt-1 text-xs text-gray-500">
                              Deadline: {deadline}
                            </p>
                          )}
                        </div>

                        {task.url && (
                          <a
                            href={task.url}
                            target="_blank"
                            rel="noopener noreferrer"
                            className="shrink-0 rounded-md p-2 text-gray-400 transition hover:bg-gray-100 hover:text-brand-primary"
                            title="Open post"
                          >
                            <ExternalLink className="h-4 w-4" />
                          </a>
                        )}
                      </div>
                    </div>
                  );
                })}

                <a
                  href="/portal/tasks"
                  className="flex w-full items-center justify-center gap-2 rounded-lg bg-gray-50 py-3 text-sm font-semibold text-brand-primary transition hover:bg-brand-primary/5"
                >
                  View all tasks
                  <ArrowRight className="h-4 w-4" />
                </a>
              </div>
            )}
          </CardContent>
        </Card>

        {/* Leaderboard */}

        <Card className="border-0 shadow-sm">
          <CardHeader className="flex flex-row items-center justify-between">
            <div>
              <CardTitle className="text-lg font-semibold">
                Top Performers
              </CardTitle>

              <p className="mt-1 text-sm text-gray-500">
                Members leading the campaign.
              </p>
            </div>

            <Trophy className="h-5 w-5 text-yellow-500" />
          </CardHeader>

          <CardContent>
            {loadingData ? (
              <div className="flex items-center justify-center gap-2 py-8 text-gray-500">
                <Loader2 className="h-5 w-5 animate-spin" />
                Loading leaderboard…
              </div>
            ) : topPerformers.length === 0 ? (
              <p className="py-8 text-center text-gray-500">
                No leaderboard data yet.
              </p>
            ) : (
              <div className="space-y-3">
                {topPerformers.map((member, index) => (
                  <div
                    key={member.id}
                    className={cn(
                      "flex items-center gap-3 rounded-lg p-3",
                      member.id === profile.id
                        ? "bg-brand-primary/5 ring-1 ring-brand-primary/10"
                        : "bg-gray-50",
                    )}
                  >
                    <div
                      className={cn(
                        "flex h-9 w-9 shrink-0 items-center justify-center rounded-full text-sm font-bold",
                        index === 0
                          ? "bg-yellow-100 text-yellow-700"
                          : index === 1
                            ? "bg-gray-200 text-gray-700"
                            : index === 2
                              ? "bg-orange-100 text-orange-700"
                              : "bg-white text-gray-500",
                      )}
                    >
                      {index === 0 ? (
                        <Medal className="h-5 w-5" />
                      ) : (
                        member.position
                      )}
                    </div>

                    <div className="min-w-0 flex-1">
                      <p className="truncate text-sm font-semibold text-gray-900">
                        {member.full_name || "Member"}

                        {member.id === profile.id && (
                          <span className="ml-2 text-xs font-medium text-brand-primary">
                            You
                          </span>
                        )}
                      </p>

                      <p className="text-xs text-gray-500">
                        {member.ward_name
                          ? `${member.ward_name} Ward`
                          : "Ward not set"}
                      </p>
                    </div>

                    <div className="text-right">
                      <p className="text-sm font-bold text-brand-primary">
                        {formatNumber(member.points ?? 0)}
                      </p>

                      <p className="text-[10px] uppercase tracking-wide text-gray-400">
                        points
                      </p>
                    </div>
                  </div>
                ))}
              </div>
            )}

            {!loadingData && leaderboardPosition && (
              <div className="mt-4 flex items-center justify-between rounded-lg bg-orange-50 p-3">
                <div className="flex items-center gap-2">
                  <TrendingUp className="h-4 w-4 text-orange-600" />

                  <span className="text-sm font-medium text-orange-800">
                    Your leaderboard position
                  </span>
                </div>

                <span className="font-bold text-orange-700">
                  #{leaderboardPosition}
                </span>
              </div>
            )}
          </CardContent>
        </Card>
      </div>

      {/* ─────────────────────────────────────────────
          Recent Activity
      ───────────────────────────────────────────── */}

      <Card className="border-0 shadow-sm">
        <CardHeader className="flex flex-row items-center justify-between">
          <div>
            <CardTitle className="text-lg font-semibold">
              Recent Activity
            </CardTitle>

            <p className="mt-1 text-sm text-gray-500">
              Your latest task submissions and reviews.
            </p>
          </div>

          <Users className="h-5 w-5 text-gray-400" />
        </CardHeader>

        <CardContent>
          {loadingData ? (
            <div className="flex items-center justify-center gap-2 py-8 text-gray-500">
              <Loader2 className="h-5 w-5 animate-spin" />
              Loading activity…
            </div>
          ) : recentSubmissions.length === 0 ? (
            <div className="py-8 text-center">
              <Send className="mx-auto h-8 w-8 text-gray-300" />

              <p className="mt-2 font-medium text-gray-600">
                No task activity yet.
              </p>

              <p className="mt-1 text-sm text-gray-500">
                Complete your first task to get started.
              </p>

              <a
                href="/portal/tasks"
                className="mt-4 inline-flex items-center gap-2 rounded-lg bg-brand-primary px-4 py-2 text-sm font-semibold text-white hover:bg-brand-primary"
              >
                View Tasks
                <ArrowRight className="h-4 w-4" />
              </a>
            </div>
          ) : (
            <div className="divide-y">
              {recentSubmissions.map((submission) => {
                const isVerified = submission.status === "verified";

                return (
                  <div
                    key={submission.id}
                    className="flex items-center gap-4 py-4 first:pt-0 last:pb-0"
                  >
                    <div
                      className={cn(
                        "flex h-10 w-10 shrink-0 items-center justify-center rounded-full",
                        isVerified ? "bg-green-100" : "bg-blue-100",
                      )}
                    >
                      {isVerified ? (
                        <CheckCircle2 className="h-5 w-5 text-green-600" />
                      ) : (
                        <Clock3 className="h-5 w-5 text-blue-600" />
                      )}
                    </div>

                    <div className="min-w-0 flex-1">
                      <p className="text-sm font-semibold text-gray-900">
                        {isVerified
                          ? "Task verified"
                          : "Task submitted for review"}
                      </p>

                      <p className="mt-1 text-xs text-gray-500">
                        {formatSubmittedAt(submission.submitted_at)}
                      </p>
                    </div>

                    <span
                      className={cn(
                        "rounded-full px-3 py-1 text-xs font-semibold",
                        isVerified
                          ? "bg-green-100 text-green-700"
                          : "bg-blue-100 text-blue-700",
                      )}
                    >
                      {isVerified ? "Verified" : "Pending"}
                    </span>
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
