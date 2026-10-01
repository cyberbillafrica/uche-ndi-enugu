"use client";

import { useState, useEffect } from "react";
import Link from "next/link";
import NextImage from "next/image";
import { usePathname, useRouter } from "next/navigation";

import {
  LayoutDashboard,
  Users,
  UsersRound,
  CheckSquare,
  TrendingUp,
  Star,
  Vote,
  FileText,
  AlertTriangle,
  Upload,
  Menu,
  X,
  ChevronDown,
  Newspaper,
  Megaphone,
  BarChart3,
  Settings,
  LogOut,
  MapPin,
  Map,
  BriefcaseBusiness,
  CalendarDays,
  Flag,
  Network,
  Image,
  Bell,
  Check,
  ShieldCheck,
  Landmark,
  Inbox,
  FolderKanban,
  MessageSquareText,
} from "lucide-react";
import {
  subscribeMyNotifications,
  markNotificationsRead,
  markAllRead,
  resolveGovernanceAccess,
} from "@/lib/supabase";
import ContextualHelp from "@/components/help/ContextualHelp";
import GlobalSearchModal from "@/components/search/GlobalSearchModal";
import type { NotificationItem, UserProfile } from "@/types";

import { cn } from "@/lib/utils";
import { useAuth } from "@/contexts/AuthContext";
import { getSupabaseClient, logOut } from "@/lib/supabase";
import { getElectoralLocation } from "@/lib/constants";

import type { Ward, PollingUnit } from "@/data/electoral";
import type { Permission } from "@/types";

type NavLeaf = {
  name: string;
  href: string;
  icon: React.ComponentType<{ className?: string }>;

  socialOnly?: boolean;
  campaignOnly?: boolean;

  permission?: Permission;
  adminOnly?: boolean;

  /** Governance staff surfaces (view/manage/assign cases). */
  governanceStaff?: boolean;
  /** Governance participant surfaces (my requests, submit). */
  governanceParticipant?: boolean;
  /** Governance admin surfaces (category administration). */
  governanceAdminOnly?: boolean;
};

type NavChild = {
  name: string;
  href: string;
  icon: React.ComponentType<{ className?: string }>;

  adminOnly?: boolean;
  officerOnly?: boolean;
  electionReporting?: boolean;
  electionModeRequired?: boolean;
};

type NavGroup = {
  name: string;
  icon: React.ComponentType<{ className?: string }>;
  group: "campaign" | "election" | "governance";
  children: NavLeaf[];
};

type ElectionGroup = {
  name: string;
  icon: React.ComponentType<{ className?: string }>;
  group: "election";
  children: NavChild[];
};

type NavItem = NavLeaf | NavGroup | ElectionGroup;

type ElectoralLocation = {
  ward: Ward | null;
  pollingUnit: PollingUnit | null;
};

