"use client";

import Link from "next/link";
import type { ReactNode } from "react";

import {
  ArrowRight,
  Bell,
  CalendarDays,
  CheckSquare,
  ChevronRight,
  CircleAlert,
  FileText,
  Flag,
  MapPin,
  Megaphone,
  Network,
  ShieldCheck,
  Target,
  TriangleAlert,
  Users,
} from "lucide-react";

import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";

import { useState, useEffect } from "react";
import { useAuth } from "@/contexts/AuthContext";

import { getWardById, getPollingUnitById } from "@/lib/constants";
import { listLgaTree } from "@/lib/supabase";
import type { LGA } from "@/types";

import {
  formatScopeType,
  getPrimaryOrganizationalScope,
  formatOrganizationalPosition,
} from "@/lib/organization";

import type {
  OrganizationalAssignment,
  OrganizationalPosition,
  ScopeType,
} from "@/types";

/*
 * ============================================================
 * CAMPAIGN COUNCIL DASHBOARD
 * ============================================================
 *
 * IMPORTANT ARCHITECTURAL RULE
 *
 * access_role:
 *
 *     "What can this account do in the application?"
 *
 * OrganizationalAssignment:
 *
 *     "Where does this person operate?"
 *
 * Therefore:
 *
 *     Ward Coordinator
 *     LGA Coordinator
 *     Zone Coordinator
 *     State Coordinator
 *
 * are organizational positions, NOT application access roles.
 *
 * The assignments are loaded by AuthContext from Firestore.
 *
 * This dashboard consumes those assignments directly.
 *
 * ============================================================
 */

