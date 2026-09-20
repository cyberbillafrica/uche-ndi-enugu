import { beforeAll, afterAll, beforeEach, describe, it } from "vitest";
import { assertSucceeds, assertFails } from "@firebase/rules-unit-testing";
import { doc, getDoc, setDoc } from "firebase/firestore";
import {
  getTestEnv,
  clearFirestoreData,
  cleanupTestEnv,
  seedTenant,
  seedUserProfile,
  seedElectionContest,
  seedElectionCycle,
  seedUserAccess,
  TENANT_A,
} from "./helpers/test-env";

describe("Security Rules — Election Access Boundaries", () => {
  beforeAll(async () => {
    await getTestEnv();
  });

  afterAll(async () => {
    await cleanupTestEnv();
  });

  beforeEach(async () => {
    await clearFirestoreData();
    await seedTenant(TENANT_A);
    await seedElectionCycle("cycle-2027", { tenant_id: TENANT_A });
    await seedElectionContest("contest-gov", {
      tenant_id: TENANT_A,
      status: "OPEN",
    });
  });

  describe("Social-Only Member Zero-Election Access Contract", () => {
    beforeEach(async () => {
      await seedUserProfile("socialOnlyUser", {
        tenant_id: TENANT_A,
        access_role: "member",
        membership_types: ["social_member"],
      });
    });

    it("Social-only member is DENIED reading election_results", async () => {
      const env = await getTestEnv();
      await env.withSecurityRulesDisabled(async (ctx) => {
        await setDoc(
          doc(ctx.firestore(), "election_results", "contest-gov__pu-001"),
          {
            tenant_id: TENANT_A,
            contest_id: "contest-gov",
            ward_id: "ward-01",
            polling_unit_id: "pu-001",
            status: "approved",
            verified: true,
          },
        );
      });

      const db = env.authenticatedContext("socialOnlyUser").firestore();
      // Rule lines 236-279: requires Admin, Officer, registeredAt (which requires campaign_member), or user_access
      await assertFails(
        getDoc(doc(db, "election_results", "contest-gov__pu-001")),
      );
    });

    it("Social-only member is DENIED reading pu_reports", async () => {
      const env = await getTestEnv();
      await env.withSecurityRulesDisabled(async (ctx) => {
        await setDoc(doc(ctx.firestore(), "pu_reports", "rep-1"), {
          tenant_id: TENANT_A,
          ward_id: "ward-01",
          polling_unit_id: "pu-001",
          status: "submitted",
        });
      });

      const db = env.authenticatedContext("socialOnlyUser").firestore();
      // Rule line 1220: requires Admin, Officer, isCampaignMember, or user_access
      await assertFails(getDoc(doc(db, "pu_reports", "rep-1")));
    });

    it("Social-only member is DENIED reading election_incidents", async () => {
      const env = await getTestEnv();
      await env.withSecurityRulesDisabled(async (ctx) => {
        await setDoc(doc(ctx.firestore(), "election_incidents", "inc-1"), {
          tenant_id: TENANT_A,
          ward_id: "ward-01",
          polling_unit_id: "pu-001",
          status: "reported",
        });
      });

      const db = env.authenticatedContext("socialOnlyUser").firestore();
      // Rule line 1286: requires Admin, Officer, isCampaignMember, or user_access
      await assertFails(getDoc(doc(db, "election_incidents", "inc-1")));
    });

    it("CORRECTED F-ELECT-01: Social-only member is DENIED reading election_cycles", async () => {
      const env = await getTestEnv();
      const db = env.authenticatedContext("socialOnlyUser").firestore();

      // CORRECTED F-ELECT-01: Rule now requires !isSocialOnly() on read
      // (isSocialMember && !isCampaignMember && !isAdmin && !isElectionOfficer).
      await assertFails(getDoc(doc(db, "election_cycles", "cycle-2027")));
    });

    it("CORRECTED F-ELECT-02: Social-only member is DENIED reading election_contests", async () => {
      const env = await getTestEnv();
      const db = env.authenticatedContext("socialOnlyUser").firestore();

      // CORRECTED F-ELECT-02: same root-cause fix as F-ELECT-01.
      await assertFails(getDoc(doc(db, "election_contests", "contest-gov")));
    });

    it("CORRECTED F-ELECT-03: Social-only member is DENIED reading election_settings", async () => {
      const env = await getTestEnv();
      await env.withSecurityRulesDisabled(async (ctx) => {
        await setDoc(doc(ctx.firestore(), "election_settings", TENANT_A), {
          tenant_id: TENANT_A,
          active_election_cycle_id: "cycle-2027",
        });
      });

      const db = env.authenticatedContext("socialOnlyUser").firestore();
      // CORRECTED F-ELECT-03: same root-cause fix as F-ELECT-01/02.
      await assertFails(getDoc(doc(db, "election_settings", TENANT_A)));
    });

    it("Dual member (social + campaign) is NOT blocked from election_cycles/contests by the social-only fix", async () => {
      await seedUserProfile("dualMember", {
        tenant_id: TENANT_A,
        access_role: "member",
        membership_types: ["social_member", "campaign_member"],
      });

      const env = await getTestEnv();
      const db = env.authenticatedContext("dualMember").firestore();

      // isSocialOnly() is false for dual members — campaign/election
      // authorization applies as usual.
      await assertSucceeds(getDoc(doc(db, "election_cycles", "cycle-2027")));
      await assertSucceeds(getDoc(doc(db, "election_contests", "contest-gov")));
    });

    it("Election Officer and Admin are NOT blocked from election_settings by the social-only fix", async () => {
      await seedUserProfile("officer2", {
        tenant_id: TENANT_A,
        access_role: "election_officer",
      });
      await seedUserProfile("admin2", {
        tenant_id: TENANT_A,
        access_role: "admin",
      });

      const env = await getTestEnv();
      await env.withSecurityRulesDisabled(async (ctx) => {
        await setDoc(doc(ctx.firestore(), "election_settings", TENANT_A), {
          tenant_id: TENANT_A,
          active_election_cycle_id: "cycle-2027",
        });
      });

      const officerDb = env.authenticatedContext("officer2").firestore();
      const adminDb = env.authenticatedContext("admin2").firestore();

      await assertSucceeds(getDoc(doc(officerDb, "election_settings", TENANT_A)));
      await assertSucceeds(getDoc(doc(adminDb, "election_settings", TENANT_A)));
    });
  });

  describe("Campaign Member Election Access Boundaries", () => {
    it("Campaign Member with no election grant/assignment CANNOT read results for unregistered PU", async () => {
      await seedUserProfile("campaignUser1", {
        tenant_id: TENANT_A,
        access_role: "member",
        membership_types: ["campaign_member"],
        ward_id: "ward-01",
        polling_unit_id: "pu-001",
      });

      const env = await getTestEnv();
      await env.withSecurityRulesDisabled(async (ctx) => {
        await setDoc(
          doc(ctx.firestore(), "election_results", "contest-gov__pu-002"),
          {
            tenant_id: TENANT_A,
            contest_id: "contest-gov",
            state_id: "enugu-state",
            senatorial_zone_id: "enugu-east",
            lga_id: "nkanu-west",
            ward_id: "ward-01",
            polling_unit_id: "pu-002",
            status: "approved",
            verified: true,
          },
        );
      });

      const db = env.authenticatedContext("campaignUser1").firestore();
      // Unregistered PU (pu-002 vs user registered pu-001) without grant must be denied
      await assertFails(
        getDoc(doc(db, "election_results", "contest-gov__pu-002")),
      );
    });

    it("Campaign Member CAN read election result for their registered PU", async () => {
      await seedUserProfile("campaignUser1", {
        tenant_id: TENANT_A,
        access_role: "member",
        membership_types: ["campaign_member"],
        ward_id: "ward-01",
        polling_unit_id: "pu-001",
      });

      const env = await getTestEnv();
      await env.withSecurityRulesDisabled(async (ctx) => {
        await setDoc(
          doc(ctx.firestore(), "election_results", "contest-gov__pu-001"),
          {
            tenant_id: TENANT_A,
            contest_id: "contest-gov",
            state_id: "enugu-state",
            senatorial_zone_id: "enugu-east",
            lga_id: "nkanu-west",
            ward_id: "ward-01",
            polling_unit_id: "pu-001",
            status: "approved",
            verified: true,
          },
        );
      });

      const db = env.authenticatedContext("campaignUser1").firestore();
      // registeredAt(wardId, pollingUnitId) satisfies canReadElectionResult
      await assertSucceeds(
        getDoc(doc(db, "election_results", "contest-gov__pu-001")),
      );
    });

    it("Campaign Member with explicit scoped grant can read result in granted scope", async () => {
      await seedUserProfile("campaignUser1", {
        tenant_id: TENANT_A,
        access_role: "member",
        membership_types: ["campaign_member"],
        ward_id: "ward-01",
        polling_unit_id: "pu-001",
      });

      await seedUserAccess({
        userId: "campaignUser1",
        permission: "view_election_results",
        scopeType: "ward",
        scopeId: "ward-02",
        tenantId: TENANT_A,
      });

      const env = await getTestEnv();
      await env.withSecurityRulesDisabled(async (ctx) => {
        await setDoc(
          doc(ctx.firestore(), "election_results", "contest-gov__pu-010"),
          {
            tenant_id: TENANT_A,
            contest_id: "contest-gov",
            state_id: "enugu-state",
            senatorial_zone_id: "enugu-east",
            lga_id: "nkanu-west",
            ward_id: "ward-02",
            polling_unit_id: "pu-010",
            status: "approved",
            verified: true,
          },
        );
      });

      const db = env.authenticatedContext("campaignUser1").firestore();
      // hasScopedAccess("view_election_results", "ward", "ward-02") allows reading ward-02 result
      await assertSucceeds(
        getDoc(doc(db, "election_results", "contest-gov__pu-010")),
      );
    });
  });

  describe("Election Officer Tenant-Wide Election Access", () => {
    beforeEach(async () => {
      await seedUserProfile("officer1", {
        tenant_id: TENANT_A,
        access_role: "election_officer",
      });
    });

    it("Election Officer can read election results across ANY Polling Unit in the tenant", async () => {
      const env = await getTestEnv();
      await env.withSecurityRulesDisabled(async (ctx) => {
        await setDoc(
          doc(ctx.firestore(), "election_results", "contest-gov__pu-999"),
          {
            tenant_id: TENANT_A,
            contest_id: "contest-gov",
            state_id: "enugu-state",
            senatorial_zone_id: "enugu-east",
            lga_id: "nkanu-west",
            ward_id: "ward-99",
            polling_unit_id: "pu-999",
            status: "submitted",
            verified: false,
          },
        );
      });

      const db = env.authenticatedContext("officer1").firestore();
      await assertSucceeds(
        getDoc(doc(db, "election_results", "contest-gov__pu-999")),
      );
    });

    it("Election Officer can read pu_reports across the tenant", async () => {
      const env = await getTestEnv();
      await env.withSecurityRulesDisabled(async (ctx) => {
        await setDoc(doc(ctx.firestore(), "pu_reports", "rep-any"), {
          tenant_id: TENANT_A,
          ward_id: "ward-99",
          polling_unit_id: "pu-999",
          status: "submitted",
        });
      });

      const db = env.authenticatedContext("officer1").firestore();
      await assertSucceeds(getDoc(doc(db, "pu_reports", "rep-any")));
    });

    it("Election Officer can read election_incidents across the tenant", async () => {
      const env = await getTestEnv();
      await env.withSecurityRulesDisabled(async (ctx) => {
        await setDoc(doc(ctx.firestore(), "election_incidents", "inc-any"), {
          tenant_id: TENANT_A,
          ward_id: "ward-99",
          polling_unit_id: "pu-999",
          status: "reported",
        });
      });

      const db = env.authenticatedContext("officer1").firestore();
      await assertSucceeds(getDoc(doc(db, "election_incidents", "inc-any")));
    });
  });
});
