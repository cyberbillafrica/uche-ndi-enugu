"use client";

import { useEffect, useState } from "react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import {
  getSupabaseClient,
  ensureSupabaseSession,
  resolveSocialAccess,
  getSocialTasks,
  type SocialTask,
  listMembers,
  listAllWards,
  getGeographyCounts,
  type DirectoryMember,
  type GeoWard,
} from "@/lib/supabase";
import { exportToCSV, exportToExcel, exportToPDFPrint } from "@/lib/export";
import {
  BarChart3,
  Download,
  Printer,
  Users,
  Award,
  CheckSquare,
  TrendingUp,
  MapPin,
  Loader2,
  FileSpreadsheet,
  Vote,
  Calendar,
  AlertTriangle,
  Briefcase,
} from "lucide-react";
function getWardName(u: Pick<DirectoryMember, "ward_id">, wards: Map<string, string>): string {
  if (!u.ward_id) return "Unassigned";
  return wards.get(u.ward_id) ?? u.ward_id;
}

export default function AdminReportsPage() {
  const [users, setUsers] = useState<DirectoryMember[]>([]);
  const [tasks, setTasks] = useState<SocialTask[]>([]);
  const [wardNames, setWardNames] = useState<Map<string, string>>(new Map());
  const [geoCounts, setGeoCounts] = useState<{ lgas: number; wards: number; pollingUnits: number }>({
    lgas: 0,
    wards: 0,
    pollingUnits: 0,
  });
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let cancelled = false;

    async function loadSocialTasks() {
      // Social task stats via the canonical Social Force service
      // (admin authority resolved server-side; module gate enforced —
      // Phase E cutover from the legacy Firebase tenant-wide read).
      try {
        const bridge = await ensureSupabaseSession();
        if (!bridge.sessionReady || cancelled) return;
        const supabase = bridge.supabase ?? getSupabaseClient();
        const access = await resolveSocialAccess(supabase);
        if (!access.allowed || cancelled) return;
        const rows = await getSocialTasks(supabase);
        if (!cancelled) setTasks(rows);
      } catch (err) {
        console.error("Failed to load social task stats:", err);
      }
    }

    async function loadData() {
      try {
        // Canonical Supabase directory + geography (RLS-scoped reads).
        const [memberData, wardData, geoCounts] = await Promise.all([
          listMembers(),
          listAllWards(),
          getGeographyCounts(),
        ]);
        if (cancelled) return;
        setUsers(memberData);
        setWardNames(new Map(wardData.map((w: GeoWard) => [w.id, w.name])));
        setGeoCounts(geoCounts);
      } catch (err) {
        console.error("Failed to load admin reports data:", err);
      } finally {
        if (!cancelled) setLoading(false);
      }
    }

    void loadSocialTasks();
    loadData();

    return () => {
      cancelled = true;
    };
  }, []);

  const totalMembers = users.length;
  const campaignMembers = users.filter((u) =>
    u.membership_types?.includes("campaign_member")
  ).length;
  const socialMembers = users.filter((u) =>
    u.membership_types?.includes("social_member")
  ).length;
  const totalPoints = users.reduce((acc, u) => acc + (Number(u.points) || 0), 0);

  // Ward performance map
  const wardMap = new Map<string, { name: string; count: number; points: number }>();

  users.forEach((u) => {
    const wardName = getWardName(u, wardNames);

    if (!wardMap.has(wardName)) {
      wardMap.set(wardName, { name: wardName, count: 0, points: 0 });
    }
    const entry = wardMap.get(wardName)!;
    entry.count += 1;
    entry.points += Number(u.points) || 0;
  });

  const wardPerformance = Array.from(wardMap.values()).sort(
    (a, b) => b.points - a.points
  );

  const handleExportCSV = () => {
    const headers = ["Member Name", "Email", "Ward", "Membership", "Points"];
    const rows = users.map((u) => [
      u.full_name || "",
      u.email || "",
      u.ward_id || "",
      (u.membership_types || []).join(";"),
      u.points || 0,
    ]);
    exportToCSV(`campaign_engagement_report_${Date.now()}.csv`, headers, rows);
  };

  const handleExportExcel = () => {
    const headers = ["Member Name", "Email", "Ward", "Membership", "Points"];
    const rows = users.map((u) => [
      u.full_name || "",
      u.email || "",
      u.ward_id || "",
      (u.membership_types || []).join(";"),
      u.points || 0,
    ]);
    exportToExcel(`campaign_engagement_report_${Date.now()}.xls`, "Engagement Report", headers, rows);
  };

  const handlePrint = () => {
    exportToPDFPrint();
  };

  if (loading) {
    return (
      <div className="flex flex-col items-center justify-center min-h-[50vh] space-y-3">
        <Loader2 className="h-8 w-8 animate-spin text-brand-primary" />
        <span className="text-sm text-gray-500">Generating analytics reports...</span>
      </div>
    );
  }

  return (
    <div className="space-y-6 pb-12">
      <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-4">
        <div>
          <h1 className="text-2xl font-bold text-gray-900">Campaign Analytics & Reports</h1>
          <p className="text-sm text-gray-500">
            Real-time performance metrics across member registrations, tasks, ward distributions, and election operations.
          </p>
        </div>

        <div className="flex flex-wrap items-center gap-2">
          <button
            onClick={handleExportCSV}
            className="inline-flex items-center gap-1.5 px-3 py-2 bg-white border rounded-lg text-xs font-semibold text-gray-700 hover:bg-gray-50 shadow-sm"
          >
            <Download className="h-3.5 w-3.5 text-brand-primary" /> CSV
          </button>
          <button
            onClick={handleExportExcel}
            className="inline-flex items-center gap-1.5 px-3 py-2 bg-white border rounded-lg text-xs font-semibold text-emerald-700 hover:bg-emerald-50 shadow-sm"
          >
            <FileSpreadsheet className="h-3.5 w-3.5 text-emerald-600" /> Excel
          </button>
          <button
            onClick={handlePrint}
            className="inline-flex items-center gap-1.5 px-3 py-2 bg-brand-primary text-white rounded-lg text-xs font-semibold hover:bg-brand-primary shadow-sm"
          >
            <Printer className="h-3.5 w-3.5" /> Print / PDF
          </button>
        </div>
      </div>

      {/* Summary Cards */}
      <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-4">
        <Card>
          <CardContent className="p-5 flex items-center justify-between">
            <div>
              <p className="text-xs font-bold text-gray-400 uppercase">Total Registered</p>
              <p className="text-2xl font-bold text-gray-900 mt-1">{totalMembers}</p>
            </div>
            <Users className="h-8 w-8 text-blue-600 shrink-0" />
          </CardContent>
        </Card>

        <Card>
          <CardContent className="p-5 flex items-center justify-between">
            <div>
              <p className="text-xs font-bold text-gray-400 uppercase">Campaign Council</p>
              <p className="text-2xl font-bold text-emerald-800 mt-1">{campaignMembers}</p>
            </div>
            <TrendingUp className="h-8 w-8 text-emerald-600 shrink-0" />
          </CardContent>
        </Card>

        <Card>
          <CardContent className="p-5 flex items-center justify-between">
            <div>
              <p className="text-xs font-bold text-gray-400 uppercase">Active Tasks</p>
              <p className="text-2xl font-bold text-amber-800 mt-1">{tasks.length}</p>
            </div>
            <CheckSquare className="h-8 w-8 text-amber-600 shrink-0" />
          </CardContent>
        </Card>

        <Card>
          <CardContent className="p-5 flex items-center justify-between">
            <div>
              <p className="text-xs font-bold text-gray-400 uppercase">Awarded Points</p>
              <p className="text-2xl font-bold text-purple-900 mt-1">
                {totalPoints.toLocaleString()}
              </p>
            </div>
            <Award className="h-8 w-8 text-purple-600 shrink-0" />
          </CardContent>
        </Card>
      </div>

      <div className="grid md:grid-cols-2 gap-6">
        {/* Member Breakdown */}
        <Card>
          <CardHeader>
            <CardTitle className="flex items-center gap-2 text-base font-bold">
              <BarChart3 className="h-5 w-5 text-brand-primary" />
              Member Type Distribution
            </CardTitle>
          </CardHeader>
          <CardContent className="space-y-4">
            <div>
              <div className="flex justify-between text-xs font-semibold mb-1">
                <span>Campaign Council Members</span>
                <span>{campaignMembers} ({totalMembers > 0 ? ((campaignMembers / totalMembers) * 100).toFixed(1) : 0}%)</span>
              </div>
              <div className="w-full bg-gray-100 rounded-full h-2.5">
                <div
                  className="bg-emerald-600 h-2.5 rounded-full"
                  style={{ width: `${totalMembers > 0 ? (campaignMembers / totalMembers) * 100 : 0}%` }}
                />
              </div>
            </div>

            <div>
              <div className="flex justify-between text-xs font-semibold mb-1">
                <span>Social Media Members</span>
                <span>{socialMembers} ({totalMembers > 0 ? ((socialMembers / totalMembers) * 100).toFixed(1) : 0}%)</span>
              </div>
              <div className="w-full bg-gray-100 rounded-full h-2.5">
                <div
                  className="bg-brand-primary h-2.5 rounded-full"
                  style={{ width: `${totalMembers > 0 ? (socialMembers / totalMembers) * 100 : 0}%` }}
                />
              </div>
            </div>
          </CardContent>
        </Card>

        {/* Top Wards */}
        <Card>
          <CardHeader>
            <CardTitle className="flex items-center gap-2 text-base font-bold">
              <MapPin className="h-5 w-5 text-brand-primary" />
              Top Performing Wards (by Points & Registrations)
            </CardTitle>
          </CardHeader>
          <CardContent>
            <div className="space-y-3">
              {wardPerformance.slice(0, 5).map((w, idx) => (
                <div key={w.name} className="flex items-center justify-between text-xs border-b pb-2">
                  <div className="flex items-center gap-2">
                    <span className="font-bold text-gray-400">#{idx + 1}</span>
                    <span className="font-semibold text-gray-900">{w.name}</span>
                  </div>
                  <div className="text-right">
                    <span className="font-bold text-brand-primary">{w.points.toLocaleString()} pts</span>
                    <span className="text-gray-400 ml-2">({w.count} members)</span>
                  </div>
                </div>
              ))}
            </div>
          </CardContent>
        </Card>
      </div>

      {/* ADDITIONAL COMPREHENSIVE REPORTING SECTIONS */}
      <div className="grid md:grid-cols-2 gap-6">
        {/* Election Operations & PU Coverage Metrics */}
        <Card>
          <CardHeader>
            <CardTitle className="flex items-center gap-2 text-base font-bold">
              <Vote className="h-5 w-5 text-emerald-600" />
              Election Collation & PU Coverage
            </CardTitle>
          </CardHeader>
          <CardContent className="space-y-3 text-xs">
            <div className="flex justify-between items-center p-3 bg-gray-50 rounded-lg">
              <span className="text-gray-600 font-medium">Total Registered LGAs</span>
              <span className="font-bold text-gray-900">{geoCounts.lgas}</span>
            </div>
            <div className="flex justify-between items-center p-3 bg-gray-50 rounded-lg">
              <span className="text-gray-600 font-medium">Total Electoral Wards</span>
              <span className="font-bold text-gray-900">{geoCounts.wards}</span>
            </div>
            <div className="flex justify-between items-center p-3 bg-gray-50 rounded-lg">
              <span className="text-gray-600 font-medium">Total Polling Units</span>
              <span className="font-bold text-gray-900">{geoCounts.pollingUnits}</span>
            </div>
          </CardContent>
        </Card>

        {/* Task Engagement Leaderboard Overview */}
        <Card>
          <CardHeader>
            <CardTitle className="flex items-center gap-2 text-base font-bold">
              <Briefcase className="h-5 w-5 text-brand-primary" />
              Campaign Operations Overview
            </CardTitle>
          </CardHeader>
          <CardContent className="space-y-3 text-xs">
            <div className="flex justify-between items-center p-3 bg-gray-50 rounded-lg">
              <span className="text-gray-600 font-medium">Active Tasks Configured</span>
              <span className="font-bold text-brand-primary">{tasks.filter((t) => t.status === "active").length}</span>
            </div>
            <div className="flex justify-between items-center p-3 bg-gray-50 rounded-lg">
              <span className="text-gray-600 font-medium">Top User Highest Points</span>
              <span className="font-bold text-emerald-700">
                {users.reduce((max, u) => Math.max(max, Number(u.points) || 0), 0).toLocaleString()} pts
              </span>
            </div>
            <div className="flex justify-between items-center p-3 bg-gray-50 rounded-lg">
              <span className="text-gray-600 font-medium">Average Points / Member</span>
              <span className="font-bold text-gray-900">
                {totalMembers > 0 ? Math.round(totalPoints / totalMembers).toLocaleString() : 0} pts
              </span>
            </div>
          </CardContent>
        </Card>
      </div>
    </div>
  );
}
