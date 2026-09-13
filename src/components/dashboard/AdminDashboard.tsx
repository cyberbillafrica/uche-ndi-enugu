"use client";

import Link from "next/link";

import {
  ArrowRight,
  Banknote,
  BarChart3,
  Bell,
  BriefcaseBusiness,
  CalendarDays,
  CheckSquare,
  FileText,
  Flag,
  Mail,
  Megaphone,
  Network,
  Settings,
  ShieldCheck,
  Target,
  TrendingUp,
  Upload,
  Users,
  Vote,
} from "lucide-react";

import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";

import { useAuth } from "@/contexts/AuthContext";

import {
  formatOrganizationalPosition,
  formatScopeType,
  getPrimaryOrganizationalScope,
} from "@/lib/organization";

export default function AdminDashboard() {
  const {
    profile,
    assignments,
    grants,
    isSocialMember,
    isCampaignMember,
    isCampaignCouncilMember,
    accessLoading,
  } = useAuth();

  if (!profile) {
    return null;
  }

  /*
   * ============================================================
   * ORGANIZATIONAL INFORMATION
   * ============================================================
   */

  const activeAssignments = assignments.filter(
    (assignment) => assignment.status === "active",
  );

  const primaryScope = getPrimaryOrganizationalScope(activeAssignments);

  const primaryAssignment = primaryScope.assignment;

  const organizationalPosition = primaryAssignment
    ? formatOrganizationalPosition(primaryAssignment.position)
    : "No campaign assignment";

  const organizationalScope = primaryAssignment
    ? `${formatScopeType(primaryAssignment.scope_type)} — ${primaryAssignment.scope_id}`
    : "Not assigned";

  /*
   * ============================================================
   * PERMISSION SUMMARY
   * ============================================================
   *
   * These are informational indicators.
   *
   * Firestore rules remain the actual security boundary.
   * ============================================================
   */

  const activeGrants = grants.filter((grant) => grant.granted === true);

  /*
   * ============================================================
   * DASHBOARD
   * ============================================================
   */

  return (
    <div className="space-y-6 pb-10">
      {/* ======================================================
          HEADER
          ====================================================== */}

      <section className="overflow-hidden rounded-2xl border bg-white shadow-sm">
        <div className="bg-apc-primary px-6 py-7 text-white sm:px-8">
          <div className="flex flex-col gap-5 lg:flex-row lg:items-center lg:justify-between">
            <div>
              <p className="text-sm font-semibold uppercase tracking-wide text-white/70">
                Administration
              </p>

              <h1 className="mt-1 text-2xl font-bold sm:text-3xl">
                Welcome back, {profile.full_name || "Administrator"}
              </h1>

              <p className="mt-2 max-w-2xl text-sm leading-6 text-white/80">
                Manage the campaign platform, members, campaign organization,
                social operations and election operations from one place.
              </p>
            </div>

            <div className="flex w-fit items-center gap-3 rounded-xl bg-white/10 px-4 py-3">
              <ShieldCheck className="h-6 w-6 shrink-0" />

              <div>
                <p className="text-xs text-white/70">Access Role</p>

                <p className="font-semibold">Administrator</p>
              </div>
            </div>
          </div>
        </div>

        {/* ====================================================
            ACCOUNT CAPABILITIES
            ==================================================== */}

        <div className="grid gap-px bg-gray-200 sm:grid-cols-3">
          <CapabilityItem label="Social Membership" active={isSocialMember} />

          <CapabilityItem
            label="Campaign Membership"
            active={isCampaignMember}
          />

          <CapabilityItem
            label="Campaign Council"
            active={isCampaignCouncilMember}
          />
        </div>
      </section>

      {/* ======================================================
          ADMINISTRATION
          ====================================================== */}

      <section>
        <SectionHeading
          title="Administration"
          description="Core administrative functions for running the platform."
        />

        <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
          <AdminCard
            icon={<Users className="h-5 w-5" />}
            title="Members"
            description="Manage campaign and social members, profiles and access."
            href="/portal/admin/members"
          />

          <AdminCard
            icon={<CheckSquare className="h-5 w-5" />}
            title="Tasks"
            description="Create social tasks and review member submissions."
            href="/portal/admin/tasks"
          />

          <AdminCard
            icon={<Megaphone className="h-5 w-5" />}
            title="Announcements"
            description="Manage campaign-wide announcements and communications."
            href="/portal/admin/announcements"
          />

          <AdminCard
            icon={<Mail className="h-5 w-5" />}
            title="Contact Messages"
            description="Review and respond to inquiries sent from the website contact page."
            href="/portal/admin/contact-messages"
          />

          <AdminCard
            icon={<FileText className="h-5 w-5" />}
            title="News"
            description="Manage campaign news and published updates."
            href="/portal/admin/news"
          />

          <AdminCard
            icon={<BarChart3 className="h-5 w-5" />}
            title="Reports"
            description="Review administrative and operational reports."
            href="/portal/admin/reports"
          />

          <AdminCard
            icon={<Banknote className="h-5 w-5" />}
            title="Donation Ledger"
            description="Private candidate donation, contribution audit trail, and analytics."
            href="/portal/admin/donations"
          />

          <AdminCard
            icon={<Settings className="h-5 w-5" />}
            title="Settings"
            description="Manage campaign and system configuration."
            href="/portal/admin/settings"
          />
        </div>
      </section>

      {/* ======================================================
          CAMPAIGN COUNCIL
          ====================================================== */}

      <section>
        <SectionHeading
          title="Campaign Council"
          description="Access the campaign organization and operational tools."
        />

        <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
          <AdminCard
            icon={<BriefcaseBusiness className="h-5 w-5" />}
            title="Campaign Dashboard"
            description="Open the campaign council dashboard and organizational overview."
            href="/portal/campaign"
          />

          <AdminCard
            icon={<Network className="h-5 w-5" />}
            title="Campaign Area"
            description="View organizational scope and area operations."
            href="/portal/campaign/area"
          />

          <AdminCard
            icon={<Users className="h-5 w-5" />}
            title="Campaign Members"
            description="View members within the campaign organizational scope."
            href="/portal/campaign/members"
          />

          <AdminCard
            icon={<CalendarDays className="h-5 w-5" />}
            title="Campaign Activities"
            description="View and manage campaign activities within the system."
            href="/portal/campaign/activities"
          />

          <AdminCard
            icon={<Target className="h-5 w-5" />}
            title="Campaign Assignments"
            description="Review and manage organizational assignments."
            href="/portal/campaign/assignments"
          />

          <AdminCard
            icon={<Flag className="h-5 w-5" />}
            title="Campaign Reports"
            description="Review campaign field reports."
            href="/portal/campaign/reports"
          />
        </div>
      </section>

      {/* ======================================================
          MY MEMBER FUNCTIONS
          ====================================================== */}

      {(isSocialMember || isCampaignMember) && (
        <section>
          <SectionHeading
            title="My Member Functions"
            description="Because an administrator may also participate as a campaign or social member."
          />

          <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
            {isSocialMember && (
              <>
                <AdminCard
                  icon={<CheckSquare className="h-5 w-5" />}
                  title="Social Tasks"
                  description="Participate in social media tasks assigned to members."
                  href="/portal/tasks"
                />

                <AdminCard
                  icon={<TrendingUp className="h-5 w-5" />}
                  title="Leaderboard"
                  description="View your social participation and leaderboard position."
                  href="/portal/leaderboard"
                />
              </>
            )}

            {isCampaignMember && (
              <AdminCard
                icon={<BriefcaseBusiness className="h-5 w-5" />}
                title="My Campaign Dashboard"
                description="Open your campaign member and organizational dashboard."
                href="/portal/campaign"
              />
            )}
          </div>
        </section>
      )}

      {/* ======================================================
          ELECTION OPERATIONS
          ====================================================== */}

      <section>
        <SectionHeading
          title="Election Operations"
          description="Election reporting and administrative monitoring."
        />

        <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
          <AdminCard
            icon={<Vote className="h-5 w-5" />}
            title="Election Dashboard"
            description="Open the election operations dashboard."
            href="/portal/election"
          />

          <AdminCard
            icon={<FileText className="h-5 w-5" />}
            title="PU Reports"
            description="Review polling-unit election reports."
            href="/portal/election/pu-reports"
          />

          <AdminCard
            icon={<Flag className="h-5 w-5" />}
            title="Incidents"
            description="Review reported election incidents."
            href="/portal/election/incidents"
          />

          <AdminCard
            icon={<Upload className="h-5 w-5" />}
            title="Result Upload"
            description="Access election result upload operations."
            href="/portal/election/upload"
          />
        </div>
      </section>

      {/* ======================================================
          ORGANIZATIONAL ACCESS
          ====================================================== */}

      <section>
        <Card>
          <CardHeader>
            <CardTitle className="flex items-center gap-2 text-lg">
              <ShieldCheck className="h-5 w-5 text-apc-primary" />
              Organizational Access
            </CardTitle>

            <p className="text-sm text-gray-500">
              Your current campaign organizational position and permission
              information.
            </p>
          </CardHeader>

          <CardContent>
            {accessLoading ? (
              <div className="grid gap-4 sm:grid-cols-3">
                <div className="h-20 animate-pulse rounded-xl bg-gray-100" />
                <div className="h-20 animate-pulse rounded-xl bg-gray-100" />
                <div className="h-20 animate-pulse rounded-xl bg-gray-100" />
              </div>
            ) : (
              <div className="grid gap-4 sm:grid-cols-3">
                <AccessInfo
                  label="Primary Position"
                  value={organizationalPosition}
                />

                <AccessInfo label="Primary Scope" value={organizationalScope} />

                <AccessInfo
                  label="Granted Permissions"
                  value={String(activeGrants.length)}
                />
              </div>
            )}
          </CardContent>
        </Card>
      </section>

      {/* ======================================================
          QUICK LINKS
          ====================================================== */}

      <section>
        <Card className="border-dashed">
          <CardHeader>
            <CardTitle className="text-lg">Quick Access</CardTitle>

            <p className="text-sm text-gray-500">
              Frequently used administrative destinations.
            </p>
          </CardHeader>

          <CardContent>
            <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
              <QuickLink href="/portal/admin/members" label="Manage Members" />

              <QuickLink href="/portal/campaign" label="Campaign Council" />

              <QuickLink href="/portal/tasks" label="Social Tasks" />

              <QuickLink href="/portal/election" label="Election Operations" />
            </div>
          </CardContent>
        </Card>
      </section>
    </div>
  );
}

