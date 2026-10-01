"use client";

import { useState, useEffect } from "react";
import { useAuth } from "@/contexts/AuthContext";
import SocialMemberDashboard from "@/components/dashboard/SocialMemberDashboard";
import CampaignDashboard from "@/components/dashboard/CampaignDashboard";
import ElectionOfficerDashboard from "@/components/dashboard/ElectionOfficerDashboard";
import AdminDashboard from "@/components/dashboard/AdminDashboard";
import { Loader2, LayoutDashboard, Share2 } from "lucide-react";

const DASHBOARD_VIEW_KEY = "politicore_dashboard_view_preference";

export default function DashboardPage() {
  const { profile, loading } = useAuth();

  const isCampaignMember = profile?.membership_types?.includes("campaign_member") ?? false;
  const isSocialMember = profile?.membership_types?.includes("social_member") ?? false;
  const isDualMember = isCampaignMember && isSocialMember;

  const [dashboardView, setDashboardView] = useState<"campaign" | "social">("campaign");

  /* eslint-disable react-hooks/set-state-in-effect */
  useEffect(() => {
    if (typeof window !== "undefined" && isDualMember) {
      const savedPreference = localStorage.getItem(DASHBOARD_VIEW_KEY);
      if (savedPreference === "social" || savedPreference === "campaign") {
        setDashboardView(savedPreference);
      }
    }
  }, [isDualMember]);
  /* eslint-enable react-hooks/set-state-in-effect */

  const handleViewSwitch = (view: "campaign" | "social") => {
    setDashboardView(view);
    if (typeof window !== "undefined") {
      localStorage.setItem(DASHBOARD_VIEW_KEY, view);
    }
  };

  if (loading || !profile) {
    return (
      <div className="flex min-h-[50vh] items-center justify-center gap-2 text-gray-500">
        <Loader2 className="h-5 w-5 animate-spin" />
        Loading your dashboard…
      </div>
    );
  }

  /*
   * Dashboard routing is based on authority first,
   * then membership type.
   */

  // Highest portal authority.
  if (profile.access_role === "admin") {
    return <AdminDashboard />;
  }

  // Election operations authority.
  if (profile.access_role === "election_officer") {
    return <ElectionOfficerDashboard />;
  }

  // Dual members get an interactive view switcher persisted in localStorage.
  if (isDualMember) {
    return (
      <div className="space-y-4">
        <div className="flex items-center justify-between bg-white border border-gray-200 rounded-xl p-3 shadow-sm">
          <div className="text-sm font-semibold text-gray-700">
            Dashboard View Mode:
          </div>
          <div className="flex items-center gap-2 bg-gray-100 p-1 rounded-lg">
            <button
              onClick={() => handleViewSwitch("campaign")}
              className={`flex items-center gap-1.5 px-3 py-1.5 text-xs font-bold rounded-md transition-colors ${
                dashboardView === "campaign"
                  ? "bg-brand-primary text-white shadow"
                  : "text-gray-600 hover:text-gray-900"
              }`}
            >
              <LayoutDashboard className="w-3.5 h-3.5" />
              Campaign Operations
            </button>
            <button
              onClick={() => handleViewSwitch("social")}
              className={`flex items-center gap-1.5 px-3 py-1.5 text-xs font-bold rounded-md transition-colors ${
                dashboardView === "social"
                  ? "bg-brand-primary text-white shadow"
                  : "text-gray-600 hover:text-gray-900"
              }`}
            >
              <Share2 className="w-3.5 h-3.5" />
              Social Media Advocacy
            </button>
          </div>
        </div>
        {dashboardView === "campaign" ? <CampaignDashboard /> : <SocialMemberDashboard />}
      </div>
    );
  }

  // Social members get the social dashboard.
  if (isSocialMember) {
    return <SocialMemberDashboard />;
  }

  // Campaign members get the campaign dashboard.
  return <CampaignDashboard />;
}
