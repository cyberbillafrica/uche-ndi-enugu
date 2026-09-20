import { beforeAll, afterAll, beforeEach, describe, it } from "vitest";
import { assertSucceeds, assertFails } from "@firebase/rules-unit-testing";
import { doc, getDoc } from "firebase/firestore";
import {
  getTestEnv,
  clearFirestoreData,
  cleanupTestEnv,
  seedTenant,
  seedUserProfile,
  seedElectionCandidate,
  TENANT_A,
  TENANT_B,
} from "./helpers/test-env";

describe("Security Rules — Election Candidates Read Boundary", () => {
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
    await seedElectionCandidate("candidate-gov-1", {
      tenant_id: TENANT_A,
      contest_id: "contest-gov",
    });
  });

  describe("Social-Only Boundary", () => {
    beforeEach(async () => {
      await seedUserProfile("socialOnlyUser", {
        tenant_id: TENANT_A,
        access_role: "member",
        membership_types: ["social_member"],
      });
    });

    it("CORRECTED F-ELECT-04: Social-only member is DENIED reading election_candidates", async () => {
      const env = await getTestEnv();
      const db = env.authenticatedContext("socialOnlyUser").firestore();

      // Same boundary as election_cycles / election_contests / election_settings:
      // !isSocialOnly() is required on read.
      await assertFails(getDoc(doc(db, "election_candidates", "candidate-gov-1")));
    });
  });

  describe("Legitimate Election Access Preserved", () => {
    it("Campaign Member CAN read an election candidate", async () => {
      await seedUserProfile("campaignUser", {
        tenant_id: TENANT_A,
        access_role: "member",
        membership_types: ["campaign_member"],
      });

      const env = await getTestEnv();
      const db = env.authenticatedContext("campaignUser").firestore();

      await assertSucceeds(
        getDoc(doc(db, "election_candidates", "candidate-gov-1")),
      );
    });

    it("Dual member (social + campaign) is NOT treated as social-only", async () => {
      await seedUserProfile("dualUser", {
        tenant_id: TENANT_A,
        access_role: "member",
        membership_types: ["social_member", "campaign_member"],
      });

      const env = await getTestEnv();
      const db = env.authenticatedContext("dualUser").firestore();

      await assertSucceeds(
        getDoc(doc(db, "election_candidates", "candidate-gov-1")),
      );
    });

    it("Election Officer CAN read an election candidate", async () => {
      await seedUserProfile("officer1", {
        tenant_id: TENANT_A,
        access_role: "election_officer",
      });

      const env = await getTestEnv();
      const db = env.authenticatedContext("officer1").firestore();

      await assertSucceeds(
        getDoc(doc(db, "election_candidates", "candidate-gov-1")),
      );
    });

    it("Admin CAN read an election candidate", async () => {
      await seedUserProfile("admin1", {
        tenant_id: TENANT_A,
        access_role: "admin",
      });

      const env = await getTestEnv();
      const db = env.authenticatedContext("admin1").firestore();

      await assertSucceeds(
        getDoc(doc(db, "election_candidates", "candidate-gov-1")),
      );
    });

    it("Cross-tenant read remains DENIED for a Tenant B campaign member", async () => {
      await seedUserProfile("userB", {
        tenant_id: TENANT_B,
        access_role: "member",
        membership_types: ["campaign_member"],
      });

      const env = await getTestEnv();
      const dbB = env.authenticatedContext("userB").firestore();

      // sameTenant(resource.data) must fail — the social-only fix does not
      // alter tenant isolation.
      await assertFails(
        getDoc(doc(dbB, "election_candidates", "candidate-gov-1")),
      );
    });
  });
});
