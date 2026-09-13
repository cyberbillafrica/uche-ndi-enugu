"use client";

import { useState, useEffect } from "react";
import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";
import { getUserAnnouncements } from "@/lib/firebase/firestore";

import {
  LayoutDashboard,
  Users,
  UsersRound,
  CheckSquare,
  TrendingUp,
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
} from "lucide-react";

import { cn } from "@/lib/utils";
import { useAuth } from "@/contexts/AuthContext";
import { logOut } from "@/lib/firebase/auth";
import { getElectoralLocation } from "@/lib/constants";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog";

import type { Ward, PollingUnit } from "@/data/electoral";
import type { Permission, Announcement } from "@/types";

type NavLeaf = {
  name: string;
  href: string;
  icon: React.ComponentType<{ className?: string }>;

  socialOnly?: boolean;
  campaignOnly?: boolean;

  permission?: Permission;
  adminOnly?: boolean;
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
  group: "campaign" | "election";
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
    name: "Broadcast",
    href: "/portal/admin/announcements",
    icon: Megaphone,
  },

  {
    name: "Reports",
    href: "/portal/admin/reports",
    icon: BarChart3,
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

  const [previousPathname, setPreviousPathname] = useState(pathname);

  if (pathname !== previousPathname) {
    setPreviousPathname(pathname);

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

    const { error } = await logOut();

    if (error) {
      console.error("Logout failed:", error);

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
          <div className="mx-auto mb-4 h-10 w-10 animate-spin rounded-full border-4 border-apc-primary/20 border-t-apc-primary" />

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
                    ? "bg-apc-primary/10 text-apc-primary"
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
                            ? "bg-apc-primary/10 font-medium text-apc-primary"
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
                    ? "bg-apc-primary/10 text-apc-primary"
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
                            ? "bg-apc-primary/10 font-medium text-apc-primary"
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
                ? "bg-apc-primary/10 text-apc-primary"
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
                ? "bg-apc-primary/5 text-apc-primary"
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
                        ? "bg-apc-primary/10 text-apc-primary"
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
    profile?.full_name || user?.displayName || user?.email || "Portal Member";

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
      {/* Mobile Sidebar */}

      <div
        className={cn(
          "fixed inset-0 z-50 lg:hidden",
          sidebarOpen ? "block" : "hidden",
        )}
      >
        <div
          className="fixed inset-0 bg-black/50"
          onClick={() => setSidebarOpen(false)}
        />

        <div className="fixed inset-y-0 left-0 flex w-72 flex-col overflow-hidden bg-white shadow-xl">
          <div className="flex h-16 shrink-0 items-center justify-between border-b px-6">
            <Link
              href="/"
              className="flex items-center space-x-2"
              onClick={() => setSidebarOpen(false)}
            >
              {/* eslint-disable-next-line @next/next/no-img-element */}
              <img
                src="/images/logo.png"
                alt="PolitiCore Logo"
                className="h-8 w-auto object-contain"
              />

              <span className="text-lg font-bold text-apc-primary">
                PolitiCore
              </span>
            </Link>

            <button
              type="button"
              onClick={() => setSidebarOpen(false)}
              className="rounded-lg p-2 hover:bg-gray-100"
              aria-label="Close navigation"
            >
              <X className="h-5 w-5" />
            </button>
          </div>

          <nav className="min-h-0 flex-1 space-y-1 overflow-y-auto px-4 py-4">
            {renderNav()}
          </nav>

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
      </div>

      {/* Desktop Sidebar */}

      <div className="hidden lg:fixed lg:inset-y-0 lg:flex lg:w-72 lg:flex-col">
        <div className="flex h-full min-h-0 flex-col overflow-hidden border-r bg-white">
          <div className="flex h-16 shrink-0 items-center border-b px-6">
            <Link href="/" className="flex items-center space-x-2">
              {/* eslint-disable-next-line @next/next/no-img-element */}
              <img
                src="/images/logo.png"
                alt="PolitiCore Logo"
                className="h-8 w-auto object-contain"
              />

              <span className="text-lg font-bold text-apc-primary">
                PolitiCore
              </span>
            </Link>
          </div>

          <nav className="min-h-0 flex-1 space-y-1 overflow-y-auto px-4 py-4">
            {renderNav()}
          </nav>

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
      </div>

      {/* Main Content */}

      <div className="lg:pl-72">
        <div className="sticky top-0 z-40 border-b bg-white lg:hidden">
          <div className="flex h-16 items-center justify-between px-4">
            <Link href="/" className="flex items-center space-x-2">
              {/* eslint-disable-next-line @next/next/no-img-element */}
              <img
                src="/images/logo.png"
                alt="PolitiCore Logo"
                className="h-8 w-auto object-contain"
              />

              <span className="font-bold text-apc-primary">
                PolitiCore
              </span>
            </Link>

            <button
              type="button"
              onClick={() => setSidebarOpen(true)}
              className="rounded-lg p-2 hover:bg-gray-100"
              aria-label="Open navigation"
            >
              <Menu className="h-6 w-6" />
            </button>
          </div>
        </div>

        <main className="p-4 sm:p-6 lg:p-8">{children}</main>
      </div>
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
  profile: any;
  electoralLocation: ElectoralLocation | null;
  onLogout: () => void;
  loggingOut: boolean;
  logoutError: string | null;
}) {
  const [announcements, setAnnouncements] = useState<Announcement[]>([]);

  useEffect(() => {
    if (!profile) return;

    getUserAnnouncements(profile)
      .then(setAnnouncements)
      .catch((error) => {
        console.error("Failed to load announcements:", error);
        setAnnouncements([]);
      });
  }, [profile]);

  return (
    <div>
      <div className="mb-3 flex items-center gap-3">
        <div className="flex h-9 w-9 shrink-0 items-center justify-center rounded-full bg-apc-primary">
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
                <MapPin className="mt-0.5 h-4 w-4 shrink-0 text-apc-primary" />

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
                <Map className="mt-0.5 h-4 w-4 shrink-0 text-apc-primary" />

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

      {announcements.length > 0 && (
        <div className="mb-3 space-y-2 border-t border-gray-100 pt-3">
          <p className="text-xs font-semibold uppercase tracking-wide text-gray-400">
            Announcements
          </p>

          {announcements.slice(0, 2).map((announcement) => (
            <Dialog key={announcement.id}>
              <DialogTrigger className="w-full rounded-lg bg-apc-light/50 p-2 text-left transition-colors hover:bg-apc-light focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-apc-primary">
                <span className="block text-xs font-medium text-gray-800">
                  {announcement.title}
                </span>

                <span className="mt-1 block line-clamp-2 text-xs text-gray-600">
                  {announcement.content}
                </span>
              </DialogTrigger>

              <DialogContent className="max-h-[80vh] overflow-y-auto sm:max-w-lg">
                <DialogHeader>
                  <DialogTitle>{announcement.title}</DialogTitle>

                  <DialogDescription className="whitespace-pre-wrap leading-6">
                    {announcement.content}
                  </DialogDescription>
                </DialogHeader>
              </DialogContent>
            </Dialog>
          ))}
        </div>
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