export default function CampaignDashboard() {
  /*
   * ------------------------------------------------------------
   * AUTH CONTEXT
   * ------------------------------------------------------------
   *
   * AuthContext already loads:
   *
   *   profile
   *   assignments
   *   grants
   *   accessLoading
   *
   * DO NOT query organizational_assignments again here.
   */

  const { profile, assignments: authAssignments, accessLoading } = useAuth();
  const [lgas, setLgas] = useState<LGA[]>([]);

  useEffect(() => {
    async function loadLgas() {
      try {
        const data = await listLgaTree();
        setLgas(data);
      } catch (err) {
        console.error("Failed to load LGAs in campaign dashboard:", err);
      }
    }
    loadLgas();
  }, []);

  /*
   * Defensive normalization.
   *
   * The context normally provides an array, but keeping the
   * dashboard defensive prevents .length / .map errors if
   * something unexpected occurs.
   */

  const assignments: OrganizationalAssignment[] = Array.isArray(authAssignments)
    ? authAssignments
    : [];

  /*
   * ------------------------------------------------------------
   * AUTH GUARD
   * ------------------------------------------------------------
   */

  if (!profile) {
    return null;
  }

  /*
   * ------------------------------------------------------------
   * LOADING
   * ------------------------------------------------------------
   *
   * AuthContext is responsible for loading the organizational
   * assignments from Firestore.
   */

  if (accessLoading) {
    return <CampaignDashboardSkeleton />;
  }

  /*
   * ------------------------------------------------------------
   * PRIMARY ORGANIZATIONAL SCOPE
   * ------------------------------------------------------------
   */

  const primaryScope = getPrimaryOrganizationalScope(assignments);

  const primaryAssignment = primaryScope.assignment;

  /*
   * ------------------------------------------------------------
   * ELECTORAL LOCATION
   *
   * This represents the person's registered electoral location.
   *
   * It does NOT determine campaign authority.
   * ------------------------------------------------------------
   */

  const ward = getWardById(profile.ward_id, lgas);

  const pollingUnit = getPollingUnitById(
    profile.ward_id,
    profile.polling_unit_id,
    lgas
  );

  const wardLabel = ward
    ? `${ward.code} — ${ward.name}`
    : profile.ward_id
    ? profile.ward_id
    : "Not set";

  const pollingUnitLabel = pollingUnit
    ? `${pollingUnit.code} — ${pollingUnit.name}`
    : profile.polling_unit_id
    ? profile.polling_unit_id
    : "Not set";

  /*
   * ------------------------------------------------------------
   * ORGANIZATIONAL SUMMARY
   * ------------------------------------------------------------
   */

  const organizationalPosition = primaryAssignment?.position
    ? formatPosition(primaryAssignment.position)
    : "Campaign Member";

  const organizationalScope = primaryAssignment?.scope_type
    ? formatScopeType(primaryAssignment.scope_type)
    : "Campaign";

  const organizationalScopeId = primaryAssignment?.scope_id || "Campaign-wide";

  const assignmentCount = assignments.length;

  const activeAssignments = assignments.filter(
    (assignment) => assignment.status === "active",
  );

  const scopeSummary = buildScopeSummary(activeAssignments);

  /*
   * ------------------------------------------------------------
   * AUTHORITY SUMMARY
   *
   * These are UI capability hints.
   *
   * Firestore security rules remain the actual security boundary.
   * ------------------------------------------------------------
   */

  const authority = getOrganizationalAuthority(activeAssignments);

  /*
   * ------------------------------------------------------------
   * DASHBOARD
   * ------------------------------------------------------------
   */

  return (
    <div className="space-y-6 pb-10">
      {/* ======================================================
          HEADER
          ====================================================== */}

      <section className="overflow-hidden rounded-2xl border bg-white shadow-sm">
        <div className="bg-apc-primary px-6 py-7 text-white sm:px-8">
          <div className="flex flex-col gap-6 lg:flex-row lg:items-center lg:justify-between">
            <div className="min-w-0">
              <div className="mb-2 flex items-center gap-2">
                <ShieldCheck className="h-5 w-5 text-white/80" />

                <span className="text-sm font-semibold text-white/80">
                  Campaign Council
                </span>
              </div>

              <h1 className="text-2xl font-bold sm:text-3xl">
                Welcome back, {profile.full_name || "Member"}
              </h1>

              <p className="mt-2 max-w-2xl text-sm leading-6 text-white/75">
                Your campaign organization command center. Manage your
                responsibilities, activities, field reporting and organizational
                operations from one place.
              </p>
            </div>

            {/* Organizational identity */}

            <div className="w-full rounded-2xl border border-white/15 bg-white/10 p-4 backdrop-blur-sm lg:w-auto lg:min-w-[280px]">
              <p className="text-xs font-semibold uppercase tracking-wider text-white/60">
                Organizational Position
              </p>

              <p className="mt-1 text-lg font-bold">{organizationalPosition}</p>

              <div className="mt-2 flex items-center gap-2 text-sm text-white/75">
                <MapPin className="h-4 w-4 shrink-0" />

                <span>
                  {organizationalScope}
                  {organizationalScopeId !== "Campaign-wide"
                    ? ` · ${organizationalScopeId}`
                    : ""}
                </span>
              </div>
            </div>
          </div>
        </div>

        {/* Registered location strip */}

        <div className="grid divide-y sm:grid-cols-2 sm:divide-x sm:divide-y-0">
          <LocationStrip label="Registered Ward" value={wardLabel} />

          <LocationStrip
            label="Registered Polling Unit"
            value={pollingUnitLabel}
          />
        </div>
      </section>

      {/* ======================================================
          ORGANIZATIONAL DATA STATUS
          ====================================================== */}

      {assignments.length === 0 && (
        <div className="rounded-xl border border-yellow-200 bg-yellow-50 p-5">
          <div className="flex gap-3">
            <TriangleAlert className="h-5 w-5 shrink-0 text-yellow-600" />

            <div>
              <p className="font-semibold text-yellow-900">
                Campaign organizational assignment pending
              </p>

              <p className="mt-1 text-sm leading-6 text-yellow-800">
                Your account is registered for campaign participation, but no
                organizational assignment was found for your account yet.
                Campaign functions available to your account remain accessible.
              </p>
            </div>
          </div>
        </div>
      )}

      {/* ======================================================
          NO ACTIVE ASSIGNMENT
          ====================================================== */}

      {assignments.length > 0 && activeAssignments.length === 0 && (
        <div className="rounded-xl border border-yellow-200 bg-yellow-50 p-5">
          <div className="flex gap-3">
            <TriangleAlert className="h-5 w-5 shrink-0 text-yellow-600" />

            <div>
              <p className="font-semibold text-yellow-900">
                No active organizational assignment
              </p>

              <p className="mt-1 text-sm leading-6 text-yellow-800">
                Your account has organizational assignment records, but none are
                currently active.
              </p>
            </div>
          </div>
        </div>
      )}

      {/* ======================================================
          COMMAND CENTER SUMMARY
          ====================================================== */}

      <section>
        <div className="mb-3">
          <h2 className="text-lg font-bold text-gray-900">Campaign Overview</h2>

          <p className="text-sm text-gray-500">
            Your current organizational position and area of responsibility.
          </p>
        </div>

        <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
          <SummaryCard
            icon={<ShieldCheck className="h-5 w-5" />}
            label="Position"
            value={organizationalPosition}
            detail={
              primaryAssignment
                ? "Active organizational assignment"
                : "No active assignment"
            }
            iconClass="bg-blue-100 text-blue-700"
          />

          <SummaryCard
            icon={<MapPin className="h-5 w-5" />}
            label="Primary Scope"
            value={organizationalScope}
            detail={organizationalScopeId}
            iconClass="bg-green-100 text-green-700"
          />

          <SummaryCard
            icon={<Network className="h-5 w-5" />}
            label="Active Assignments"
            value={String(activeAssignments.length)}
            detail={
              activeAssignments.length === 1
                ? "1 active organizational responsibility"
                : `${activeAssignments.length} active organizational responsibilities`
            }
            iconClass="bg-purple-100 text-purple-700"
          />

          <SummaryCard
            icon={<Target className="h-5 w-5" />}
            label="Coverage"
            value={scopeSummary.primaryLabel}
            detail={scopeSummary.secondaryLabel}
            iconClass="bg-orange-100 text-orange-700"
          />
        </div>
      </section>

      {/* ======================================================
          MY ORGANIZATIONAL AREA
          ====================================================== */}

      <Card className="overflow-hidden">
        <CardHeader className="border-b bg-gray-50/70">
          <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
            <div>
              <CardTitle className="text-lg">My Campaign Area</CardTitle>

              <p className="mt-1 text-sm text-gray-500">
                The organizational area covered by your campaign assignment.
              </p>
            </div>

            <Link
              href="/portal/campaign/area"
              className="inline-flex w-fit items-center gap-2 rounded-lg border bg-white px-4 py-2 text-sm font-semibold text-gray-700 transition hover:bg-gray-50"
            >
              View Area
              <ArrowRight className="h-4 w-4" />
            </Link>
          </div>
        </CardHeader>

        <CardContent className="p-5">
          {primaryAssignment ? (
            <>
              <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
                <AreaDetail label="Position" value={organizationalPosition} />

                <AreaDetail label="Scope" value={organizationalScope} />

                <AreaDetail label="Scope ID" value={organizationalScopeId} />

                <AreaDetail label="Assignment Status" value="Active" positive />
              </div>

              {/* Assignment metadata */}

              <div className="mt-5 grid gap-4 sm:grid-cols-2">
                <AreaDetail
                  label="Assignment ID"
                  value={primaryAssignment.id}
                />

                <AreaDetail
                  label="Assigned By"
                  value={primaryAssignment.assigned_by || "Not available"}
                />
              </div>

              {/* Hierarchy */}

              <div className="mt-5 rounded-xl border bg-gray-50 p-4">
                <div className="mb-3 flex items-center gap-2">
                  <Network className="h-4 w-4 text-apc-primary" />

                  <p className="text-sm font-semibold text-gray-900">
                    Organizational Coverage
                  </p>
                </div>

                {scopeSummary.hierarchy.length > 0 ? (
                  <div className="flex flex-wrap items-center gap-2">
                    {scopeSummary.hierarchy.map((item, index) => (
                      <div
                        key={`${item.type}-${item.id}`}
                        className="flex items-center gap-2"
                      >
                        <span className="rounded-lg border bg-white px-3 py-2 text-sm font-medium text-gray-700">
                          <span className="text-gray-400">{item.type}:</span>{" "}
                          {item.id}
                        </span>

                        {index < scopeSummary.hierarchy.length - 1 && (
                          <ChevronRight className="h-4 w-4 text-gray-300" />
                        )}
                      </div>
                    ))}
                  </div>
                ) : (
                  <p className="text-sm text-gray-500">
                    No organizational scope has been assigned.
                  </p>
                )}
              </div>
            </>
          ) : (
            <EmptyState
              icon={<Network className="h-6 w-6" />}
              title="No organizational area assigned"
              description="An administrator can assign you to a campaign position and organizational scope."
            />
          )}
        </CardContent>
      </Card>

      {profile.access_role === "admin" && (
        <DashboardCard
          icon={<ShieldCheck className="h-6 w-6 text-indigo-600" />}
          iconBackground="bg-indigo-100"
          title="Coordination"
          description="Manage organizational assignments, permissions and campaign coordination."
          href="/portal/campaign/coordination"
          action="Manage Organization"
        />
      )}

      {/* ======================================================
          OPERATIONS
          ====================================================== */}

      <section>
        <div className="mb-3">
          <h2 className="text-lg font-bold text-gray-900">
            Campaign Operations
          </h2>

          <p className="text-sm text-gray-500">
            Core tools for campaign organization, coordination and field
            operations.
          </p>
        </div>

        <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
          <DashboardCard
            icon={<Users className="h-6 w-6 text-blue-600" />}
            iconBackground="bg-blue-100"
            title="My Area"
            description="View the campaign organization within your assigned scope."
            href="/portal/campaign/area"
            action="View Area"
          />

          <DashboardCard
            icon={<CheckSquare className="h-6 w-6 text-orange-600" />}
            iconBackground="bg-orange-100"
            title="Assignments"
            description="View campaign responsibilities assigned to you."
            href="/portal/campaign/assignments"
            action="View Assignments"
          />

          <DashboardCard
            icon={<CalendarDays className="h-6 w-6 text-green-600" />}
            iconBackground="bg-green-100"
            title="Activities"
            description="View meetings, events and campaign activities relevant to your scope."
            href="/portal/campaign/activities"
            action="View Activities"
          />

          <DashboardCard
            icon={<FileText className="h-6 w-6 text-purple-600" />}
            iconBackground="bg-purple-100"
            title="Field Reports"
            description="Submit and track reports from campaign activities and field operations."
            href="/portal/campaign/reports"
            action="View Reports"
          />

          <DashboardCard
            icon={<TriangleAlert className="h-6 w-6 text-red-600" />}
            iconBackground="bg-red-100"
            title="Issues"
            description="Report community, logistics, communication or campaign operational issues."
            href="/portal/campaign/issues"
            action="View Issues"
          />

        </div>
      </section>

      {/* ======================================================
          ROLE-AWARE MANAGEMENT
          ====================================================== */}

      {authority.canManageArea && (
        <Card className="border-apc-primary/10">
          <CardHeader>
            <CardTitle className="text-lg">Area Management</CardTitle>

            <p className="text-sm text-gray-500">
              Management functions available because of your organizational
              responsibility.
            </p>
          </CardHeader>

          <CardContent>
            <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
              {authority.canViewMembers && (
                <ManagementLink
                  icon={<Users className="h-4 w-4" />}
                  title="Members"
                  description="View members within your permitted area."
                  href="/portal/campaign/members"
                />
              )}

              {authority.canAssignTasks && (
                <ManagementLink
                  icon={<CheckSquare className="h-4 w-4" />}
                  title="Assign Work"
                  description="Create or assign campaign responsibilities."
                  href="/portal/campaign/assignments"
                />
              )}

              {authority.canManageActivities && (
                <ManagementLink
                  icon={<CalendarDays className="h-4 w-4" />}
                  title="Manage Activities"
                  description="Coordinate activities within your scope."
                  href="/portal/campaign/activities"
                />
              )}

              {authority.canReviewReports && (
                <ManagementLink
                  icon={<FileText className="h-4 w-4" />}
                  title="Review Reports"
                  description="Review field reports submitted within your authority."
                  href="/portal/campaign/reports"
                />
              )}
            </div>
          </CardContent>
        </Card>
      )}

      {/* ======================================================
          MY PRIORITIES
          ====================================================== */}

      <div className="grid gap-6 lg:grid-cols-2">
        <Card>
          <CardHeader>
            <CardTitle className="text-lg">My Priorities</CardTitle>

            <p className="text-sm text-gray-500">
              Core actions requiring your attention.
            </p>
          </CardHeader>

          <CardContent>
            <div className="space-y-3">
              <PriorityRow
                icon={<CheckSquare className="h-4 w-4" />}
                title="Campaign assignments"
                description="Review responsibilities assigned to you."
                href="/portal/campaign/assignments"
              />

              <PriorityRow
                icon={<FileText className="h-4 w-4" />}
                title="Field reporting"
                description="Submit reports from campaign activities."
                href="/portal/campaign/reports"
              />

              <PriorityRow
                icon={<TriangleAlert className="h-4 w-4" />}
                title="Community issues"
                description="Report or follow up on operational issues."
                href="/portal/campaign/issues"
              />

              <PriorityRow
                icon={<CalendarDays className="h-4 w-4" />}
                title="Upcoming activities"
                description="Review your campaign activities."
                href="/portal/campaign/activities"
              />
            </div>
          </CardContent>
        </Card>

      </div>

      {/* ======================================================
          REGISTERED ELECTORAL LOCATION
          ====================================================== */}

      <Card>
        <CardHeader>
          <CardTitle className="text-lg">
            My Registered Electoral Area
          </CardTitle>

          <p className="text-sm text-gray-500">
            Your registered electoral location is separate from your campaign
            organizational authority.
          </p>
        </CardHeader>

        <CardContent>
          <div className="grid gap-4 sm:grid-cols-2">
            <InfoBox
              label="Ward"
              value={wardLabel}
              icon={<MapPin className="h-4 w-4" />}
            />

            <InfoBox
              label="Polling Unit"
              value={pollingUnitLabel}
              icon={<MapPin className="h-4 w-4" />}
            />
          </div>

          <div className="mt-4 rounded-xl border border-blue-100 bg-blue-50 p-4">
            <p className="text-sm leading-6 text-blue-800">
              <strong>Important:</strong> Your registered Ward and Polling Unit
              identify where you are personally registered. They do not
              automatically determine the campaign area you coordinate. Campaign
              authority comes from your organizational assignment.
            </p>
          </div>
        </CardContent>
      </Card>

      {/* ======================================================
          ELECTION OPERATIONS
          ====================================================== */}

      <Card className="border-amber-200 bg-amber-50/40">
        <CardHeader>
          <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
            <div>
              <div className="flex items-center gap-2">
                <ShieldCheck className="h-5 w-5 text-amber-700" />

                <CardTitle className="text-lg">Election Operations</CardTitle>
              </div>

              <p className="mt-1 text-sm text-gray-600">
                Election functions are separate from campaign organizational
                management.
              </p>
            </div>

            <span className="w-fit rounded-full border border-amber-200 bg-white px-3 py-1 text-xs font-semibold text-amber-700">
              Election Section
            </span>
          </div>
        </CardHeader>

        <CardContent>
          <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
            <ElectionFunction
              title="PU Report"
              description="Report election activity at an authorized polling unit."
              href="/portal/election"
            />

            <ElectionFunction
              title="Incident"
              description="Report election incidents within your permitted scope."
              href="/portal/election"
            />

            <ElectionFunction
              title="Result Upload"
              description="Upload election results where authorized."
              href="/portal/election"
            />

            <ElectionFunction
              title="Election Operations"
              description="Open the complete election operations area."
              href="/portal/election"
              primary
            />
          </div>

          <div className="mt-4 rounded-xl border border-amber-200 bg-white p-4">
            <div className="flex gap-3">
              <TriangleAlert className="h-5 w-5 shrink-0 text-amber-600" />

              <div>
                <p className="text-sm font-semibold text-gray-900">
                  Election availability is controlled separately
                </p>

                <p className="mt-1 text-sm leading-6 text-gray-600">
                  Election functions remain visible to users instead of
                  disappearing. Their actual ability to submit or manage
                  election information is determined by election mode and the
                  user&apos;s authorization.
                </p>
              </div>
            </div>
          </div>
        </CardContent>
      </Card>

      {/* ======================================================
          CAMPAIGN READINESS
          ====================================================== */}

      <Card>
        <CardHeader>
          <CardTitle className="text-lg">Campaign Readiness & Health</CardTitle>

          <p className="text-sm text-gray-500">
            Calculated operational readiness indicators across organization, location, activities, and election mode.
          </p>
        </CardHeader>

        <CardContent>
          <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
            <ReadinessItem
              label="Organizational Assignment"
              status={primaryAssignment ? `Assigned (${primaryAssignment.position.replace("_", " ")})` : "Pending Assignment"}
              positive={Boolean(primaryAssignment)}
            />

            <ReadinessItem
              label="Registered Electoral Area"
              status={
                profile.ward_id && profile.polling_unit_id
                  ? "Ward & PU Configured"
                  : "Location Incomplete"
              }
              positive={Boolean(profile.ward_id && profile.polling_unit_id)}
            />

            <ReadinessItem
              label="Member Profile & Verification"
              status={profile.phone ? "Profile Verified" : "Phone Missing"}
              positive={Boolean(profile.phone)}
            />

            <ReadinessItem
              label="System Collation Readiness"
              status="Election Mode Enabled"
              positive={true}
            />
          </div>
        </CardContent>
      </Card>
    </div>
  );
}

