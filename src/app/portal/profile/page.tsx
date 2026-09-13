"use client";

import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";

import { FaFacebook, FaInstagram, FaTiktok } from "react-icons/fa";
import { FaXTwitter } from "react-icons/fa6";

import { ExternalLink, MapPin, ShieldCheck, User, Users } from "lucide-react";

import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";

import { useAuth } from "@/contexts/AuthContext";
import { getAllLGAs, getWardById, getPollingUnitById } from "@/lib/constants";
import type { LGA } from "@/types";

export default function ProfilePage() {
  const { user, profile, loading } = useAuth();
  const router = useRouter();
  const [lgas, setLgas] = useState<LGA[]>([]);

  useEffect(() => {
    async function loadLgas() {
      try {
        const data = await getAllLGAs();
        setLgas(data);
      } catch (err) {
        console.error("Failed to load LGAs in profile:", err);
      }
    }
    loadLgas();
  }, []);

  // ─────────────────────────────────────────────
  // Authentication
  // ─────────────────────────────────────────────

  useEffect(() => {
    if (!loading && !user) {
      router.push("/login");
    }
  }, [loading, user, router]);

  // ─────────────────────────────────────────────
  // Loading states
  // ─────────────────────────────────────────────

  if (loading) {
    return (
      <div className="flex min-h-[50vh] items-center justify-center gap-3">
        <div className="h-12 w-12 animate-spin rounded-full border-b-2 border-apc-primary" />

        <p className="text-gray-500">Checking authentication…</p>
      </div>
    );
  }

  if (!user) {
    return null;
  }

  if (!profile) {
    return (
      <div className="flex min-h-[50vh] items-center justify-center">
        <p className="text-gray-500">Loading profile data…</p>
      </div>
    );
  }

  // ─────────────────────────────────────────────
  // Electoral information
  // ─────────────────────────────────────────────

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

  // ─────────────────────────────────────────────
  // Membership / role labels
  // ─────────────────────────────────────────────

  const membershipLabels = (profile.membership_types || []).map(
    (membership: string) => {
      switch (membership) {
        case "campaign_member":
          return "Campaign Council Member";

        case "social_member":
          return "Social Media Member";

        default:
          return membership.replace(/_/g, " ");
      }
    },
  );

  const accessRoleLabel =
    profile.access_role === "admin"
      ? "Administrator"
      : profile.access_role === "election_officer"
        ? "Election Officer"
        : "Member";

  // Only Social Media Members should see the social section.
  const isSocialMember =
    profile.membership_types?.includes("social_member") === true;

  return (
    <div className="space-y-6 pb-8">
      {/* ─────────────────────────────────────────────
          Page Header
      ───────────────────────────────────────────── */}

      <div>
        <p className="text-sm font-medium text-apc-primary">Account</p>

        <h1 className="mt-1 text-2xl font-bold text-gray-900 sm:text-3xl">
          My Profile
        </h1>

        <p className="mt-1 text-gray-600">
          View your personal, membership, electoral, and social media
          information.
        </p>
      </div>

      {/* ─────────────────────────────────────────────
          Personal Information
      ───────────────────────────────────────────── */}

      <Card className="border-0 shadow-sm">
        <CardHeader>
          <div className="flex items-center gap-3">
            <div className="flex h-10 w-10 items-center justify-center rounded-lg bg-apc-primary/10">
              <User className="h-5 w-5 text-apc-primary" />
            </div>

            <div>
              <CardTitle className="text-lg">Personal Information</CardTitle>

              <p className="mt-1 text-sm text-gray-500">
                Your registered personal details.
              </p>
            </div>
          </div>
        </CardHeader>

        <CardContent>
          <div className="grid gap-6 md:grid-cols-2">
            <ProfileField label="Full Name" value={profile.full_name} />

            <ProfileField label="Email" value={profile.email} />

            <ProfileField label="Phone" value={profile.phone} />

            <ProfileField
              label="Gender"
              value={
                profile.gender
                  ? profile.gender.charAt(0).toUpperCase() +
                    profile.gender.slice(1)
                  : "—"
              }
            />
          </div>
        </CardContent>
      </Card>

      {/* ─────────────────────────────────────────────
          Campaign / Electoral Information
      ───────────────────────────────────────────── */}

      <Card className="border-0 shadow-sm">
        <CardHeader>
          <div className="flex items-center gap-3">
            <div className="flex h-10 w-10 items-center justify-center rounded-lg bg-green-100">
              <MapPin className="h-5 w-5 text-green-700" />
            </div>

            <div>
              <CardTitle className="text-lg">
                Campaign & Electoral Information
              </CardTitle>

              <p className="mt-1 text-sm text-gray-500">
                Your membership and registered electoral location.
              </p>
            </div>
          </div>
        </CardHeader>

        <CardContent>
          <div className="grid gap-6 md:grid-cols-2">
            <ProfileField
              label="Membership"
              value={
                membershipLabels.length > 0 ? membershipLabels.join(", ") : "—"
              }
            />

            <ProfileField label="Access Level" value={accessRoleLabel} />

            <ProfileField label="Ward" value={wardLabel} />

            <ProfileField label="Polling Unit" value={pollingUnitLabel} />
          </div>
        </CardContent>
      </Card>

      {/* ─────────────────────────────────────────────
          Social Media Accounts
          Social Members ONLY
      ───────────────────────────────────────────── */}

      {isSocialMember && (
        <Card className="border-0 shadow-sm">
          <CardHeader>
            <div className="flex items-center gap-3">
              <div className="flex h-10 w-10 items-center justify-center rounded-lg bg-blue-100">
                <Users className="h-5 w-5 text-blue-700" />
              </div>

              <div>
                <CardTitle className="text-lg">Social Media Accounts</CardTitle>

                <p className="mt-1 text-sm text-gray-500">
                  Your connected campaign social platforms.
                </p>
              </div>
            </div>
          </CardHeader>

          <CardContent>
            <div className="grid gap-4 md:grid-cols-2">
              <SocialProfile
                platform="Facebook"
                name={profile.facebook_name}
                url={profile.facebook_profile_url}
                icon={<FaFacebook className="h-5 w-5 text-[#1877F2]" />}
                iconBackground="bg-blue-50"
              />

              <SocialProfile
                platform="Instagram"
                name={profile.instagram_name}
                url={profile.instagram_profile_url}
                icon={<FaInstagram className="h-5 w-5 text-[#E4405F]" />}
                iconBackground="bg-pink-50"
              />

              <SocialProfile
                platform="X"
                name={profile.x_name}
                url={profile.x_profile_url}
                icon={<FaXTwitter className="h-5 w-5 text-black" />}
                iconBackground="bg-gray-100"
              />

              <SocialProfile
                platform="TikTok"
                name={profile.tiktok_name}
                url={profile.tiktok_profile_url}
                icon={<FaTiktok className="h-5 w-5 text-black" />}
                iconBackground="bg-gray-100"
              />
            </div>

            <div className="mt-5 rounded-lg border border-blue-100 bg-blue-50 p-4">
              <p className="text-sm leading-6 text-blue-800">
                Your registered social profile links allow campaign
                administrators to identify your account when verifying social
                media activities.
              </p>
            </div>
          </CardContent>
        </Card>
      )}

      {/* ─────────────────────────────────────────────
          Account Access
      ───────────────────────────────────────────── */}

      <Card className="border-0 shadow-sm">
        <CardHeader>
          <div className="flex items-center gap-3">
            <div className="flex h-10 w-10 items-center justify-center rounded-lg bg-gray-100">
              <ShieldCheck className="h-5 w-5 text-gray-700" />
            </div>

            <div>
              <CardTitle className="text-lg">Account Access</CardTitle>

              <p className="mt-1 text-sm text-gray-500">
                Your current access level within the campaign portal.
              </p>
            </div>
          </div>
        </CardHeader>

        <CardContent>
          <div className="flex items-center justify-between rounded-lg bg-gray-50 p-4">
            <div>
              <p className="text-sm text-gray-500">Access Level</p>

              <p className="mt-1 font-semibold capitalize text-gray-900">
                {accessRoleLabel}
              </p>
            </div>

            <ShieldCheck className="h-6 w-6 text-apc-primary" />
          </div>
        </CardContent>
      </Card>
    </div>
  );
}

