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

describe("Security Rules — Public vs Private Collections & Content Modules", () => {
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

    await seedUserProfile("userA", {
      tenant_id: TENANT_A,
      access_role: "member",
    });

    await seedUserProfile("userB", {
      tenant_id: TENANT_B,
      access_role: "member",
    });
  });

  describe("News Publishing Rules", () => {
    beforeEach(async () => {
      const env = await getTestEnv();
      await env.withSecurityRulesDisabled(async (ctx) => {
        await setDoc(doc(ctx.firestore(), "news", "news-published"), {
          tenant_id: TENANT_A,
          title: "Governor inspects ongoing projects",
          status: "published",
        });
        await setDoc(doc(ctx.firestore(), "news", "news-draft"), {
          tenant_id: TENANT_A,
          title: "Draft press statement",
          status: "draft",
        });
      });
    });

    it("Anonymous user CAN read published news", async () => {
      const env = await getTestEnv();
      const unauthDb = env.unauthenticatedContext().firestore();

      await assertSucceeds(getDoc(doc(unauthDb, "news", "news-published")));
    });

    it("Anonymous user CANNOT read draft/unpublished news", async () => {
      const env = await getTestEnv();
      const unauthDb = env.unauthenticatedContext().firestore();

      await assertFails(getDoc(doc(unauthDb, "news", "news-draft")));
    });

    it("Admin CAN read draft/unpublished news", async () => {
      const env = await getTestEnv();
      const db = env.authenticatedContext("admin1").firestore();

      await assertSucceeds(getDoc(doc(db, "news", "news-draft")));
    });

    it("Non-admin CANNOT create news article", async () => {
      const env = await getTestEnv();
      const db = env.authenticatedContext("userA").firestore();

      await assertFails(
        setDoc(doc(db, "news", "news-hacked"), {
          tenant_id: TENANT_A,
          title: "Fake News",
          status: "published",
        }),
      );
    });
  });

  describe("Public Taxonomies: Political Parties & Electoral Data", () => {
    beforeEach(async () => {
      const env = await getTestEnv();
      await env.withSecurityRulesDisabled(async (ctx) => {
        await setDoc(doc(ctx.firestore(), "political_parties", "apc"), {
          name: "All Progressives Congress",
          acronym: "APC",
        });
        await setDoc(doc(ctx.firestore(), "electoral_data", "enugu-state"), {
          state: "Enugu",
          lgas: 17,
        });
      });
    });

    it("Anonymous user CAN read political parties", async () => {
      const env = await getTestEnv();
      const unauthDb = env.unauthenticatedContext().firestore();

      await assertSucceeds(getDoc(doc(unauthDb, "political_parties", "apc")));
    });

    it("Anonymous user CAN read electoral_data taxonomy", async () => {
      const env = await getTestEnv();
      const unauthDb = env.unauthenticatedContext().firestore();

      await assertSucceeds(
        getDoc(doc(unauthDb, "electoral_data", "enugu-state")),
      );
    });

    it("Client write to electoral_data is FORBIDDEN for ALL (including Admin)", async () => {
      const env = await getTestEnv();
      const db = env.authenticatedContext("admin1").firestore();

      // Line 1540: allow write: if false;
      await assertFails(
        setDoc(doc(db, "electoral_data", "enugu-state"), {
          tampered: true,
        }),
      );
    });
  });

  describe("Contact Messages (Public Intake)", () => {
    it("Public unauthenticated visitor CAN create contact message with status 'unread'", async () => {
      const env = await getTestEnv();
      const unauthDb = env.unauthenticatedContext().firestore();

      // Line 1515: allow create if name, email, message are string and status == "unread"
      await assertSucceeds(
        setDoc(doc(unauthDb, "contact_messages", "msg-001"), {
          name: "Voter Inquirer",
          email: "voter@example.com",
          message: "When is the next rally?",
          status: "unread",
        }),
      );
    });

    it("Public visitor CANNOT create contact message with arbitrary administrative status", async () => {
      const env = await getTestEnv();
      const unauthDb = env.unauthenticatedContext().firestore();

      await assertFails(
        setDoc(doc(unauthDb, "contact_messages", "msg-002"), {
          name: "Voter Inquirer",
          email: "voter@example.com",
          message: "When is the next rally?",
          status: "resolved", // Forbidden
        }),
      );
    });

    it("Non-admin CANNOT read contact messages", async () => {
      const env = await getTestEnv();
      await env.withSecurityRulesDisabled(async (ctx) => {
        await setDoc(doc(ctx.firestore(), "contact_messages", "msg-private"), {
          name: "Confidential Citizen",
          email: "conf@example.com",
          message: "Private tip",
          status: "unread",
        });
      });

      const db = env.authenticatedContext("userA").firestore();
      await assertFails(getDoc(doc(db, "contact_messages", "msg-private")));
    });

    it("Admin CAN read contact messages", async () => {
      const env = await getTestEnv();
      await env.withSecurityRulesDisabled(async (ctx) => {
        await setDoc(doc(ctx.firestore(), "contact_messages", "msg-private"), {
          name: "Confidential Citizen",
          email: "conf@example.com",
          message: "Private tip",
          status: "unread",
        });
      });

      const db = env.authenticatedContext("admin1").firestore();
      await assertSucceeds(getDoc(doc(db, "contact_messages", "msg-private")));
    });
  });

  describe("Notifications Self-Update & Cross-Tenant Boundaries", () => {
    const notifId = "notif-001";

    beforeEach(async () => {
      const env = await getTestEnv();
      await env.withSecurityRulesDisabled(async (ctx) => {
        await setDoc(doc(ctx.firestore(), "notifications", notifId), {
          tenant_id: TENANT_A,
          title: "Rally Announcement",
          message: "Rally tomorrow at 10am",
          read_by: [],
          created_by: "admin1",
        });
      });
    });

    it("Same-tenant signed-in user CAN read notifications", async () => {
      const env = await getTestEnv();
      const db = env.authenticatedContext("userA").firestore();

      await assertSucceeds(getDoc(doc(db, "notifications", notifId)));
    });

    it("Cross-tenant user CANNOT read notifications", async () => {
      const env = await getTestEnv();
      const dbB = env.authenticatedContext("userB").firestore();

      await assertFails(getDoc(doc(dbB, "notifications", notifId)));
    });

    it("User CAN update notification to add own UID to read_by", async () => {
      const env = await getTestEnv();
      const db = env.authenticatedContext("userA").firestore();

      // Line 1490: allow update if diff affectedKeys hasOnly ["read_by"] and contains request.auth.uid
      await assertSucceeds(
        updateDoc(doc(db, "notifications", notifId), {
          read_by: ["userA"],
        }),
      );
    });

    it("User CANNOT alter notification content or message", async () => {
      const env = await getTestEnv();
      const db = env.authenticatedContext("userA").firestore();

      await assertFails(
        updateDoc(doc(db, "notifications", notifId), {
          message: "Hacked notification message",
        }),
      );
    });
  });

  describe("Tenant-Keyed Content: Gallery & Manifesto", () => {
    it("Admin CAN create gallery document when document ID matches tenant_id", async () => {
      const env = await getTestEnv();
      const db = env.authenticatedContext("admin1").firestore();

      // Line 763: allow create, update: if isAdmin() && tenantId == callerTenantId() && request.resource.data.tenant_id == tenantId;
      await assertSucceeds(
        setDoc(doc(db, "galleries", TENANT_A), {
          tenant_id: TENANT_A,
          images: ["https://res.cloudinary.com/demo/photo1.jpg"],
        }),
      );
    });

    it("Admin CANNOT create gallery document if document ID does not match tenant_id", async () => {
      const env = await getTestEnv();
      const db = env.authenticatedContext("admin1").firestore();

      // Document ID is "arbitrary-id" instead of "tenantA" -> fails tenantId == callerTenantId()
      await assertFails(
        setDoc(doc(db, "galleries", "arbitrary-id"), {
          tenant_id: TENANT_A,
          images: ["https://res.cloudinary.com/demo/photo1.jpg"],
        }),
      );
    });
  });
});