/*
 * ============================================================
 * SCOPE SUMMARY
 * ============================================================
 */

interface ScopeSummary {
  primaryLabel: string;
  secondaryLabel: string;
  hierarchy: {
    type: string;
    id: string;
  }[];
}

function buildScopeSummary(
  assignments: OrganizationalAssignment[],
): ScopeSummary {
  if (assignments.length === 0) {
    return {
      primaryLabel: "Not assigned",
      secondaryLabel: "Awaiting organizational assignment",
      hierarchy: [],
    };
  }

  const primary = getPrimaryOrganizationalScope(assignments).assignment;

  if (!primary) {
    return {
      primaryLabel: "Campaign",
      secondaryLabel: "Campaign-wide",
      hierarchy: [],
    };
  }

  const hierarchy = [
    {
      type: formatScopeType(primary.scope_type),
      id: primary.scope_id,
    },
  ];

  return {
    primaryLabel: formatScopeType(primary.scope_type),
    secondaryLabel: primary.scope_id,
    hierarchy,
  };
}

/*
 * ============================================================
 * ORGANIZATIONAL AUTHORITY
 * ============================================================
 */

interface OrganizationalAuthority {
  canManageArea: boolean;
  canViewMembers: boolean;
  canAssignTasks: boolean;
  canManageActivities: boolean;
  canReviewReports: boolean;
}

