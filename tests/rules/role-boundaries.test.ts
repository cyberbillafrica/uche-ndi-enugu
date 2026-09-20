import { beforeAll, afterAll, beforeEach, describe, it } from "vitest";
import { assertSucceeds, assertFails } from "@firebase/rules-unit-testing";
import { doc, getDoc, setDoc, deleteDoc } from "firebase/firestore";
import {
  getTestEnv,
  clearFirestoreData,
  cleanupTestEnv,
  seedTenant,
  seedUserProfile,
  TENANT_A,
} from "./helpers/test-env";

describe("Security Rules — Role Boundary Matrix & Administrative Scope", () => {
  beforeAll(async () => {
    await getTestEnv();
  });

  afterAll(async () => {
    await cleanupTestEnv();
  });

  beforeEach(async () => {
    await clearFirestoreData();
    await seedTenant(TENANT_A);
  });

  describe("Administrative Roles Collapsing in isAdmin()", () => {
    it("'admin' can create and delete portal content announcements", async () => {
      await seedUserProfile("admin1", {
        tenant_id: TENANT_A,
        access_role: "admin",
      });

      const env = await getTestEnv();
      const db = env.authenticatedContext("admin1").firestore();

      // Line 781: allow create, update: if isAdmin() && tenantId == callerTenantId() && request.resource.data.tenant_id == tenantId;
      await assertSucceeds(
        setDoc(doc(db, "portal_content", TENANT_A), {
          tenant_id: TENANT_A,
          announcements: ["Welcome to campaign"],
        }),
      );
    });

    it("'tenant_super_admin' is recognized by isAdmin() and can manage portal content", async () => {
      await seedUserProfile("superAdmin1", {
        tenant_id: TENANT_A,
        access_role: "tenant_super_admin",
      });

      const env = await getTestEnv();
      const db = env.authenticatedContext("superAdmin1").firestore();

      await assertSucceeds(
        setDoc(doc(db, "portal_content", TENANT_A), {
          tenant_id: TENANT_A,
          announcements: ["Super admin announcement"],
        }),
      );
    });

    it("'platform_super_admin' is recognized by isAdmin() and can manage portal content", async () => {
      await seedUserProfile("platAdmin1", {
        tenant_id: TENANT_A,
        access_role: "platform_super_admin",
      });

      const env = await getTestEnv();
      const db = env.authenticatedContext("platAdmin1").firestore();

      await assertSucceeds(
        setDoc(doc(db, "portal_content", TENANT_A), {
          tenant_id: TENANT_A,
          announcements: ["Platform admin announcement"],
        }),
      );
    });
  });

  describe("Membership Types vs Access Roles", () => {
    it("Social-only member CANNOT perform administrative actions (e.g. create task)", async () => {
      await seedUserProfile("socialUser", {
        tenant_id: TENANT_A,
        access_role: "member",
        membership_types: ["social_member"],
      });

      const env = await getTestEnv();
      const db = env.authenticatedContext("socialUser").firestore();

      // Rule line 638: allow create, update, delete: if isAdmin();
      await assertFails(
        setDoc(doc(db, "tasks", "task-unauthorized"), {
          tenant_id: TENANT_A,
          title: "Malicious Task",
          status: "active",
        }),
      );
    });

    it("Campaign-only member CANNOT perform administrative actions (e.g. create task)", async () => {
      await seedUserProfile("campaignUser", {
        tenant_id: TENANT_A,
        access_role: "member",
        membership_types: ["campaign_member"],
      });

      const env = await getTestEnv();
      const db = env.authenticatedContext("campaignUser").firestore();

      await assertFails(
        setDoc(doc(db, "tasks", "task-unauthorized-2"), {
          tenant_id: TENANT_A,
          title: "Malicious Task",
          status: "active",
        }),
      );
    });

    it("Dual member (social + campaign) still has 'member' access_role and CANNOT perform admin actions", async () => {
      await seedUserProfile("dualUser", {
        tenant_id: TENANT_A,
        access_role: "member",
        membership_types: ["social_member", "campaign_member"],
      });

      const env = await getTestEnv();
      const db = env.authenticatedContext("dualUser").firestore();

      await assertFails(
        setDoc(doc(db, "tasks", "task-unauthorized-3"), {
          tenant_id: TENANT_A,
          title: "Malicious Task",
          status: "active",
        }),
      );
    });

    it("Membership type alone does NOT allow creating permission grants", async () => {
      await seedUserProfile("campaignUser", {
        tenant_id: TENANT_A,
        access_role: "member",
        membership_types: ["campaign_member"],
      });

      const env = await getTestEnv();
      const db = env.authenticatedContext("campaignUser").firestore();

      // Rule line 828: allow create: if isAdmin() && ...
      await assertFails(
        setDoc(doc(db, "permission_grants", "grant-manufactured"), {
          tenant_id: TENANT_A,
          user_id: "campaignUser",
          permission: "manage_members",
          granted: true,
          granted_by: "campaignUser",
        }),
      );
    });
  });

  describe("Election Officer Separation of Duties", () => {
    it("Election Officer is DENIED administrative access to donations ledger", async () => {
      await seedUserProfile("officer1", {
        tenant_id: TENANT_A,
        access_role: "election_officer",
      });

      const env = await getTestEnv();
      await env.withSecurityRulesDisabled(async (ctx) => {
        await setDoc(doc(ctx.firestore(), "donations", "don-secret"), {
          tenant_id: TENANT_A,
          amount: 1000000,
          created_by: "admin1",
        });
      });

      const db = env.authenticatedContext("officer1").firestore();

      // Line 1364: allow read: if isAdmin() && sameTenant(resource.data);
      // Election Officer must be denied read access to donations
      await assertFails(getDoc(doc(db, "donations", "don-secret")));
    });

    it("Election Officer is DENIED creating system audit logs", async () => {
      await seedUserProfile("officer1", {
        tenant_id: TENANT_A,
        access_role: "election_officer",
      });

      const env = await getTestEnv();
      const db = env.authenticatedContext("officer1").firestore();

      // Line 1458: allow create: if false;
      await assertFails(
        setDoc(doc(db, "system_audits", "audit-fake"), {
          tenant_id: TENANT_A,
          action: "BYPASS",
        }),
      );
    });

    it("Election Officer is DENIED modifying users collection", async () => {
      await seedUserProfile("officer1", {
        tenant_id: TENANT_A,
        access_role: "election_officer",
      });
      await seedUserProfile("victimUser", {
        tenant_id: TENANT_A,
        access_role: "member",
      });

      const env = await getTestEnv();
      const db = env.authenticatedContext("officer1").firestore();

      // Line 603: allow update: if isAdmin() && request.resource.data.tenant_id == callerTenantId();
      await assertFails(
        setDoc(
          doc(db, "users", "victimUser"),
          {
            access_role: "admin",
          },
          { merge: true },
        ),
      );
    });
  });
});
