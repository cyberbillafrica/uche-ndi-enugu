import { readFileSync } from "fs";
import { resolve } from "path";
import {
  initializeTestEnvironment,
  RulesTestEnvironment,
  RulesTestContext,
} from "@firebase/rules-unit-testing";
import { doc, setDoc } from "firebase/firestore";

export const PROJECT_ID = "demo-politicore-test";
export const TENANT_A = "tenantA";
export const TENANT_B = "tenantB";

let testEnvInstance: RulesTestEnvironment | null = null;

export async function getTestEnv(): Promise<RulesTestEnvironment> {
  if (!testEnvInstance) {
    const rules = readFileSync(
      resolve(__dirname, "../../../firestore.rules"),
      "utf8",
    );
    testEnvInstance = await initializeTestEnvironment({
      projectId: PROJECT_ID,
      firestore: {
        host: "127.0.0.1",
        port: 8080,
        rules,
      },
    });
  }
  return testEnvInstance;
}

export async function clearFirestoreData(): Promise<void> {
  if (testEnvInstance) {
    await testEnvInstance.clearFirestore();
  }
}

export async function cleanupTestEnv(): Promise<void> {
  if (testEnvInstance) {
    await testEnvInstance.cleanup();
    testEnvInstance = null;
  }
}

// -------------------------------------------------------------
// Seeding Helpers (Admin / Rules-Disabled Context)
// -------------------------------------------------------------

export async function seedTenant(
  tenantId: string = TENANT_A,
  data: Record<string, unknown> = {},
): Promise<void> {
  const env = await getTestEnv();
  await env.withSecurityRulesDisabled(async (context: RulesTestContext) => {
    const adminDb = context.firestore();
    await setDoc(
      doc(adminDb, "tenants", tenantId),
      {
        name: `Campaign ${tenantId}`,
        election_mode_enabled: true,
        ...data,
      },
      { merge: true },
    );
  });
}

export interface UserProfileSeed {
  tenant_id?: string;
  access_role?:
    | "admin"
    | "tenant_super_admin"
    | "platform_super_admin"
    | "election_officer"
    | "member";
  membership_types?: Array<"social_member" | "campaign_member">;
  points?: number;
  rank?: string;
  ward_id?: string;
  polling_unit_id?: string;
  state_id?: string;
  senatorial_zone_id?: string;
  lga_id?: string;
  email?: string;
  full_name?: string;
  [key: string]: unknown;
}

export async function seedUserProfile(
  userId: string,
  profile: UserProfileSeed,
): Promise<void> {
  const env = await getTestEnv();
  await env.withSecurityRulesDisabled(async (context: RulesTestContext) => {
    const adminDb = context.firestore();
    await setDoc(
      doc(adminDb, "users", userId),
      {
        tenant_id: TENANT_A,
        access_role: "member",
        membership_types: ["campaign_member"],
        points: 0,
        rank: "Volunteer",
        email: `${userId}@example.com`,
        full_name: `Test User ${userId}`,
        ...profile,
      },
      { merge: true },
    );
  });
}

export async function seedUserAccess(params: {
  userId: string;
  permission: string;
  scopeType?: string | null;
  scopeId?: string | null;
  tenantId?: string;
  allowed?: boolean;
}): Promise<void> {
  const env = await getTestEnv();
  const {
    userId,
    permission,
    scopeType,
    scopeId,
    tenantId = TENANT_A,
    allowed = true,
  } = params;

  const docId =
    scopeType && scopeId
      ? `${userId}__${permission}__${scopeType}__${scopeId}`
      : `${userId}__${permission}__global`;

  await env.withSecurityRulesDisabled(async (context: RulesTestContext) => {
    const adminDb = context.firestore();
    await setDoc(doc(adminDb, "user_access", docId), {
      user_id: userId,
      tenant_id: tenantId,
      permission,
      scope_type: scopeType || null,
      scope_id: scopeId || null,
      allowed,
    });
  });
}

export async function seedElectionContest(
  contestId: string,
  data: Record<string, unknown> = {},
): Promise<void> {
  const env = await getTestEnv();
  await env.withSecurityRulesDisabled(async (context: RulesTestContext) => {
    const adminDb = context.firestore();
    await setDoc(
      doc(adminDb, "election_contests", contestId),
      {
        tenant_id: TENANT_A,
        status: "OPEN",
        name: `Contest ${contestId}`,
        election_cycle_id: "cycle-2027",
        contest_type: "governor",
        ...data,
      },
      { merge: true },
    );
  });
}

export async function seedElectionCandidate(
  candidateId: string,
  data: Record<string, unknown> = {},
): Promise<void> {
  const env = await getTestEnv();
  await env.withSecurityRulesDisabled(async (context: RulesTestContext) => {
    const adminDb = context.firestore();
    await setDoc(
      doc(adminDb, "election_candidates", candidateId),
      {
        tenant_id: TENANT_A,
        name: `Candidate ${candidateId}`,
        contest_id: "contest-gov",
        party: "APC",
        ...data,
      },
      { merge: true },
    );
  });
}

export async function seedElectionCycle(
  cycleId: string,
  data: Record<string, unknown> = {},
): Promise<void> {
  const env = await getTestEnv();
  await env.withSecurityRulesDisabled(async (context: RulesTestContext) => {
    const adminDb = context.firestore();
    await setDoc(
      doc(adminDb, "election_cycles", cycleId),
      {
        tenant_id: TENANT_A,
        name: "General Elections 2027",
        year: 2027,
        status: "active",
        ...data,
      },
      { merge: true },
    );
  });
}