function getOrganizationalAuthority(
  assignments: OrganizationalAssignment[],
): OrganizationalAuthority {
  const positions = new Set(
    assignments
      .filter((assignment) => assignment.status === "active")
      .map((assignment) => assignment.position),
  );

  const canManageArea =
    positions.has("ward_coordinator") ||
    positions.has("lga_coordinator") ||
    positions.has("zone_coordinator") ||
    positions.has("state_coordinator") ||
    positions.has("campaign_manager") ||
    positions.has("council_chairman");

  return {
    canManageArea,
    canViewMembers: canManageArea,
    canAssignTasks: canManageArea,
    canManageActivities: canManageArea,
    canReviewReports: canManageArea,
  };
}

/*
 * ============================================================
 * POSITION FORMATTER
 * ============================================================
 */

function formatPosition(position: OrganizationalPosition): string {
  return formatOrganizationalPosition(position);
}

/*
 * ============================================================
 * LOCATION STRIP
 * ============================================================
 */

function LocationStrip({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex items-center gap-3 px-6 py-4">
      <MapPin className="h-4 w-4 shrink-0 text-apc-primary" />

      <div className="min-w-0">
        <p className="text-xs font-semibold uppercase tracking-wide text-gray-400">
          {label}
        </p>

        <p className="mt-1 truncate text-sm font-semibold text-gray-900">
          {value}
        </p>
      </div>
    </div>
  );
}

