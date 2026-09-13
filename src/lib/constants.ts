import type { MembershipType, LGA, Ward, PollingUnit } from "@/types";
import { nkanuWestElectoralData } from "@/data/electoral";
import {
  getLGAs as getLGAsFromFirestore,
  getLGAById as getLGAByIdFromFirestore,
  getWardById as getWardByIdFromFirestore,
  getPollingUnitById as getPollingUnitByIdFromFirestore,
} from "./firebase/electoral";

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

// Async functions with Firestore primary access + graceful fallbacks
export async function getAllLGAs(): Promise<LGA[]> {
  try {
    const lgas = await getLGAsFromFirestore();
    if (lgas && lgas.length > 0) {
      return lgas;
    }
  } catch (err) {
    console.error("Failed to load LGAs from Firestore:", err);
    throw new Error("Failed to load electoral data from database.");
  }
  return [];
}

export async function getLGA(id: string): Promise<LGA | null> {
  try {
    const lga = await getLGAByIdFromFirestore(id);
    if (lga) return lga;
  } catch (err) {
    console.error(`Failed to load LGA ${id} from Firestore, checking fallback:`, err);
  }

  if (id === "nkanu-west" || !id) {
    return fallbackLGA;
  }
  return null;
}

export async function getWardByIdAsync(
  lgaId: string,
  wardId: string,
): Promise<Ward | null> {
  try {
    const ward = await getWardByIdFromFirestore(lgaId, wardId);
    if (ward) return ward;
  } catch (err) {
    console.error(`Failed to load ward ${wardId} from Firestore:`, err);
  }

  // Fallback check
  if (!lgaId || lgaId === "nkanu-west") {
    return getWardById(wardId) ?? null;
  }
  return null;
}

export async function getPollingUnitByIdAsync(
  lgaId: string,
  wardId: string,
  puId: string,
): Promise<PollingUnit | null> {
  try {
    const pu = await getPollingUnitByIdFromFirestore(lgaId, wardId, puId);
    if (pu) return pu;
  } catch (err) {
    console.error(`Failed to load PU ${puId} from Firestore:`, err);
  }

  // Fallback check
  if (!lgaId || lgaId === "nkanu-west") {
    return getPollingUnitById(wardId, puId) ?? null;
  }
  return null;
}
