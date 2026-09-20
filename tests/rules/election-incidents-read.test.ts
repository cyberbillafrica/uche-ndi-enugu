import { beforeAll, afterAll, beforeEach, describe, it } from "vitest";
import { assertSucceeds, assertFails } from "@firebase/rules-unit-testing";
import { doc, getDoc, setDoc } from "firebase/firestore";
import {
  getTestEnv,
  clearFirestoreData,
  cleanupTestEnv,
  seedTenant,
  seedUserProfile,
  seedUserAccess,
  TENANT_A,
  TENANT_B,
} from "./helpers/test-env";

describe("Security Rules — Election Incident Read Scoping", () => {
  beforeAll(async () => {
    await getTestEnv();
  });

  afterAll(async () => {
    await cleanupTestEnv();
  });

  beforeEach(async () => {
    await clearFirestoreData();
    await seedTenant(TENANT_A);
    await seedTenant(TENANT_B);
  });

  async function seedIncident(
    id: string,
    ward: string,
    pu: string | null,
    tenant: string = TENANT_A,
  ) {
    const env = await getTestEnv();
    await env.withSecurityRulesDisabled(async (ctx) => {
      await setDoc(doc(ctx.firestore(), "election_incidents", id), {
        tenant_id: tenant,
        ward_id: ward,
        status: "reported",
        ...(pu !== null ? { polling_unit_id: pu } : {}),
      });
    });
  }

  describe("Campaign Member Registered Location", () => {
    beforeEach(async () => {
      await seedUserProfile("memberA1", {
        tenant_id: TENANT_A,
        access_role: "member",
        membership_types: ["campaign_member"],
        ward_id: "ward-01",
        polling_unit_id: "pu-001",
      });
    });

    it("Campaign Member CAN read an incident at their registered Ward + PU", async () => {
      await seedIncident("inc-own", "ward-01", "pu-001");

      const env = await getTestEnv();
      const db = env.authenticatedContext("memberA1").firestore();

      await assertSucceeds(getDoc(doc(db, "election_incidents", "inc-own")));
    });

    it("CORRECTED F-INC-01: Campaign Member is DENIED an incident outside their registered location (previously tenant-wide bypass)", async () => {
      await seedIncident("inc-remote", "ward-99", "pu-999");

      const env = await getTestEnv();
      const db = env.authenticatedContext("memberA1").firestore();

      // Previously: "Empirical Check ... isCampaignMember()" asserted
      // assertSucceeds for a remote incident. Membership alone no longer
      // grants tenant-wide reads.
      await assertFails(getDoc(doc(db, "election_incidents", "inc-remote")));
    });

    it("Campaign Member with a scoped view_election_incidents Ward grant CAN read that ward's incident", async () => {
      await seedIncident("inc-ward-02", "ward-02", "pu-020");

      await seedUserAccess({
        userId: "memberA1",
        permission: "view_election_incidents",
        scopeType: "ward",
        scopeId: "ward-02",
        tenantId: TENANT_A,
      });

      const env = await getTestEnv();
      const db = env.authenticatedContext("memberA1").firestore();

      await assertSucceeds(getDoc(doc(db, "election_incidents", "inc-ward-02")));
    });

    it("Campaign Member with a scoped view_election_incidents PU grant CAN read that PU's incident", async () => {
      await seedIncident("inc-pu-777", "ward-99", "pu-777");

      await seedUserAccess({
        userId: "memberA1",
        permission: "view_election_incidents",
        scopeType: "polling_unit",
        scopeId: "pu-777",
        tenantId: TENANT_A,
      });

      const env = await getTestEnv();
      const db = env.authenticatedContext("memberA1").firestore();

      await assertSucceeds(getDoc(doc(db, "election_incidents", "inc-pu-777")));
    });
  });

  describe("Global Permission", () => {
    it("A user with global view_election_incidents CAN read any incident in the tenant", async () => {
      await seedUserProfile("globalViewer", {
        tenant_id: TENANT_A,
        access_role: "member",
        membership_types: ["campaign_member"],
        ward_id: "other-ward",
        polling_unit_id: "other-pu",
      });

      await seedUserAccess({
        userId: "globalViewer",
        permission: "view_election_incidents",
        scopeType: null,
        scopeId: null,
        tenantId: TENANT_A,
      });

      await seedIncident("inc-any", "ward-99", "pu-999");

      const env = await getTestEnv();
      const db = env.authenticatedContext("globalViewer").firestore();

      await assertSucceeds(getDoc(doc(db, "election_incidents", "inc-any")));
    });
  });

  describe("Administrative & Officer Tenant-Wide Reads", () => {
    it("Admin remains tenant-wide for incident reads", async () => {
      await seedUserProfile("admin1", {
        tenant_id: TENANT_A,
        access_role: "admin",
      });

      await seedIncident("inc-admin", "ward-99", "pu-999");

      const env = await getTestEnv();
      const db = env.authenticatedContext("admin1").firestore();

      await assertSucceeds(getDoc(doc(db, "election_incidents", "inc-admin")));
    });

    it("Election Officer remains tenant-wide for incident reads", async () => {
      await seedUserProfile("officer1", {
        tenant_id: TENANT_A,
        access_role: "election_officer",
      });

      await seedIncident("inc-officer", "ward-99", "pu-999");

      const env = await getTestEnv();
      const db = env.authenticatedContext("officer1").firestore();

      await assertSucceeds(getDoc(doc(db, "election_incidents", "inc-officer")));
    });

    it("Cross-tenant read is DENIED for a Tenant B election officer", async () => {
      await seedUserProfile("officerB", {
        tenant_id: TENANT_B,
        access_role: "election_officer",
      });

      await seedIncident("inc-cross", "ward-01", "pu-001", TENANT_A);

      const env = await getTestEnv();
      const dbB = env.authenticatedContext("officerB").firestore();

      await assertFails(getDoc(doc(dbB, "election_incidents", "inc-cross")));
    });
  });
});