/*
 * ============================================================
 * SUMMARY CARD
 * ============================================================
 */

function SummaryCard({
  icon,
  label,
  value,
  detail,
  iconClass,
}: {
  icon: ReactNode;
  label: string;
  value: string;
  detail: string;
  iconClass: string;
}) {
  return (
    <Card>
      <CardContent className="p-5">
        <div className="flex items-start justify-between gap-3">
          <div>
            <p className="text-xs font-semibold uppercase tracking-wide text-gray-400">
              {label}
            </p>

            <p className="mt-2 line-clamp-2 text-lg font-bold text-gray-900">
              {value}
            </p>

            <p className="mt-1 line-clamp-2 text-xs text-gray-500">{detail}</p>
          </div>

          <div
            className={`flex h-10 w-10 shrink-0 items-center justify-center rounded-xl ${iconClass}`}
          >
            {icon}
          </div>
        </div>
      </CardContent>
    </Card>
  );
}

/*
 * ============================================================
 * AREA DETAIL
 * ============================================================
 */

function AreaDetail({
  label,
  value,
  positive,
}: {
  label: string;
  value: string;
  positive?: boolean;
}) {
  return (
    <div className="rounded-xl border bg-white p-4">
      <p className="text-xs font-semibold uppercase tracking-wide text-gray-400">
        {label}
      </p>

      <p
        className={`mt-2 font-semibold ${
          positive ? "text-green-700" : "text-gray-900"
        }`}
      >
        {value}
      </p>
    </div>
  );
}