// ─────────────────────────────────────────────
// Standard profile field
// ─────────────────────────────────────────────

function ProfileField({
  label,
  value,
}: {
  label: string;
  value?: string | null;
}) {
  return (
    <div>
      <p className="text-sm text-gray-500">{label}</p>

      <p className="mt-1 font-medium text-gray-900">{value || "—"}</p>
    </div>
  );
}

// ─────────────────────────────────────────────
// Social profile
// ─────────────────────────────────────────────

function SocialProfile({
  platform,
  name,
  url,
  icon,
  iconBackground,
}: {
  platform: string;
  name?: string | null;
  url?: string | null;
  icon: React.ReactNode;
  iconBackground: string;
}) {
  const connected = Boolean(name?.trim() && url?.trim());

  return (
    <div className="rounded-xl border border-gray-200 bg-white p-4 transition hover:border-gray-300 hover:shadow-sm">
      <div className="flex items-start gap-4">
        <div
          className={`flex h-11 w-11 shrink-0 items-center justify-center rounded-lg ${iconBackground}`}
        >
          {icon}
        </div>

        <div className="min-w-0 flex-1">
          <p className="text-sm font-semibold text-gray-900">{platform}</p>

          {connected ? (
            <>
              <p className="mt-1 truncate text-sm text-gray-700">{name}</p>

              <a
                href={url!}
                target="_blank"
                rel="noopener noreferrer"
                className="mt-2 inline-flex items-center gap-1.5 text-xs font-semibold text-apc-primary hover:underline"
              >
                View Profile
                <ExternalLink className="h-3.5 w-3.5" />
              </a>
            </>
          ) : (
            <p className="mt-1 text-sm text-gray-400">Not connected</p>
          )}
        </div>
      </div>
    </div>
  );
}
