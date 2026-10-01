"use client";

import Link from "next/link";
import {
  AlertTriangle,
  ArrowRight,
  BarChart3,
  CheckCircle2,
  ClipboardList,
  FileText,
  MapPin,
  Upload,
  Activity,
  ShieldCheck,
} from "lucide-react";

import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { useAuth } from "@/contexts/AuthContext";
import { getWardById, getPollingUnitById } from "@/lib/constants";

/* -------------------------------------------------------------------------- */
/* Types                                                                      */
/* -------------------------------------------------------------------------- */

type ActionCardProps = {
  icon: React.ReactNode;
  iconBackground: string;
  title: string;
  description: string;
  href: string;
  action: string;
};

type StatCardProps = {
  icon: React.ReactNode;
  label: string;
  value: string | number;
  description: string;
};

/* -------------------------------------------------------------------------- */
/* Main Dashboard                                                             */
/* -------------------------------------------------------------------------- */

export default function ElectionOfficerDashboard() {
  const { profile } = useAuth();

  if (!profile) return null;

  /*
   * EO users are not restricted to profile.ward_id / profile.polling_unit_id
   * when reporting election activity.
   *
   * We still display their registered electoral area for identification,
   * but all operational actions point to the full election-operation routes.
   */

  const registeredWard = profile.ward_id ? getWardById(profile.ward_id) : null;

  const registeredPollingUnit =
    profile.ward_id && profile.polling_unit_id
      ? getPollingUnitById(profile.ward_id, profile.polling_unit_id)
      : null;

  const registeredWardLabel = registeredWard
    ? `${registeredWard.code} — ${registeredWard.name}`
    : "Not assigned";

  const registeredPollingUnitLabel = registeredPollingUnit
    ? `${registeredPollingUnit.code} — ${registeredPollingUnit.name}`
    : "Not assigned";

  return (
    <div className="space-y-6 pb-10">
      {/* ------------------------------------------------------------------ */}
      {/* Header                                                              */}
      {/* ------------------------------------------------------------------ */}

      <section className="rounded-2xl bg-gradient-to-r from-brand-primary to-brand-primary p-6 text-white shadow-sm sm:p-8">
        <div className="flex flex-col gap-6 lg:flex-row lg:items-center lg:justify-between">
          <div>
            <div className="mb-3 inline-flex items-center gap-2 rounded-full bg-white/10 px-3 py-1.5 text-xs font-semibold uppercase tracking-wide text-white">
              <ShieldCheck className="h-4 w-4" />
              Election Operations
            </div>

            <h1 className="text-2xl font-bold tracking-tight sm:text-3xl">
              Welcome back, {profile.full_name || "Election Officer"}
            </h1>

            <p className="mt-2 max-w-2xl text-sm leading-6 text-white/75 sm:text-base">
              Monitor election activities, submit polling-unit reports, report
              incidents, and upload election results across all wards and
              polling units.
            </p>
          </div>

          <div className="shrink-0 rounded-xl bg-white/10 p-4 backdrop-blur-sm">
            <div className="flex items-center gap-3">
              <div className="flex h-11 w-11 items-center justify-center rounded-full bg-white/15">
                <Activity className="h-5 w-5" />
              </div>

              <div>
                <p className="text-xs font-medium uppercase tracking-wide text-white/60">
                  Access Level
                </p>
                <p className="mt-0.5 font-semibold">
                  All Wards & Polling Units
                </p>
              </div>
            </div>
          </div>
        </div>
      </section>

      {/* ------------------------------------------------------------------ */}
      {/* Operational stats                                                  */}
      {/* ------------------------------------------------------------------ */}

      <section>
        <div className="mb-4">
          <h2 className="text-lg font-semibold text-gray-900">
            Election Operations
          </h2>

          <p className="mt-1 text-sm text-gray-500">
            Your election activity overview.
          </p>
        </div>

        <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
          <StatCard
            icon={<ClipboardList className="h-5 w-5" />}
            label="PU Reports"
            value="—"
            description="Reports submitted"
          />

          <StatCard
            icon={<AlertTriangle className="h-5 w-5" />}
            label="Incidents"
            value="—"
            description="Incidents reported"
          />

          <StatCard
            icon={<Upload className="h-5 w-5" />}
            label="Results"
            value="—"
            description="Results uploaded"
          />

          <StatCard
            icon={<CheckCircle2 className="h-5 w-5" />}
            label="Coverage"
            value="—"
            description="Reporting coverage"
          />
        </div>
      </section>

      {/* ------------------------------------------------------------------ */}
      {/* Quick actions                                                       */}
      {/* ------------------------------------------------------------------ */}

      <section>
        <div className="mb-4">
          <h2 className="text-lg font-semibold text-gray-900">
            Quick Operations
          </h2>

          <p className="mt-1 text-sm text-gray-500">
            Start an election activity report from here.
          </p>
        </div>

        <div className="grid gap-4 md:grid-cols-3">
          <ActionCard
            icon={<ClipboardList className="h-6 w-6 text-blue-600" />}
            iconBackground="bg-blue-100"
            title="PU Report"
            description="Submit an operational report for any polling unit."
            href="/portal/election/pu-reports"
            action="Submit PU Report"
          />

          <ActionCard
            icon={<AlertTriangle className="h-6 w-6 text-orange-600" />}
            iconBackground="bg-orange-100"
            title="Report Incident"
            description="Record an election incident and associate it with a polling unit."
            href="/portal/election/incidents"
            action="Report Incident"
          />

          <ActionCard
            icon={<Upload className="h-6 w-6 text-green-600" />}
            iconBackground="bg-green-100"
            title="Result Upload"
            description="Submit polling-unit election results for the official record."
            href="/portal/election/upload"
            action="Upload Result"
          />
        </div>
      </section>

      {/* ------------------------------------------------------------------ */}
      {/* Coverage / operational scope                                        */}
      {/* ------------------------------------------------------------------ */}

      <section className="grid gap-6 lg:grid-cols-2">
        <Card className="border-0 shadow-sm">
          <CardHeader>
            <div className="flex items-start justify-between gap-4">
              <div>
                <CardTitle className="text-lg">Electoral Coverage</CardTitle>

                <p className="mt-1 text-sm text-gray-500">
                  Election officers can report across all registered wards and
                  polling units.
                </p>
              </div>

              <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-lg bg-purple-100">
                <MapPin className="h-5 w-5 text-purple-600" />
              </div>
            </div>
          </CardHeader>

          <CardContent>
            <div className="rounded-xl border border-gray-100 bg-gray-50 p-5">
              <div className="flex items-center justify-between gap-4">
                <div>
                  <p className="text-sm text-gray-500">Operational scope</p>

                  <p className="mt-1 font-semibold text-gray-900">
                    All Wards & Polling Units
                  </p>
                </div>

                <div className="rounded-full bg-green-100 px-3 py-1 text-xs font-semibold text-green-700">
                  Full Access
                </div>
              </div>

              <div className="mt-5 grid gap-3 sm:grid-cols-2">
                <div className="rounded-lg bg-white p-4">
                  <p className="text-xs font-medium uppercase tracking-wide text-gray-400">
                    Wards
                  </p>

                  <p className="mt-1 text-lg font-bold text-gray-900">All</p>
                </div>

                <div className="rounded-lg bg-white p-4">
                  <p className="text-xs font-medium uppercase tracking-wide text-gray-400">
                    Polling Units
                  </p>

                  <p className="mt-1 text-lg font-bold text-gray-900">All</p>
                </div>
              </div>
            </div>
          </CardContent>
        </Card>

        {/* ---------------------------------------------------------------- */}
        {/* Officer profile area                                              */}
        {/* ---------------------------------------------------------------- */}

        <Card className="border-0 shadow-sm">
          <CardHeader>
            <div className="flex items-start justify-between gap-4">
              <div>
                <CardTitle className="text-lg">Officer Information</CardTitle>

                <p className="mt-1 text-sm text-gray-500">
                  Your registered electoral information.
                </p>
              </div>

              <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-lg bg-blue-100">
                <ShieldCheck className="h-5 w-5 text-blue-600" />
              </div>
            </div>
          </CardHeader>

          <CardContent>
            <div className="space-y-3">
              <InfoRow
                label="Name"
                value={profile.full_name || "Not provided"}
              />

              <InfoRow label="Registered Ward" value={registeredWardLabel} />

              <InfoRow
                label="Registered Polling Unit"
                value={registeredPollingUnitLabel}
              />

              <InfoRow
                label="Operational Access"
                value="All wards and polling units"
              />
            </div>
          </CardContent>
        </Card>
      </section>

      {/* ------------------------------------------------------------------ */}
      {/* Monitoring section                                                  */}
      {/* ------------------------------------------------------------------ */}

      <Card className="overflow-hidden border-0 shadow-sm">
        <CardHeader>
          <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
            <div>
              <CardTitle className="text-lg">
                Election Activity Monitoring
              </CardTitle>

              <p className="mt-1 text-sm text-gray-500">
                Use the operational modules to submit and monitor election
                activity.
              </p>
            </div>

            <BarChart3 className="hidden h-5 w-5 text-gray-400 sm:block" />
          </div>
        </CardHeader>

        <CardContent>
          <div className="grid gap-3 md:grid-cols-3">
            <MonitoringLink
              href="/portal/election/pu-reports"
              icon={<FileText className="h-5 w-5" />}
              title="Polling Unit Reports"
              description="View and submit PU reports."
            />

            <MonitoringLink
              href="/portal/election/incidents"
              icon={<AlertTriangle className="h-5 w-5" />}
              title="Incident Reports"
              description="Record and review election incidents."
            />

            <MonitoringLink
              href="/portal/election/upload"
              icon={<Upload className="h-5 w-5" />}
              title="Result Uploads"
              description="Submit election results by polling unit."
            />
          </div>
        </CardContent>
      </Card>

      {/* ------------------------------------------------------------------ */}
      {/* Operational reminder                                                */}
      {/* ------------------------------------------------------------------ */}

      <div className="rounded-xl border border-blue-100 bg-blue-50 p-5">
        <div className="flex gap-3">
          <div className="mt-0.5 shrink-0">
            <ShieldCheck className="h-5 w-5 text-blue-600" />
          </div>

          <div>
            <h3 className="font-semibold text-blue-900">
              Election Officer Access
            </h3>

            <p className="mt-1 text-sm leading-6 text-blue-800/80">
              As an Election Officer, you can submit election activity reports
              for any ward and polling unit. Ordinary members remain restricted
              to their registered electoral area.
            </p>
          </div>
        </div>
      </div>
    </div>
  );
}

