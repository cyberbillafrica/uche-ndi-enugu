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

describe("Security Rules — PU Report Read Scoping", () => {
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

  async function seedReport(id: string, ward: string, pu: string, tenant: string = TENANT_A) {
    const env = await getTestEnv();
    await env.withSecurityRulesDisabled(async (ctx) => {
      await setDoc(doc(ctx.firestore(), "pu_reports", id), {
        tenant_id: tenant,
        ward_id: ward,
        polling_unit_id: pu,
        status: "submitted",
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

    it("Campaign Member CAN read a report for their registered Ward + PU", async () => {
      await seedReport("rep-own", "ward-01", "pu-001");

      const env = await getTestEnv();
      const db = env.authenticatedContext("memberA1").firestore();

      await assertSucceeds(getDoc(doc(db, "pu_reports", "rep-own")));
    });

    it("CORRECTED F-PU-01: Campaign Member is DENIED a report outside their registered location (previously tenant-wide bypass)", async () => {
      await seedReport("rep-remote", "ward-99", "pu-999");

      const env = await getTestEnv();
      const db = env.authenticatedContext("memberA1").firestore();

      // Previously: "Empirical Check ... isCampaignMember()" asserted
      // assertSucceeds for a remote report. Membership alone no longer grants
      // tenant-wide reads.
      await assertFails(getDoc(doc(db, "pu_reports", "rep-remote")));
    });

    it("Campaign Member with a scoped view_pu_reports Ward grant CAN read that ward's report", async () => {
      await seedReport("rep-ward-02", "ward-02", "pu-020");

      await seedUserAccess({
        userId: "memberA1",
        permission: "view_pu_reports",
        scopeType: "ward",
        scopeId: "ward-02",
        tenantId: TENANT_A,
      });

      const env = await getTestEnv();
      const db = env.authenticatedContext("memberA1").firestore();

      await assertSucceeds(getDoc(doc(db, "pu_reports", "rep-ward-02")));
    });

    it("Campaign Member with a scoped view_pu_reports Polling Unit grant CAN read that PU's report", async () => {
      await seedReport("rep-pu-777", "ward-99", "pu-777");

      await seedUserAccess({
        userId: "memberA1",
        permission: "view_pu_reports",
        scopeType: "polling_unit",
        scopeId: "pu-777",
        tenantId: TENANT_A,
      });

      const env = await getTestEnv();
      const db = env.authenticatedContext("memberA1").firestore();

      await assertSucceeds(getDoc(doc(db, "pu_reports", "rep-pu-777")));
    });

    it("A ward grant for a DIFFERENT ward does not grant reads outside the registered location", async () => {
      await seedReport("rep-ward-03", "ward-03", "pu-030");

      await seedUserAccess({
        userId: "memberA1",
        permission: "view_pu_reports",
        scopeType: "ward",
        scopeId: "ward-02", // grant is for ward-02, report is ward-03
        tenantId: TENANT_A,
      });

      const env = await getTestEnv();
      const db = env.authenticatedContext("memberA1").firestore();

      await assertFails(getDoc(doc(db, "pu_reports", "rep-ward-03")));
    });
  });

  describe("Global Permission", () => {
    it("A user with global view_pu_reports CAN read any report in the tenant", async () => {
      await seedUserProfile("globalViewer", {
        tenant_id: TENANT_A,
        access_role: "member",
        membership_types: ["campaign_member"],
        ward_id: "other-ward",
        polling_unit_id: "other-pu",
      });

      await seedUserAccess({
        userId: "globalViewer",
        permission: "view_pu_reports",
        scopeType: null,
        scopeId: null,
        tenantId: TENANT_A,
      });

      await seedReport("rep-any", "ward-99", "pu-999");

      const env = await getTestEnv();
      const db = env.authenticatedContext("globalViewer").firestore();

      await assertSucceeds(getDoc(doc(db, "pu_reports", "rep-any")));
    });
  });

  describe("Administrative & Officer Tenant-Wide Reads", () => {
    it("Admin remains tenant-wide for PU report reads", async () => {
      await seedUserProfile("admin1", {
        tenant_id: TENANT_A,
        access_role: "admin",
      });

      await seedReport("rep-admin", "ward-99", "pu-999");

      const env = await getTestEnv();
      const db = env.authenticatedContext("admin1").firestore();

      await assertSucceeds(getDoc(doc(db, "pu_reports", "rep-admin")));
    });

    it("Election Officer remains tenant-wide for PU report reads", async () => {
      await seedUserProfile("officer1", {
        tenant_id: TENANT_A,
        access_role: "election_officer",
      });

      await seedReport("rep-officer", "ward-99", "pu-999");

      const env = await getTestEnv();
      const db = env.authenticatedContext("officer1").firestore();

      await assertSucceeds(getDoc(doc(db, "pu_reports", "rep-officer")));
    });

    it("Cross-tenant read is DENIED for a Tenant B admin", async () => {
      await seedUserProfile("adminB", {
        tenant_id: TENANT_B,
        access_role: "admin",
      });

      await seedReport("rep-cross", "ward-01", "pu-001", TENANT_A);

      const env = await getTestEnv();
      const dbB = env.authenticatedContext("adminB").firestore();

      await assertFails(getDoc(doc(dbB, "pu_reports", "rep-cross")));
    });
  });
});