const navigation: NavItem[] = [
  {
    name: "Governance",
    icon: Landmark,
    group: "governance" as const,
    children: [
      {
        name: "Overview",
        href: "/portal/governance",
        icon: Landmark,
      },
      {
        name: "Projects",
        href: "/portal/governance/projects",
        icon: FolderKanban,
      },
      {
        name: "Participation",
        href: "/portal/governance/participation",
        icon: MessageSquareText,
        governanceStaff: true,
      },
      {
        name: "Engagements",
        href: "/portal/governance/engagements",
        icon: UsersRound,
        governanceStaff: true,
      },
      {
        name: "Analytics",
        href: "/portal/governance/analytics",
        icon: BarChart3,
        governanceStaff: true,
      },
      {
        name: "Open Instruments",
        href: "/portal/governance/participate",
        icon: Vote,
        governanceParticipant: true,
      },
      {
        name: "My Requests",
        href: "/portal/governance/requests",
        icon: FileText,
        governanceParticipant: true,
      },
      {
        name: "Submit a Request",
        href: "/portal/governance/requests/new",
        icon: Flag,
        governanceParticipant: true,
      },
      {
        name: "Case Queue",
        href: "/portal/governance/cases",
        icon: Inbox,
        governanceStaff: true,
      },
      {
        name: "Categories",
        href: "/portal/governance/categories",
        icon: Settings,
        governanceAdminOnly: true,
      },
    ],
  },

  {
    name: "Dashboard",
    href: "/portal/dashboard",
    icon: LayoutDashboard,
  },

  {
    name: "Profile",
    href: "/portal/profile",
    icon: Users,
  },

  {
    name: "Tasks",
    href: "/portal/tasks",
    icon: CheckSquare,
  },

  {
    name: "Announcements",
    href: "/portal/announcements",
    icon: Megaphone,
  },

  {
    name: "My Points",
    href: "/portal/points",
    icon: Star,
    socialOnly: true,
  },

  {
    name: "Leaderboard",
    href: "/portal/leaderboard",
    icon: TrendingUp,
    socialOnly: true,
  },

  {
    name: "Campaign Council",
    icon: BriefcaseBusiness,
    group: "campaign",

    children: [
      {
        name: "Campaign Dashboard",
        href: "/portal/dashboard",
        icon: LayoutDashboard,
        permission: "view_dashboard",
      },

      {
        name: "My Area",
        href: "/portal/campaign/area",
        icon: Network,
        permission: "view_area",
      },

      {
        name: "Members",
        href: "/portal/campaign/members",
        icon: Users,
        permission: "view_members",
      },

      {
        name: "Assignments",
        href: "/portal/campaign/assignments",
        icon: CheckSquare,
        permission: "view_assignments",
      },

      {
        name: "Activities",
        href: "/portal/campaign/activities",
        icon: CalendarDays,
        permission: "view_activities",
      },

      {
        name: "Reports",
        href: "/portal/campaign/reports",
        icon: FileText,
        permission: "submit_field_report",
      },

      {
        name: "Issues",
        href: "/portal/campaign/issues",
        icon: AlertTriangle,
        permission: "report_issue",
      },
    ],
  },

  {
    name: "Election Operations",
    icon: Vote,
    group: "election",

    children: [
      {
        name: "Election Dashboard",
        href: "/portal/election",
        icon: LayoutDashboard,
        adminOnly: false,
        electionModeRequired: true,
      },

      {
        name: "Officer Operations Desk",
        href: "/portal/election/operations",
        icon: CheckSquare,
        officerOnly: true,
        electionModeRequired: true,
      },

      {
        name: "PU Reports",
        href: "/portal/election/pu-reports",
        icon: FileText,
        electionReporting: true,
        electionModeRequired: true,
      },

      {
        name: "Incidents",
        href: "/portal/election/incidents",
        icon: AlertTriangle,
        electionReporting: true,
        electionModeRequired: true,
      },

      {
        name: "Result Upload",
        href: "/portal/election/upload",
        icon: Upload,
        electionReporting: true,
        electionModeRequired: true,
      },
    ],
  },
];

const adminNavigation = [
  {
    name: "Control Center",
    href: "/portal/control-center",
    icon: Settings,
  },

  {
    name: "Admin Dashboard",
    href: "/portal/admin",
    icon: LayoutDashboard,
  },

  {
    name: "Members",
    href: "/portal/admin/members",
    icon: Users,
  },

  {
    name: "Task Manager",
    href: "/portal/admin/tasks",
    icon: CheckSquare,
  },

  {
    name: "Donations",
    href: "/portal/admin/donations",
    icon: BarChart3,
  },

  {
    name: "Events",
    href: "/portal/admin/events",
    icon: CalendarDays,
  },

  {
    name: "News",
    href: "/portal/admin/news",
    icon: Newspaper,
  },

  {
    name: "Manifesto",
    href: "/portal/admin/manifesto",
    icon: FileText,
  },
  {
    name: "Gallery",
    href: "/portal/admin/gallery",
    icon: Image,
  },

  {
    name: "Announcements",
    href: "/portal/admin/announcements",
    icon: Megaphone,
  },

  {
    name: "Reports",
    href: "/portal/admin/reports",
    icon: BarChart3,
  },

  {
    name: "Audit Logs",
    href: "/portal/admin/audit-logs",
    icon: ShieldCheck,
  },

  {
    name: "System Health",
    href: "/portal/admin/health",
    icon: Settings,
  },

  {
    name: "Coordination",
    href: "/portal/campaign/coordination",
    icon: UsersRound,
  },

  {
    name: "Settings",
    href: "/portal/admin/settings",
    icon: Settings,
  },
];

