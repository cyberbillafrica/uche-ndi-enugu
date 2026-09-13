"use client";

import { useEffect, useState } from "react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { getAllUsers, getAllTasks } from "@/lib/firebase/firestore";
import { getAllLGAs } from "@/lib/constants";
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
import type { LGA } from "@/types";

export default function AdminReportsPage() {
  const [users, setUsers] = useState<any[]>([]);
  const [tasks, setTasks] = useState<any[]>([]);
  const [lgas, setLgas] = useState<LGA[]>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    async function loadData() {
      try {
        const [userData, taskData, lgaData] = await Promise.all([
          getAllUsers(),
          getAllTasks(),
          getAllLGAs(),
        ]);
        setUsers(userData);
        setTasks(taskData);
        setLgas(lgaData);
      } catch (err) {
        console.error("Failed to load admin reports data:", err);
      } finally {
        setLoading(false);
      }
    }
    loadData();
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
    let wardName = u.ward || u.ward_id || "Unassigned";
    if (u.ward_id && lgas.length > 0) {
      for (const l of lgas) {
        const w = l.wards.find((item) => item.id === u.ward_id);
        if (w) {
          wardName = w.name;
          break;
        }
      }
    }

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
        <Loader2 className="h-8 w-8 animate-spin text-apc-primary" />
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
            <Download className="h-3.5 w-3.5 text-apc-primary" /> CSV
          </button>
          <button
            onClick={handleExportExcel}
            className="inline-flex items-center gap-1.5 px-3 py-2 bg-white border rounded-lg text-xs font-semibold text-emerald-700 hover:bg-emerald-50 shadow-sm"
          >
            <FileSpreadsheet className="h-3.5 w-3.5 text-emerald-600" /> Excel
          </button>
          <button
            onClick={handlePrint}
            className="inline-flex items-center gap-1.5 px-3 py-2 bg-apc-primary text-white rounded-lg text-xs font-semibold hover:bg-apc-dark shadow-sm"
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
              <BarChart3 className="h-5 w-5 text-apc-primary" />
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
                  className="bg-apc-primary h-2.5 rounded-full"
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
              <MapPin className="h-5 w-5 text-apc-primary" />
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
                    <span className="font-bold text-apc-primary">{w.points.toLocaleString()} pts</span>
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
              <span className="font-bold text-gray-900">{lgas.length}</span>
            </div>
            <div className="flex justify-between items-center p-3 bg-gray-50 rounded-lg">
              <span className="text-gray-600 font-medium">Total Electoral Wards</span>
              <span className="font-bold text-gray-900">
                {lgas.reduce((acc, l) => acc + l.wards.length, 0)}
              </span>
            </div>
            <div className="flex justify-between items-center p-3 bg-gray-50 rounded-lg">
              <span className="text-gray-600 font-medium">Total Polling Units</span>
              <span className="font-bold text-gray-900">
                {lgas.reduce(
                  (acc, l) => acc + l.wards.reduce((wAcc, w) => wAcc + w.pollingUnits.length, 0),
                  0
                )}
              </span>
            </div>
          </CardContent>
        </Card>

        {/* Task Engagement Leaderboard Overview */}
        <Card>
          <CardHeader>
            <CardTitle className="flex items-center gap-2 text-base font-bold">
              <Briefcase className="h-5 w-5 text-apc-primary" />
              Campaign Operations Overview
            </CardTitle>
          </CardHeader>
          <CardContent className="space-y-3 text-xs">
            <div className="flex justify-between items-center p-3 bg-gray-50 rounded-lg">
              <span className="text-gray-600 font-medium">Active Tasks Configured</span>
              <span className="font-bold text-apc-primary">{tasks.filter((t) => t.status === "active").length}</span>
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