/* -------------------------------------------------------------------------- */
/* Stat Card                                                                  */
/* -------------------------------------------------------------------------- */

function StatCard({ icon, label, value, description }: StatCardProps) {
  return (
    <Card className="border-0 shadow-sm">
      <CardContent className="p-5">
        <div className="flex items-start justify-between gap-4">
          <div>
            <p className="text-sm font-medium text-gray-500">{label}</p>

            <p className="mt-2 text-2xl font-bold text-gray-900">{value}</p>

            <p className="mt-1 text-xs text-gray-400">{description}</p>
          </div>

          <div className="flex h-10 w-10 items-center justify-center rounded-lg bg-gray-100 text-gray-600">
            {icon}
          </div>
        </div>
      </CardContent>
    </Card>
  );
}

/* -------------------------------------------------------------------------- */
/* Action Card                                                                */
/* -------------------------------------------------------------------------- */

function ActionCard({
  icon,
  iconBackground,
  title,
  description,
  href,
  action,
}: ActionCardProps) {
  return (
    <Card className="border-0 shadow-sm transition-shadow hover:shadow-md">
      <CardContent className="p-5">
        <div
          className={`flex h-12 w-12 items-center justify-center rounded-xl ${iconBackground}`}
        >
          {icon}
        </div>

        <h3 className="mt-4 font-semibold text-gray-900">{title}</h3>

        <p className="mt-1 min-h-[48px] text-sm leading-5 text-gray-500">
          {description}
        </p>

        <Link
          href={href}
          className="mt-5 inline-flex items-center gap-1.5 text-sm font-semibold text-brand-primary hover:underline"
        >
          {action}
          <ArrowRight className="h-4 w-4" />
        </Link>
      </CardContent>
    </Card>
  );
}