/*
 * ============================================================
 * SECTION HEADING
 * ============================================================
 */

function SectionHeading({
  title,
  description,
}: {
  title: string;
  description: string;
}) {
  return (
    <div className="mb-4">
      <h2 className="text-lg font-bold text-gray-900">{title}</h2>

      <p className="mt-1 text-sm text-gray-500">{description}</p>
    </div>
  );
}

/*
 * ============================================================
 * CAPABILITY ITEM
 * ============================================================
 */

function CapabilityItem({ label, active }: { label: string; active: boolean }) {
  return (
    <div className="bg-white px-5 py-4">
      <div className="flex items-center justify-between gap-3">
        <span className="text-sm font-medium text-gray-600">{label}</span>

        <span
          className={
            active
              ? "rounded-full bg-green-100 px-2.5 py-1 text-xs font-semibold text-green-700"
              : "rounded-full bg-gray-100 px-2.5 py-1 text-xs font-semibold text-gray-500"
          }
        >
          {active ? "Active" : "Not assigned"}
        </span>
      </div>
    </div>
  );
}

/*
 * ============================================================
 * ADMIN CARD
 * ============================================================
 */

function AdminCard({
  icon,
  title,
  description,
  href,
}: {
  icon: React.ReactNode;
  title: string;
  description: string;
  href: string;
}) {
  return (
    <Link href={href} className="group">
      <Card className="h-full transition-all group-hover:-translate-y-0.5 group-hover:shadow-md">
        <CardContent className="flex h-full flex-col p-5">
          <div className="flex items-start justify-between gap-4">
            <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-xl bg-apc-primary/10 text-apc-primary">
              {icon}
            </div>

            <ArrowRight className="h-4 w-4 text-gray-300 transition-transform group-hover:translate-x-1 group-hover:text-apc-primary" />
          </div>

          <h3 className="mt-4 font-semibold text-gray-900">{title}</h3>

          <p className="mt-1 flex-1 text-sm leading-6 text-gray-500">
            {description}
          </p>

          <span className="mt-4 text-sm font-semibold text-apc-primary">
            Open
          </span>
        </CardContent>
      </Card>
    </Link>
  );
}

/*
 * ============================================================
 * ACCESS INFO
 * ============================================================
 */

function AccessInfo({ label, value }: { label: string; value: string }) {
  return (
    <div className="rounded-xl border bg-gray-50 p-4">
      <p className="text-xs font-semibold uppercase tracking-wide text-gray-400">
        {label}
      </p>

      <p className="mt-2 break-words font-semibold text-gray-900">{value}</p>
    </div>
  );
}

/*
 * ============================================================
 * QUICK LINK
 * ============================================================
 */

function QuickLink({ href, label }: { href: string; label: string }) {
  return (
    <Link
      href={href}
      className="flex items-center justify-between rounded-xl border px-4 py-3 text-sm font-semibold text-gray-700 transition-colors hover:border-apc-primary/30 hover:bg-apc-primary/5 hover:text-apc-primary"
    >
      <span>{label}</span>

      <ArrowRight className="h-4 w-4" />
    </Link>
  );
}
