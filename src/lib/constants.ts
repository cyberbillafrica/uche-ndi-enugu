import type { MembershipType, LGA } from "@/types";
import { nkanuWestElectoralData } from "@/data/electoral";

export const electoralWards = nkanuWestElectoralData;

export const fallbackLGA: LGA = {
  id: "nkanu-west",
  code: "NW",
  name: "Nkanu West",
  wards: nkanuWestElectoralData,
};

export const membershipOptions: {
  value: MembershipType;
  label: string;
  description: string;
}[] = [
  {
    value: "campaign_member",
    label: "Campaign Member",
    description:
      "Participate in campaign council and organizational activities.",
  },

  {
    value: "social_member",
    label: "Social Member",
    description:
      "Participate in social-media activities, earn points and compete on the leaderboard.",
  },
];

export const socialPlatforms = [
  "facebook",
  "x",
  "instagram",
  "tiktok",
] as const;

export const parties = [
  {
    id: "apc",
    name: "All Progressive Congress",
    color: "#1B4F72",
  },
  {
    id: "pdp",
    name: "Peoples Democratic Party",
    color: "#27AE60",
  },
  {
    id: "ndc",
    name: "Nigeria Democratic Congress",
    color: "#E74C3C",
  },
] as const;

// Helper to search across LGAs list
export function findWardInLGAs(lgas: LGA[], wardId?: string) {
  if (!wardId || !lgas || lgas.length === 0) return undefined;
  for (const lga of lgas) {
    const ward = lga.wards?.find((w) => w.id === wardId);
    if (ward) return ward;
  }
  return undefined;
}

export function findPollingUnitInLGAs(lgas: LGA[], wardId?: string, puId?: string) {
  if (!puId || !lgas || lgas.length === 0) return undefined;
  const ward = findWardInLGAs(lgas, wardId);
  if (ward) {
    const pu = ward.pollingUnits?.find((p) => p.id === puId);
    if (pu) return pu;
  }
  for (const lga of lgas) {
    for (const w of lga.wards || []) {
      const pu = w.pollingUnits?.find((p) => p.id === puId);
      if (pu) return pu;
    }
  }
  return undefined;
}

// Sync functions preserved for backward compatibility
export function getWardById(wardId?: string, lgas?: LGA[]) {
  if (!wardId) return undefined;
  if (lgas && lgas.length > 0) {
    const found = findWardInLGAs(lgas, wardId);
    if (found) return found;
  }
  return nkanuWestElectoralData.find((ward) => ward.id === wardId);
}

export function getPollingUnitById(wardId?: string, pollingUnitId?: string, lgas?: LGA[]) {
  if (!pollingUnitId) return undefined;
  if (lgas && lgas.length > 0) {
    const found = findPollingUnitInLGAs(lgas, wardId, pollingUnitId);
    if (found) return found;
  }
  const ward = getWardById(wardId);
  return ward?.pollingUnits.find((pu) => pu.id === pollingUnitId);
}

export function getElectoralLocation(wardId?: string, pollingUnitId?: string) {
  const ward = getWardById(wardId);

  if (!ward) {
    return {
      ward: null,
      pollingUnit: null,
    };
  }

  const pollingUnit = pollingUnitId
    ? ward.pollingUnits.find((pu) => pu.id === pollingUnitId)
    : null;

  return {
    ward,
    pollingUnit: pollingUnit ?? null,
  };
}

// The async Firestore-backed geography helpers (getAllLGAs, getLGA,
// getWardByIdAsync, getPollingUnitByIdAsync) were removed in the
// Public/Content cutover (Phase 4): geography reads flow through the
// canonical Supabase engine (src/lib/supabase/geography.ts — listLgas /
// listAllWards / listWards / listPollingUnits). The remaining exports
// below are the static reference-data fallbacks.