/* -------------------------------------------------------------------------- */
/* Monitoring Link                                                            */
/* -------------------------------------------------------------------------- */

function MonitoringLink({
  href,
  icon,
  title,
  description,
}: {
  href: string;
  icon: React.ReactNode;
  title: string;
  description: string;
}) {
  return (
    <Link
      href={href}
      className="group flex items-center gap-4 rounded-xl border border-gray-100 bg-gray-50 p-4 transition hover:border-brand-primary/20 hover:bg-white hover:shadow-sm"
    >
      <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-lg bg-white text-gray-600 shadow-sm transition group-hover:text-brand-primary">
        {icon}
      </div>

      <div className="min-w-0 flex-1">
        <p className="font-semibold text-gray-900">{title}</p>

        <p className="mt-0.5 text-xs text-gray-500">{description}</p>
      </div>

      <ArrowRight className="h-4 w-4 shrink-0 text-gray-400 transition group-hover:translate-x-0.5 group-hover:text-brand-primary" />
    </Link>
  );
}

/* -------------------------------------------------------------------------- */
/* Info Row                                                                   */
/* -------------------------------------------------------------------------- */

function InfoRow({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex flex-col gap-1 rounded-lg bg-gray-50 p-4 sm:flex-row sm:items-center sm:justify-between sm:gap-4">
      <span className="text-sm text-gray-500">{label}</span>

      <span className="text-sm font-semibold text-gray-900 sm:text-right">
        {value}
      </span>
    </div>
  );
}