export default function PortalLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  const [sidebarOpen, setSidebarOpen] = useState(false);
  const [loggingOut, setLoggingOut] = useState(false);
  const [logoutError, setLogoutError] = useState<string | null>(null);

  const pathname = usePathname();
  const router = useRouter();

  const {
    user,
    profile,
    loading,
    accessLoading,
    hasPermission,
    isCampaignMember,
  } = useAuth();

  // Governance access (module gate + staff authority) — resolved from the
  // database per §3/§13; every Governance route re-derives its own guard
  // server-side, so this state drives presentation only.
  const [govAccess, setGovAccess] = useState<
    Awaited<ReturnType<typeof resolveGovernanceAccess>> | null
  >(null);
  useEffect(() => {
    if (loading || accessLoading || !user) return;
    let cancelled = false;
    void (async () => {
      try {
        const access = await resolveGovernanceAccess();
        if (!cancelled) setGovAccess(access);
      } catch {
        if (!cancelled) setGovAccess(null);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [loading, accessLoading, user]);

  const governanceEnabled = Boolean(govAccess?.moduleEnabled);

  const role = profile?.access_role ?? null;

  const isAdmin =
    role === "admin" ||
    role === "tenant_super_admin" ||
    role === "platform_super_admin";

  const isElectionOfficer = role === "election_officer";

  const isSocialMember =
    profile?.membership_types?.includes("social_member") ?? false;

  const canReportElectionActivity =
    role === "member" || role === "election_officer" || role === "admin";

  const canViewElectionDashboard = isAdmin;

  const electionMode = true;

  const [campaignOpen, setCampaignOpen] = useState(() =>
    pathname.startsWith("/portal/campaign"),
  );

  const [electionOpen, setElectionOpen] = useState(() =>
    pathname.startsWith("/portal/election"),
  );

  const [adminOpen, setAdminOpen] = useState(() =>
    pathname.startsWith("/portal/admin"),
  );

  const [govOpen, setGovOpen] = useState(() =>
    pathname.startsWith("/portal/governance"),
  );

  const [previousPathname, setPreviousPathname] = useState(pathname);

  if (pathname !== previousPathname) {
    setPreviousPathname(pathname);

    setGovOpen(pathname.startsWith("/portal/governance"));

    setCampaignOpen(pathname.startsWith("/portal/campaign"));

    setElectionOpen(pathname.startsWith("/portal/election"));

    setAdminOpen(pathname.startsWith("/portal/admin"));
  }

  const electoralLocation: ElectoralLocation | null =
    profile?.ward_id && profile?.polling_unit_id
      ? getElectoralLocation(profile.ward_id, profile.polling_unit_id)
      : null;

  const handleLogout = async () => {
    if (loggingOut) return;

    setLogoutError(null);
    setLoggingOut(true);

    const logoutError = await logOut(getSupabaseClient());

    if (logoutError) {
      console.error("Logout failed:", logoutError);

      setLogoutError("Unable to sign out. Please try again.");

      setLoggingOut(false);

      return;
    }

    router.replace("/login");
  };

  useEffect(() => {
    if (!loading && !user) {
      router.replace("/login");
    }
  }, [loading, user, router]);

  if (loading || !user) {
    return (
      <div className="flex min-h-screen items-center justify-center bg-gray-50">
        <div className="text-center">
          <div className="mx-auto mb-4 h-10 w-10 animate-spin rounded-full border-4 border-brand-primary/20 border-t-brand-primary" />

          <p className="text-sm text-gray-500">
            {loading ? "Loading your portal..." : "Redirecting to login..."}
          </p>
        </div>
      </div>
    );
  }

  const showCampaignCouncil = isCampaignMember || isAdmin;

  const renderNav = () => (
    <>
      {navigation.map((item) => {
        if ("group" in item && item.group === "campaign") {
          if (!showCampaignCouncil) {
            return null;
          }

          const visibleChildren = item.children.filter((child) => {
            if (child.href === "/portal/dashboard") {
              return true;
            }

            // All campaign council nav options are visible for campaign members & admins
            if (isCampaignMember || isAdmin) {
              return true;
            }

            if (!child.permission) {
              return true;
            }

            return hasPermission(child.permission);
          });

          if (visibleChildren.length === 0) {
            return null;
          }

          return (
            <div key={item.name} className="mt-2">
              <button
                type="button"
                onClick={() => setCampaignOpen((open) => !open)}
                className={cn(
                  "flex w-full items-center rounded-lg px-3 py-2 text-sm font-medium transition-colors",

                  pathname.startsWith("/portal/campaign")
                    ? "bg-brand-primary/10 text-brand-primary"
                    : "text-gray-700 hover:bg-gray-100",
                )}
              >
                <item.icon className="mr-3 h-5 w-5" />

                <span>{item.name}</span>

                <ChevronDown
                  className={cn(
                    "ml-auto h-4 w-4 transition-transform",
                    campaignOpen && "rotate-180",
                  )}
                />
              </button>

              {campaignOpen && (
                <div className="ml-4 mt-1 space-y-1 border-l border-gray-200 pl-2">
                  {visibleChildren.map((child) => {
                    const active =
                      pathname === child.href ||
                      pathname.startsWith(`${child.href}/`);

                    const isCampaignDashboard =
                      child.href === "/portal/dashboard";

                    const dashboardActive =
                      isCampaignDashboard && pathname === "/portal/dashboard";

                    const finalActive = isCampaignDashboard
                      ? dashboardActive
                      : active;

                    return (
                      <Link
                        key={child.name}
                        href={child.href}
                        onClick={() => setSidebarOpen(false)}
                        className={cn(
                          "flex items-center rounded-lg px-3 py-2 text-sm transition-colors",

                          finalActive
                            ? "bg-brand-primary/10 font-medium text-brand-primary"
                            : "text-gray-600 hover:bg-gray-50",
                        )}
                      >
                        <child.icon className="mr-3 h-4 w-4 shrink-0" />

                        {child.name}
                      </Link>
                    );
                  })}
                </div>
              )}
            </div>
          );
        }

        if ("group" in item && item.group === "governance") {
          // Governance is an independent peer module: navigation requires
          // module_enabled('governance') AND the view_governance surface
          // permission — never Campaign/Election state.
          if (!governanceEnabled || !govAccess?.canViewGovernance) {
            return null;
          }

          const visibleChildren = item.children.filter((child) => {
            if (child.governanceStaff) {
              return govAccess.isStaff;
            }
            if (child.governanceParticipant) {
              return govAccess.isParticipant;
            }
            if (child.governanceAdminOnly) {
              return govAccess.isAdmin;
            }
            return true;
          });

          if (visibleChildren.length === 0) {
            return null;
          }

          return (
            <div key={item.name} className="mt-2">
              <button
                type="button"
                onClick={() => setGovOpen((open) => !open)}
                className={cn(
                  "flex w-full items-center rounded-lg px-3 py-2 text-sm font-medium transition-colors",

                  pathname.startsWith("/portal/governance")
                    ? "bg-brand-primary/10 text-brand-primary"
                    : "text-gray-700 hover:bg-gray-100",
                )}
              >
                <item.icon className="mr-3 h-5 w-5" />

                <span>{item.name}</span>

                <ChevronDown
                  className={cn(
                    "ml-auto h-4 w-4 transition-transform",
                    govOpen && "rotate-180",
                  )}
                />
              </button>

              {govOpen && (
                <div className="ml-4 mt-1 space-y-1 border-l border-gray-200 pl-2">
                  {visibleChildren.map((child) => {
                    const active =
                      pathname === child.href ||
                      pathname.startsWith(`${child.href}/`);

                    return (
                      <Link
                        key={child.name}
                        href={child.href}
                        onClick={() => setSidebarOpen(false)}
                        className={cn(
                          "flex items-center rounded-lg px-3 py-2 text-sm transition-colors",

                          active
                            ? "bg-brand-primary/10 font-medium text-brand-primary"
                            : "text-gray-600 hover:bg-gray-50",
                        )}
                      >
                        <child.icon className="mr-3 h-4 w-4" />

                        {child.name}
                      </Link>
                    );
                  })}
                </div>
              )}
            </div>
          );
        }

        if ("group" in item && item.group === "election") {
          // Strictly block social-only members from seeing Election Operations
          if (!isCampaignMember && !isAdmin && !isElectionOfficer) {
            return null;
          }

          const visibleChildren = item.children.filter((child) => {
            if (child.href === "/portal/election") {
              return isCampaignMember || isAdmin || isElectionOfficer;
            }

            // Admins use /portal/election for corrections; the operations desk is officer-only per spec §27.
            if (child.href === "/portal/election/operations") {
              return role === "election_officer";
            }

            if ("electionReporting" in child && child.electionReporting) {
              return canReportElectionActivity;
            }

            return false;
          });

          if (visibleChildren.length === 0) {
            return null;
          }

          return (
            <div key={item.name} className="mt-2">
              <button
                type="button"
                onClick={() => setElectionOpen((open) => !open)}
                className={cn(
                  "flex w-full items-center rounded-lg px-3 py-2 text-sm font-medium transition-colors",

                  pathname.startsWith("/portal/election")
                    ? "bg-brand-primary/10 text-brand-primary"
                    : "text-gray-700 hover:bg-gray-100",
                )}
              >
                <item.icon className="mr-3 h-5 w-5" />

                <span>{item.name}</span>

                {!electionMode && (
                  <span className="ml-auto mr-2 text-[10px] font-semibold uppercase tracking-wide text-gray-400">
                    Off
                  </span>
                )}

                <ChevronDown
                  className={cn(
                    "h-4 w-4 transition-transform",
                    electionOpen && "rotate-180",
                    !electionMode && "text-gray-400",
                  )}
                />
              </button>

              {electionOpen && (
                <div className="ml-4 mt-1 space-y-1 border-l border-gray-200 pl-2">
                  {visibleChildren.map((child) => {
                    const disabled =
                      "electionModeRequired" in child &&
                      child.electionModeRequired &&
                      !electionMode;

                    const active =
                      pathname === child.href ||
                      pathname.startsWith(`${child.href}/`);

                    if (disabled) {
                      return (
                        <div
                          key={child.name}
                          aria-disabled="true"
                          title="Election Mode is currently off"
                          className="flex cursor-not-allowed select-none items-center rounded-lg px-3 py-2 text-sm text-gray-400"
                        >
                          <child.icon className="mr-3 h-4 w-4 shrink-0" />

                          <span>{child.name}</span>

                          <span className="ml-auto text-[9px] font-semibold uppercase tracking-wide text-gray-400">
                            Off
                          </span>
                        </div>
                      );
                    }

                    return (
                      <Link
                        key={child.name}
                        href={child.href}
                        onClick={() => setSidebarOpen(false)}
                        className={cn(
                          "flex items-center rounded-lg px-3 py-2 text-sm transition-colors",

                          active
                            ? "bg-brand-primary/10 font-medium text-brand-primary"
                            : "text-gray-600 hover:bg-gray-50",
                        )}
                      >
                        <child.icon className="mr-3 h-4 w-4" />

                        {child.name}
                      </Link>
                    );
                  })}
                </div>
              )}
            </div>
          );
        }

        if ("socialOnly" in item && item.socialOnly && !isSocialMember) {
          return null;
        }

        if (
          "campaignOnly" in item &&
          item.campaignOnly &&
          !showCampaignCouncil
        ) {
          return null;
        }

        if ("children" in item) {
          return null;
        }

        const active =
          pathname === item.href || pathname.startsWith(`${item.href}/`);

        return (
          <Link
            key={item.name}
            href={item.href}
            onClick={() => setSidebarOpen(false)}
            className={cn(
              "flex items-center rounded-lg px-3 py-2 text-sm font-medium transition-colors",

              active
                ? "bg-brand-primary/10 text-brand-primary"
                : "text-gray-700 hover:bg-gray-100",
            )}
          >
            <item.icon className="mr-3 h-5 w-5" />

            {item.name}
          </Link>
        );
      })}

      {isAdmin && (
        <div className="mt-4 border-t pt-4">
          <button
            type="button"
            onClick={() => setAdminOpen((open) => !open)}
            className={cn(
              "flex w-full items-center rounded-lg px-3 py-2 text-xs font-semibold uppercase tracking-wider transition-colors",

              pathname.startsWith("/portal/admin")
                ? "bg-brand-primary/5 text-brand-primary"
                : "text-gray-400 hover:bg-gray-50 hover:text-gray-600",
            )}
          >
            <span>Administration</span>

            <ChevronDown
              className={cn(
                "ml-auto h-4 w-4 transition-transform",
                adminOpen && "rotate-180",
              )}
            />
          </button>

          {adminOpen && (
            <div className="mt-2 space-y-1">
              {adminNavigation.map((item) => {
                const active =
                  pathname === item.href ||
                  pathname.startsWith(`${item.href}/`);

                return (
                  <Link
                    key={item.name}
                    href={item.href}
                    onClick={() => setSidebarOpen(false)}
                    className={cn(
                      "flex items-center rounded-lg px-3 py-2 text-sm font-medium transition-colors",

                      active
                        ? "bg-brand-primary/10 text-brand-primary"
                        : "text-gray-700 hover:bg-gray-100",
                    )}
                  >
                    <item.icon className="mr-3 h-5 w-5" />

                    {item.name}
                  </Link>
                );
              })}
            </div>
          )}
        </div>
      )}
    </>
  );

  const userName =
    profile?.full_name || user?.email || "Portal Member";

  const membershipLabels: string[] = [];

  if (isSocialMember) {
    membershipLabels.push("Social Member");
  }

  if (showCampaignCouncil) {
    membershipLabels.push("Campaign Member");
  }

  const membershipLabel =
    membershipLabels.length > 0 ? membershipLabels.join(" • ") : "Member";

  const roleLabel = isAdmin
    ? "Administrator"
    : isElectionOfficer
      ? "Election Officer"
      : membershipLabel;

  return (
    <div className="min-h-screen bg-gray-50">
      {/* Mobile Navigation Drawer */}
      <div
        className={cn(
          "fixed inset-0 z-50 lg:hidden",
          sidebarOpen ? "visible" : "invisible pointer-events-none",
        )}
        aria-hidden={!sidebarOpen}
      >
        <div
          className={cn(
            "absolute inset-0 bg-black/50 transition-opacity duration-200",
            sidebarOpen ? "opacity-100" : "opacity-0",
          )}
          onClick={() => setSidebarOpen(false)}
        />

        <aside
          className={cn(
            "absolute inset-y-0 left-0 flex w-72 flex-col bg-white shadow-2xl",
            "transition-transform duration-200 ease-out",
            sidebarOpen ? "translate-x-0" : "-translate-x-full",
          )}
          aria-label="Mobile navigation"
        >
          {/* Mobile Brand Header */}
          <div className="flex h-20 shrink-0 items-center justify-between border-b pl-0 pr-5">
            <Link
              href="/"
              onClick={() => setSidebarOpen(false)}
              className="flex min-w-0 items-center gap-1"
            >
              <NextImage
                src="/images/politicore-logo-raw.png"
                alt="PolitiCore Logo"
                width={160}
                height={64}
                priority
                className="h-16 w-auto shrink-0 object-contain"
              />

              <div className="flex flex-col leading-none">
                <span className="text-lg font-bold tracking-tight">
                  <span className="text-[#1A365D]">Politi</span>
                  <span className="text-[#27AE60]">Core</span>
                </span>

                
              </div>
            </Link>

            <button
              type="button"
              onClick={() => setSidebarOpen(false)}
              className="ml-2 rounded-lg p-2 text-gray-600 transition-colors hover:bg-gray-100 hover:text-gray-900"
              aria-label="Close navigation"
            >
              <X className="h-5 w-5" />
            </button>
          </div>

          {/* Mobile Navigation */}
          <nav className="min-h-0 flex-1 overflow-y-auto px-4 py-5">
            <div className="space-y-1">{renderNav()}</div>
          </nav>

          {/* Mobile User Panel */}
          <div className="shrink-0 border-t bg-white p-4">
            <UserPanel
              userName={userName}
              roleLabel={roleLabel}
              profile={profile}
              electoralLocation={electoralLocation}
              onLogout={handleLogout}
              loggingOut={loggingOut}
              logoutError={logoutError}
            />
          </div>
        </aside>
      </div>

      {/* Desktop Sidebar */}
      <aside className="fixed inset-y-0 left-0 z-40 hidden w-72 lg:flex">
        <div className="flex h-full min-h-0 w-full flex-col overflow-hidden border-r bg-white">
          {/* Desktop Brand Header */}
          <div className="flex h-20 shrink-0 items-center border-b pl-0 pr-5">
            <Link href="/" className="flex min-w-0 items-center gap-0">
              <NextImage
                src="/images/politicore-logo-raw.png"
                alt="PolitiCore Logo"
                width={160}
                height={64}
                priority
                className="h-16 w-auto shrink-0 object-contain"
              />

              <div className="flex flex-col leading-none">
                <span className="text-lg font-bold tracking-tight">
                  <span className="text-[#1A365D]">Politi</span>
                  <span className="text-[#27AE60]">Core</span>
                </span>

                <span className="mt-1 text-[9px] font-medium italic text-[#1A365D]">
                  Secure Political Intelligence
                </span>
              </div>
            </Link>
          </div>

          {/* Desktop Navigation */}
          <nav className="min-h-0 flex-1 overflow-y-auto px-4 py-5">
            <div className="space-y-1">{renderNav()}</div>
          </nav>

          {/* Desktop User Panel */}
          <div className="shrink-0 border-t bg-white p-4">
            <UserPanel
              userName={userName}
              roleLabel={roleLabel}
              profile={profile}
              electoralLocation={electoralLocation}
              onLogout={handleLogout}
              loggingOut={loggingOut}
              logoutError={logoutError}
            />
          </div>
        </div>
      </aside>

      {/* Main Application Area */}
      <div className="lg:pl-72">
        {/* Mobile Header */}
        <header className="sticky top-0 z-30 border-b bg-white lg:hidden">
          <div className="flex h-20 items-center justify-between pl-0 pr-4">
            <Link href="/" className="flex min-w-0 items-center gap-2">
              <NextImage
                src="/images/politicore-logo-raw.png"
                alt="PolitiCore Logo"
                width={160}
                height={64}
                priority
                className="h-16 w-auto shrink-0 object-contain"
              />

              <div className="flex flex-col leading-none">
                <span className="text-lg font-bold tracking-tight">
                  <span className="text-[#1A365D]">Politi</span>
                  <span className="text-[#27AE60]">Core</span>
                </span>
                <span className="mt-1 text-[9px] font-medium italic text-[#1A365D]">
                  Secure Political Intelligence
                </span>
              </div>
            </Link>

            <button
              type="button"
              onClick={() => setSidebarOpen(true)}
              className="rounded-lg p-2 text-gray-600 transition-colors hover:bg-gray-100 hover:text-gray-900"
              aria-label="Open navigation"
            >
              <Menu className="h-6 w-6" />
            </button>
          </div>
        </header>

        {/* Search and Notifications */}
        <div className="flex items-center justify-between gap-4 px-4 pt-4 sm:px-6 lg:px-8">
          <div className="min-w-0 flex-1">
            <GlobalSearchModal />
          </div>

          <div className="shrink-0">
            <NotificationCenter profile={profile} />
          </div>
        </div>

        {/* Contextual Help */}
        <ContextualHelp />

        {/* Page Content */}
        <main className="p-4 sm:p-6 lg:p-8">{children}</main>
      </div>
    </div>
  );
}

function NotificationCenter({ profile }: { profile: UserProfile | null }) {
  /*
   * Shared Notifications Cutover: the bell is served by the canonical
   * Supabase notification system (politicore.notifications via RLS —
   * strictly per-user rows; read state via the 0007/0008 RPCs).
   * Announcements remain on the legacy store until the portal-content
   * phase (no canonical Supabase announcements model exists yet; §12
   * forbids inventing one here) — the section renders empty until then.
   */
  const [notifications, setNotifications] = useState<NotificationItem[]>([]);
  const [open, setOpen] = useState(false);

  useEffect(() => {
    if (!profile) return;
    const unsubscribe = subscribeMyNotifications((rows) => {
      setNotifications(
        rows.map((n) => ({
          id: n.id,
          tenant_id: n.tenant_id,
          // The canonical store's type vocabulary (0001 CHECK) is its own;
          // the legacy UI type vocabulary is presentation-only.
          type: n.type as unknown as NotificationItem["type"],
          title: n.title,
          message: n.message,
          link_url: n.link_url,
          target_type: "user" as const,
          target_id: n.user_id,
          read_by: n.read_at ? [n.user_id] : [],
          created_at: n.created_at,
        })),
      );
    });
    return () => unsubscribe();
  }, [profile]);

  if (!profile) return null;

  const viewerId = profile.id ?? "";

  const unreadCount = notifications.filter(
    (n) => !n.read_by.includes(viewerId),
  ).length;

  return (
    <div className="relative">
      <button
        type="button"
        onClick={() => setOpen((prev) => !prev)}
        className="relative p-2 text-gray-600 hover:text-brand-primary rounded-full hover:bg-gray-100 transition-colors"
        aria-label="Notifications"
      >
        <Bell className="h-5 w-5" />
        {unreadCount > 0 && (
          <span className="absolute top-1 right-1 flex h-4 w-4 items-center justify-center rounded-full bg-red-600 text-[10px] font-bold text-white">
            {unreadCount > 9 ? "9+" : unreadCount}
          </span>
        )}
      </button>

      {open && (
        <div className="absolute right-0 mt-2 w-80 sm:w-96 rounded-2xl bg-white shadow-xl border border-gray-200 z-50 overflow-hidden animate-in fade-in zoom-in-95 duration-150">
          <div className="flex items-center justify-between p-4 border-b bg-gray-50">
            <div className="flex items-center gap-2">
              <Bell className="h-4 w-4 text-brand-primary" />
              <span className="font-bold text-sm text-gray-900">
                Notifications
              </span>
              {unreadCount > 0 && (
                <span className="bg-brand-primary/10 text-brand-primary text-xs font-semibold px-2 py-0.5 rounded-full">
                  {unreadCount} unread
                </span>
              )}
            </div>

            {unreadCount > 0 && (
              <button
                onClick={() =>
                  void markAllRead().then(() =>
                    setNotifications((prev) =>
                      prev.map((row) => ({
                        ...row,
                        read_by: row.read_by.length ? row.read_by : [viewerId],
                      })),
                    ),
                  )
                }
                className="text-xs text-brand-primary hover:underline font-semibold flex items-center gap-1"
              >
                <Check className="h-3 w-3" /> Mark all read
              </button>
            )}
          </div>

          <div className="max-h-80 overflow-y-auto divide-y text-xs">
            {notifications.length === 0 ? (
              <p className="p-6 text-center text-gray-400">
                No notifications yet.
              </p>
            ) : (
              <>
                {notifications.map((n) => {
                  const isUnread = n.read_by.length === 0;
                  return (
                    <div
                      key={n.id}
                      onClick={() => {
                        if (isUnread)
                          void markNotificationsRead([n.id]).then(() =>
                            setNotifications((prev) =>
                              prev.map((row) =>
                                row.id === n.id
                                  ? { ...row, read_by: [viewerId] }
                                  : row,
                              ),
                            ),
                          );
                      }}
                      className={cn(
                        "p-3.5 transition-colors cursor-pointer flex items-start gap-3",
                        isUnread
                          ? "bg-brand-primary/5 hover:bg-brand-primary/10"
                          : "hover:bg-gray-50",
                      )}
                    >
                      <div className="min-w-0 flex-1 space-y-0.5">
                        <div className="flex items-center justify-between">
                          <span className="font-bold text-gray-900">
                            {n.title}
                          </span>
                          {isUnread && (
                            <span className="h-2 w-2 rounded-full bg-brand-primary" />
                          )}
                        </div>
                        <p className="text-gray-600 leading-relaxed">
                          {n.message}
                        </p>
                        {n.link_url && (
                          <a
                            href={n.link_url}
                            className="inline-block text-brand-primary font-semibold hover:underline pt-1"
                          >
                            View Details &rarr;
                          </a>
                        )}
                      </div>
                    </div>
                  );
                })}
              </>
            )}
          </div>
        </div>
      )}
    </div>
  );
}

function UserPanel({
  userName,
  roleLabel,
  profile,
  electoralLocation,
  onLogout,
  loggingOut,
  logoutError,
}: {
  userName: string;
  roleLabel: string;
  profile: UserProfile | null;
  electoralLocation: ElectoralLocation | null;
  onLogout: () => void;
  loggingOut: boolean;
  logoutError: string | null;
}) {
  return (
    <div>
      <div className="mb-3 flex items-center gap-3">
        <div className="flex h-9 w-9 shrink-0 items-center justify-center rounded-full bg-brand-primary">
          <span className="text-sm font-semibold text-white">
            {userName.charAt(0).toUpperCase()}
          </span>
        </div>

        <div className="min-w-0">
          <p className="truncate text-sm font-semibold text-gray-900">
            {userName}
          </p>

          <p className="text-xs text-gray-500">{roleLabel}</p>
        </div>
      </div>

      {electoralLocation &&
        (electoralLocation.ward || electoralLocation.pollingUnit) && (
          <div className="mb-3 space-y-2 rounded-lg bg-gray-50 p-3">
            {electoralLocation.ward && (
              <div className="flex items-start gap-2">
                <MapPin className="mt-0.5 h-4 w-4 shrink-0 text-brand-primary" />

                <div className="min-w-0">
                  <p className="text-[10px] font-semibold uppercase tracking-wide text-gray-400">
                    Ward
                  </p>

                  <p className="truncate text-xs font-medium text-gray-700">
                    {electoralLocation.ward.name}
                  </p>
                </div>
              </div>
            )}

            {electoralLocation.pollingUnit && (
              <div className="flex items-start gap-2">
                <Map className="mt-0.5 h-4 w-4 shrink-0 text-brand-primary" />

                <div className="min-w-0">
                  <p className="text-[10px] font-semibold uppercase tracking-wide text-gray-400">
                    Polling Unit
                  </p>

                  <p className="truncate text-xs font-medium text-gray-700">
                    {electoralLocation.pollingUnit.name}
                  </p>
                </div>
              </div>
            )}
          </div>
        )}

      {logoutError && (
        <p className="mb-2 text-xs text-red-600" role="alert">
          {logoutError}
        </p>
      )}

      <button
        type="button"
        onClick={onLogout}
        disabled={loggingOut}
        className="flex w-full items-center justify-center gap-2 rounded-lg border border-red-100 bg-red-50 px-3 py-2.5 text-sm font-medium text-red-600 transition-colors hover:bg-red-100 disabled:opacity-50"
      >
        <LogOut className="h-4 w-4" />

        {loggingOut ? "Signing out..." : "Sign Out"}
      </button>
    </div>
  );
}
