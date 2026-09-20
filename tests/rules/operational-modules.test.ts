import { beforeAll, afterAll, beforeEach, describe, it } from "vitest";
import { assertSucceeds, assertFails } from "@firebase/rules-unit-testing";
import { doc, getDoc, setDoc, updateDoc, deleteDoc } from "firebase/firestore";
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

describe("Security Rules — Operational Modules & Administrative Ledgers", () => {
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

    await seedUserProfile("admin1", {
      tenant_id: TENANT_A,
      access_role: "admin",
    });

    await seedUserProfile("memberA1", {
      tenant_id: TENANT_A,
      access_role: "member",
      membership_types: ["campaign_member"],
      ward_id: "ward-01",
      polling_unit_id: "pu-001",
    });

    await seedUserProfile("socialA1", {
      tenant_id: TENANT_A,
      access_role: "member",
      membership_types: ["social_member"],
    });
  });

  describe("PU Reports & Election Incidents (Field Operations)", () => {
    it("Campaign Member can CREATE pu_report for their registered PU", async () => {
      const env = await getTestEnv();
      const db = env.authenticatedContext("memberA1").firestore();

      await assertSucceeds(
        setDoc(doc(db, "pu_reports", "rep-pu-001"), {
          tenant_id: TENANT_A,
          submitted_by: "memberA1",
          ward_id: "ward-01",
          polling_unit_id: "pu-001",
          report_type: "turnout",
          title: "High Turnout",
          content: "Voters queued up peacefully.",
          status: "submitted",
        }),
      );
    });

    it("Campaign Member CANNOT create pu_report for unregistered PU without grant", async () => {
      const env = await getTestEnv();
      const db = env.authenticatedContext("memberA1").firestore();

      await assertFails(
        setDoc(doc(db, "pu_reports", "rep-pu-002"), {
          tenant_id: TENANT_A,
          submitted_by: "memberA1",
          ward_id: "ward-01",
          polling_unit_id: "pu-002", // Unregistered PU
          report_type: "turnout",
          title: "Unauthorized PU Report",
          content: "Attempting to report for another PU.",
          status: "submitted",
        }),
      );
    });

    it("CORRECTED: Campaign membership alone does NOT grant tenant-wide READ access to pu_reports", async () => {
      const env = await getTestEnv();
      await env.withSecurityRulesDisabled(async (ctx) => {
        await setDoc(doc(ctx.firestore(), "pu_reports", "rep-remote"), {
          tenant_id: TENANT_A,
          ward_id: "ward-99",
          polling_unit_id: "pu-999",
          status: "submitted",
        });
      });

      // memberA1 is registered at ward-01, pu-001. The former
      // || isCampaignMember() read bypass is removed: reads outside the
      // registered Ward + PU require an explicit view_pu_reports grant.
      const db = env.authenticatedContext("memberA1").firestore();
      await assertFails(getDoc(doc(db, "pu_reports", "rep-remote")));
    });

    it("CORRECTED: Campaign membership alone does NOT grant tenant-wide READ access to election_incidents", async () => {
      const env = await getTestEnv();
      await env.withSecurityRulesDisabled(async (ctx) => {
        await setDoc(doc(ctx.firestore(), "election_incidents", "inc-remote"), {
          tenant_id: TENANT_A,
          ward_id: "ward-99",
          polling_unit_id: "pu-999",
          status: "reported",
        });
      });

      // The former || isCampaignMember() read bypass is removed: reads
      // outside the registered Ward + PU require an explicit
      // view_election_incidents grant.
      const db = env.authenticatedContext("memberA1").firestore();
      await assertFails(getDoc(doc(db, "election_incidents", "inc-remote")));
    });
  });

  describe("Tasks and Task Submissions (Social Module)", () => {
    beforeEach(async () => {
      const env = await getTestEnv();
      await env.withSecurityRulesDisabled(async (ctx) => {
        await setDoc(doc(ctx.firestore(), "tasks", "task-active"), {
          tenant_id: TENANT_A,
          title: "Share on Facebook",
          status: "active",
        });
        await setDoc(doc(ctx.firestore(), "tasks", "task-draft"), {
          tenant_id: TENANT_A,
          title: "Draft Task",
          status: "draft",
        });
      });
    });

    it("Social Member CAN read active tasks", async () => {
      const env = await getTestEnv();
      const db = env.authenticatedContext("socialA1").firestore();

      await assertSucceeds(getDoc(doc(db, "tasks", "task-active")));
    });

    it("Social Member CANNOT read inactive/draft tasks", async () => {
      const env = await getTestEnv();
      const db = env.authenticatedContext("socialA1").firestore();

      // Rule line 635: allow read: if isSocialMember() && resource.data.status == "active";
      await assertFails(getDoc(doc(db, "tasks", "task-draft")));
    });

    it("Social Member CAN submit completion with deterministic ID {taskId}_{userId}", async () => {
      const env = await getTestEnv();
      const db = env.authenticatedContext("socialA1").firestore();

      // Rule line 653: submissionId == request.resource.data.task_id + "_" + request.auth.uid
      const submissionId = "task-active_socialA1";

      await assertSucceeds(
        setDoc(doc(db, "task_submissions", submissionId), {
          tenant_id: TENANT_A,
          task_id: "task-active",
          user_id: "socialA1",
          status: "pending",
          proof_url: "https://facebook.com/post/123",
        }),
      );
    });

    it("Social Member CANNOT submit completion on behalf of another user", async () => {
      const env = await getTestEnv();
      const db = env.authenticatedContext("socialA1").firestore();

      const forgedSubmissionId = "task-active_otherUser";

      await assertFails(
        setDoc(doc(db, "task_submissions", forgedSubmissionId), {
          tenant_id: TENANT_A,
          task_id: "task-active",
          user_id: "otherUser", // Impersonation
          status: "pending",
        }),
      );
    });

    it("Social Member CANNOT update their submission once verified", async () => {
      const env = await getTestEnv();
      const submissionId = "task-active_socialA1";

      await env.withSecurityRulesDisabled(async (ctx) => {
        await setDoc(doc(ctx.firestore(), "task_submissions", submissionId), {
          tenant_id: TENANT_A,
          task_id: "task-active",
          user_id: "socialA1",
          status: "verified", // Already verified by admin
        });
      });

      const db = env.authenticatedContext("socialA1").firestore();
      // Rule line 671: resource.data.status != "verified"
      await assertFails(
        updateDoc(doc(db, "task_submissions", submissionId), {
          proof_url: "https://newproof.com",
        }),
      );
    });
  });

  describe("Leaderboard Public Projection", () => {
    beforeEach(async () => {
      const env = await getTestEnv();
      await env.withSecurityRulesDisabled(async (ctx) => {
        await setDoc(doc(ctx.firestore(), "leaderboard_public", "user-lead-1"), {
          tenant_id: TENANT_A,
          user_id: "memberA1",
          points: 150,
          rank: "Captain",
        });
      });
    });

    it("Signed-in same-tenant user CAN read leaderboard_public", async () => {
      const env = await getTestEnv();
      const db = env.authenticatedContext("socialA1").firestore();

      await assertSucceeds(
        getDoc(doc(db, "leaderboard_public", "user-lead-1")),
      );
    });

    it("Ordinary member CANNOT write or modify leaderboard_public", async () => {
      const env = await getTestEnv();
      const db = env.authenticatedContext("socialA1").firestore();

      // Rule line 622: allow create, update, delete: if isAdmin()
      await assertFails(
        updateDoc(doc(db, "leaderboard_public", "user-lead-1"), {
          points: 99999,
        }),
      );
    });
  });

  describe("Campaign Activities & Admin Create Bypass", () => {
    it("Admin CAN create campaign activities globally across the tenant", async () => {
      const env = await getTestEnv();
      const db = env.authenticatedContext("admin1").firestore();

      // Rule line 888: allow create: if (isAdmin() && newDataSameTenant()) || ...
      await assertSucceeds(
        setDoc(doc(db, "campaign_activities", "act-global"), {
          tenant_id: TENANT_A,
          title: "Town Hall Meeting",
          scope_type: "lga",
          scope_id: "nkanu-west",
          created_by: "admin1",
        }),
      );
    });

    it("Member WITHOUT create_activity grant CANNOT create activity", async () => {
      const env = await getTestEnv();
      const db = env.authenticatedContext("memberA1").firestore();

      await assertFails(
        setDoc(doc(db, "campaign_activities", "act-unauthorized"), {
          tenant_id: TENANT_A,
          title: "Unauthorized Meeting",
          scope_type: "ward",
          scope_id: "ward-01",
          created_by: "memberA1",
        }),
      );
    });

    it("Member WITH scoped create_activity user_access CAN create activity in that scope", async () => {
      await seedUserAccess({
        userId: "memberA1",
        permission: "create_activity",
        scopeType: "ward",
        scopeId: "ward-01",
        tenantId: TENANT_A,
      });

      const env = await getTestEnv();
      const db = env.authenticatedContext("memberA1").firestore();

      await assertSucceeds(
        setDoc(doc(db, "campaign_activities", "act-scoped"), {
          tenant_id: TENANT_A,
          title: "Ward Level Meeting",
          scope_type: "ward",
          scope_id: "ward-01",
          created_by: "memberA1",
        }),
      );
    });
  });

  describe("Organizational Assignments, Grants & User Access Protection", () => {
    it("Ordinary user CANNOT create a permission_grant", async () => {
      const env = await getTestEnv();
      const db = env.authenticatedContext("memberA1").firestore();

      await assertFails(
        setDoc(doc(db, "permission_grants", "grant-bad"), {
          tenant_id: TENANT_A,
          user_id: "memberA1",
          permission: "manage_all",
          granted: true,
          granted_by: "memberA1",
        }),
      );
    });

    it("Ordinary user CANNOT write to user_access index", async () => {
      const env = await getTestEnv();
      const db = env.authenticatedContext("memberA1").firestore();

      // Rule line 854: allow create: if isAdmin()
      await assertFails(
        setDoc(doc(db, "user_access", "memberA1__admin__global"), {
          user_id: "memberA1",
          tenant_id: TENANT_A,
          permission: "admin",
          allowed: true,
          scope_type: "global",
          scope_id: "global",
        }),
      );
    });

    it("user_access is NEVER directly readable by client (allow read: if false;)", async () => {
      await seedUserAccess({
        userId: "memberA1",
        permission: "view_dashboard",
        tenantId: TENANT_A,
      });

      const env = await getTestEnv();
      const db = env.authenticatedContext("memberA1").firestore();

      // Rule line 852: allow read: if false;
      await assertFails(
        getDoc(doc(db, "user_access", "memberA1__view_dashboard__global")),
      );
    });
  });

  describe("Donations & Audits Private Administrative Ledger", () => {
    beforeEach(async () => {
      const env = await getTestEnv();
      await env.withSecurityRulesDisabled(async (ctx) => {
        await setDoc(doc(ctx.firestore(), "donations", "don-001"), {
          tenant_id: TENANT_A,
          donor_id: "donor-1",
          amount: 500000,
          donor_name: "Chief Okeke",
          currency: "NGN",
          date_received: "2026-09-01",
          payment_method: "bank_transfer",
          category: "campaign_fund",
          status: "received",
          created_by: "admin1",
        });
      });
    });

    it("Admin CAN read donations", async () => {
      const env = await getTestEnv();
      const db = env.authenticatedContext("admin1").firestore();

      await assertSucceeds(getDoc(doc(db, "donations", "don-001")));
    });

    it("Ordinary member CANNOT read donations", async () => {
      const env = await getTestEnv();
      const db = env.authenticatedContext("memberA1").firestore();

      await assertFails(getDoc(doc(db, "donations", "don-001")));
    });

    it("Donation physical deletion is DENIED for all (allow delete: if false;)", async () => {
      const env = await getTestEnv();
      const db = env.authenticatedContext("admin1").firestore();

      // Rule line 1390: allow delete: if false;
      await assertFails(deleteDoc(doc(db, "donations", "don-001")));
    });

    it("Client creation of system_audits is DENIED (allow create: if false;)", async () => {
      const env = await getTestEnv();
      const db = env.authenticatedContext("admin1").firestore();

      // Rule line 1458: allow create: if false;
      await assertFails(
        setDoc(doc(db, "system_audits", "audit-tamper"), {
          tenant_id: TENANT_A,
          action: "AUDIT_TAMPER",
        }),
      );
    });
  });
});
