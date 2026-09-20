import { beforeAll, afterAll, beforeEach, describe, it } from "vitest";
import { assertSucceeds, assertFails } from "@firebase/rules-unit-testing";
import { doc, getDoc, setDoc, updateDoc } from "firebase/firestore";
import {
  getTestEnv,
  clearFirestoreData,
  cleanupTestEnv,
  seedTenant,
  seedUserProfile,
  TENANT_A,
  TENANT_B,
} from "./helpers/test-env";

describe("Security Rules — Identity, Ownership & Tenancy", () => {
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

  describe("Anonymous Access Boundaries", () => {
    it("Anonymous user is DENIED reading private user profiles", async () => {
      await seedUserProfile("userA1", { tenant_id: TENANT_A });
      const env = await getTestEnv();
      const unauthDb = env.unauthenticatedContext().firestore();

      await assertFails(getDoc(doc(unauthDb, "users", "userA1")));
    });

    it("Anonymous user is DENIED reading donations", async () => {
      const env = await getTestEnv();
      await env.withSecurityRulesDisabled(async (ctx) => {
        await setDoc(doc(ctx.firestore(), "donations", "don-1"), {
          tenant_id: TENANT_A,
          amount: 50000,
        });
      });

      const unauthDb = env.unauthenticatedContext().firestore();
      await assertFails(getDoc(doc(unauthDb, "donations", "don-1")));
    });

    it("Anonymous user is DENIED reading operational tasks", async () => {
      const env = await getTestEnv();
      await env.withSecurityRulesDisabled(async (ctx) => {
        await setDoc(doc(ctx.firestore(), "tasks", "task-1"), {
          tenant_id: TENANT_A,
          status: "active",
        });
      });

      const unauthDb = env.unauthenticatedContext().firestore();
      await assertFails(getDoc(doc(unauthDb, "tasks", "task-1")));
    });
  });

  describe("User Ownership & Profile Protection", () => {
    it("Owner can read their own user profile", async () => {
      await seedUserProfile("userA1", {
        tenant_id: TENANT_A,
        access_role: "member",
      });
      const env = await getTestEnv();
      const db = env.authenticatedContext("userA1").firestore();

      await assertSucceeds(getDoc(doc(db, "users", "userA1")));
    });

    it("Non-admin user is DENIED reading another user's profile in the same tenant", async () => {
      await seedUserProfile("userA1", { tenant_id: TENANT_A });
      await seedUserProfile("userA2", { tenant_id: TENANT_A });

      const env = await getTestEnv();
      const db = env.authenticatedContext("userA2").firestore();

      await assertFails(getDoc(doc(db, "users", "userA1")));
    });

    it("Owner is DENIED elevating their own access_role to admin", async () => {
      await seedUserProfile("userA1", {
        tenant_id: TENANT_A,
        access_role: "member",
        membership_types: ["campaign_member"],
        points: 0,
        rank: "Volunteer",
      });

      const env = await getTestEnv();
      const db = env.authenticatedContext("userA1").firestore();

      // Rule line 590: allow update if access_role, tenant_id, membership_types, points, rank match existing resource
      await assertFails(
        updateDoc(doc(db, "users", "userA1"), {
          access_role: "admin",
        }),
      );
    });

    it("Owner is DENIED changing their own tenant_id", async () => {
      await seedUserProfile("userA1", {
        tenant_id: TENANT_A,
        access_role: "member",
        membership_types: ["campaign_member"],
        points: 0,
        rank: "Volunteer",
      });

      const env = await getTestEnv();
      const db = env.authenticatedContext("userA1").firestore();

      await assertFails(
        updateDoc(doc(db, "users", "userA1"), {
          tenant_id: TENANT_B,
        }),
      );
    });

    it("Owner is DENIED manipulating their own points", async () => {
      await seedUserProfile("userA1", {
        tenant_id: TENANT_A,
        access_role: "member",
        membership_types: ["social_member"],
        points: 10,
        rank: "Volunteer",
      });

      const env = await getTestEnv();
      const db = env.authenticatedContext("userA1").firestore();

      await assertFails(
        updateDoc(doc(db, "users", "userA1"), {
          points: 9999,
        }),
      );
    });
  });

  describe("Two-Tenant Cross-Boundary Isolation", () => {
    it("Tenant B user is DENIED reading Tenant A user profile", async () => {
      await seedUserProfile("userA1", { tenant_id: TENANT_A });
      await seedUserProfile("userB1", { tenant_id: TENANT_B });

      const env = await getTestEnv();
      const dbB = env.authenticatedContext("userB1").firestore();

      await assertFails(getDoc(doc(dbB, "users", "userA1")));
    });

    it("CORRECTED F-TENANT-01: Tenant B Admin is DENIED reading Tenant A user profile", async () => {
      await seedUserProfile("userA1", { tenant_id: TENANT_A });
      await seedUserProfile("adminB", {
        tenant_id: TENANT_B,
        access_role: "admin",
      });

      const env = await getTestEnv();
      const dbB = env.authenticatedContext("adminB").firestore();

      // CORRECTED F-TENANT-01: Admin reads now require
      // resource.data.tenant_id == callerTenantId(); isOwner() is preserved.
      await assertFails(getDoc(doc(dbB, "users", "userA1")));
    });

    it("Tenant B Admin can still read an authorized Tenant B user profile", async () => {
      await seedUserProfile("userB1", { tenant_id: TENANT_B });
      await seedUserProfile("adminB", {
        tenant_id: TENANT_B,
        access_role: "admin",
      });

      const env = await getTestEnv();
      const dbB = env.authenticatedContext("adminB").firestore();

      // Same-tenant Admin read remains intact after the fix.
      await assertSucceeds(getDoc(doc(dbB, "users", "userB1")));
    });

    it("Tenant B user is DENIED reading Tenant A public leaderboard projection", async () => {
      const env = await getTestEnv();
      await env.withSecurityRulesDisabled(async (ctx) => {
        await setDoc(doc(ctx.firestore(), "leaderboard_public", "lead-A1"), {
          tenant_id: TENANT_A,
          user_id: "userA1",
          points: 50,
          display_name: "User A1",
        });
      });

      await seedUserProfile("userB1", { tenant_id: TENANT_B });
      const dbB = env.authenticatedContext("userB1").firestore();

      // Rule line 620: allow read: if isSignedIn() && sameTenant(resource.data);
      await assertFails(
        getDoc(doc(dbB, "leaderboard_public", "lead-A1")),
      );
    });

    it("Tenant B user is DENIED creating an organizational assignment in Tenant A", async () => {
      await seedUserProfile("adminB", {
        tenant_id: TENANT_B,
        access_role: "admin",
      });

      const env = await getTestEnv();
      const dbB = env.authenticatedContext("adminB").firestore();

      // Rule line 803: allow create: if isAdmin() && newDataSameTenant();
      // adminB is callerTenantId() == "tenantB", so request.resource.data.tenant_id == "tenantA" must fail!
      await assertFails(
        setDoc(doc(dbB, "organizational_assignments", "asgn-cross"), {
          tenant_id: TENANT_A,
          user_id: "userA1",
          position: "ward_coordinator",
          scope_type: "ward",
          scope_id: "ward-01",
          status: "active",
        }),
      );
    });
  });
});