/*
 * ============================================================
 * DASHBOARD CARD
 * ============================================================
 */

function DashboardCard({
  icon,
  iconBackground,
  title,
  description,
  href,
  action,
}: {
  icon: ReactNode;
  iconBackground: string;
  title: string;
  description: string;
  href: string;
  action: string;
}) {
  return (
    <Card className="h-full transition-all hover:-translate-y-0.5 hover:shadow-md">
      <CardContent className="flex h-full flex-col p-5">
        <div
          className={`mb-4 flex h-11 w-11 items-center justify-center rounded-xl ${iconBackground}`}
        >
          {icon}
        </div>

        <h3 className="font-semibold text-gray-900">{title}</h3>

        <p className="mt-1 flex-1 text-sm leading-6 text-gray-500">
          {description}
        </p>

        <Link
          href={href}
          className="mt-4 inline-flex items-center gap-1 text-sm font-semibold text-apc-primary hover:underline"
        >
          {action}

          <ArrowRight className="h-4 w-4" />
        </Link>
      </CardContent>
    </Card>
  );
}

/*
 * ============================================================
 * MANAGEMENT LINK
 * ============================================================
 */

function ManagementLink({
  icon,
  title,
  description,
  href,
}: {
  icon: ReactNode;
  title: string;
  description: string;
  href: string;
}) {
  return (
    <Link
      href={href}
      className="group rounded-xl border bg-white p-4 transition hover:border-apc-primary/30 hover:bg-gray-50"
    >
      <div className="flex items-center gap-3">
        <div className="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg bg-apc-primary/10 text-apc-primary">
          {icon}
        </div>

        <div className="min-w-0">
          <p className="font-semibold text-gray-900">{title}</p>

          <p className="mt-1 text-xs leading-5 text-gray-500">{description}</p>
        </div>
      </div>

      <div className="mt-3 flex items-center justify-end gap-1 text-xs font-semibold text-apc-primary">
        Open
        <ArrowRight className="h-3.5 w-3.5 transition group-hover:translate-x-0.5" />
      </div>
    </Link>
  );
}

/*
 * ============================================================
 * PRIORITY ROW
 * ============================================================
 */

function PriorityRow({
  icon,
  title,
  description,
  href,
}: {
  icon: ReactNode;
  title: string;
  description: string;
  href: string;
}) {
  return (
    <Link
      href={href}
      className="group flex items-center gap-3 rounded-xl border p-4 transition-colors hover:bg-gray-50"
    >
      <div className="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg bg-apc-primary/10 text-apc-primary">
        {icon}
      </div>

      <div className="min-w-0 flex-1">
        <p className="font-medium text-gray-900">{title}</p>

        <p className="mt-0.5 text-sm text-gray-500">{description}</p>
      </div>

      <ArrowRight className="h-4 w-4 shrink-0 text-gray-400 transition group-hover:translate-x-0.5" />
    </Link>
  );
}

/*
 * ============================================================
 * ELECTION FUNCTION
 * ============================================================
 */

function ElectionFunction({
  title,
  description,
  href,
  primary = false,
}: {
  title: string;
  description: string;
  href: string;
  primary?: boolean;
}) {
  return (
    <Link
      href={href}
      className={`rounded-xl border p-4 transition ${
        primary
          ? "border-apc-primary bg-apc-primary text-white shadow-sm hover:opacity-95"
          : "border-gray-200 bg-white hover:bg-gray-50"
      }`}
    >
      <div className="flex items-start justify-between gap-3">
        <div>
          <p
            className={`font-semibold ${
              primary ? "text-white" : "text-gray-900"
            }`}
          >
            {title}
          </p>

          <p
            className={`mt-1 text-xs leading-5 ${
              primary ? "text-white/75" : "text-gray-500"
            }`}
          >
            {description}
          </p>
        </div>

        <ArrowRight
          className={`h-4 w-4 shrink-0 ${
            primary ? "text-white/80" : "text-gray-400"
          }`}
        />
      </div>
    </Link>
  );
}

/*
 * ============================================================
 * INFO BOX
 * ============================================================
 */

function InfoBox({
  label,
  value,
  icon,
}: {
  label: string;
  value: string;
  icon?: ReactNode;
}) {
  return (
    <div className="rounded-xl border bg-gray-50 p-4">
      <div className="flex items-center gap-2">
        {icon && <span className="text-apc-primary">{icon}</span>}

        <p className="text-xs font-semibold uppercase tracking-wide text-gray-400">
          {label}
        </p>
      </div>

      <p className="mt-2 font-semibold text-gray-900">{value}</p>
    </div>
  );
}

/*
 * ============================================================
 * READINESS ITEM
 * ============================================================
 */

function ReadinessItem({
  label,
  status,
  positive,
}: {
  label: string;
  status: string;
  positive: boolean;
}) {
  return (
    <div className="rounded-xl border bg-gray-50 p-4">
      <p className="text-xs font-semibold uppercase tracking-wide text-gray-400">
        {label}
      </p>

      <div className="mt-2 flex items-center gap-2">
        <span
          className={`h-2.5 w-2.5 rounded-full ${
            positive ? "bg-green-500" : "bg-yellow-500"
          }`}
        />

        <p
          className={`text-sm font-semibold ${
            positive ? "text-green-700" : "text-yellow-700"
          }`}
        >
          {status}
        </p>
      </div>
    </div>
  );
}

/*
 * ============================================================
 * EMPTY STATE
 * ============================================================
 */

function EmptyState({
  icon,
  title,
  description,
}: {
  icon: ReactNode;
  title: string;
  description: string;
}) {
  return (
    <div className="rounded-xl border border-dashed p-8 text-center">
      <div className="mx-auto flex h-12 w-12 items-center justify-center rounded-xl bg-gray-100 text-gray-500">
        {icon}
      </div>

      <p className="mt-3 font-semibold text-gray-900">{title}</p>

      <p className="mx-auto mt-1 max-w-lg text-sm leading-6 text-gray-500">
        {description}
      </p>
    </div>
  );
}

/*
 * ============================================================
 * LOADING SKELETON
 * ============================================================
 */

function CampaignDashboardSkeleton() {
  return (
    <div className="space-y-6 pb-10">
      <div className="h-48 animate-pulse rounded-2xl bg-gray-100" />

      <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
        {Array.from({ length: 4 }).map((_, index) => (
          <div
            key={index}
            className="h-32 animate-pulse rounded-xl bg-gray-100"
          />
        ))}
      </div>

      <div className="h-56 animate-pulse rounded-xl bg-gray-100" />

      <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
        {Array.from({ length: 8 }).map((_, index) => (
          <div
            key={index}
            className="h-48 animate-pulse rounded-xl bg-gray-100"
          />
        ))}
      </div>
    </div>
  );
}
