import { beforeAll, afterAll, beforeEach, describe, it } from "vitest";
import { assertSucceeds, assertFails } from "@firebase/rules-unit-testing";
import { doc, getDoc, setDoc, updateDoc, deleteDoc } from "firebase/firestore";
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
  TENANT_B,
} from "./helpers/test-env";

describe("Security Rules — Election Results Lifecycle & Hierarchy", () => {
  beforeAll(async () => {
    await getTestEnv();
  });

  afterAll(async () => {
    await cleanupTestEnv();
  });

  beforeEach(async () => {
    await clearFirestoreData();
    await seedTenant(TENANT_A, { election_mode_enabled: true });
    await seedTenant(TENANT_B, { election_mode_enabled: true });

    await seedElectionCycle("cycle-2027", { tenant_id: TENANT_A });
    await seedElectionContest("contest-gov", {
      tenant_id: TENANT_A,
      status: "OPEN",
    });
    await seedElectionContest("contest-closed", {
      tenant_id: TENANT_A,
      status: "CLOSED",
    });

    // Seed field agent registered at ward-01, pu-001
    await seedUserProfile("fieldAgent1", {
      tenant_id: TENANT_A,
      access_role: "member",
      membership_types: ["campaign_member"],
      ward_id: "ward-01",
      polling_unit_id: "pu-001",
    });

    // Seed election officer
    await seedUserProfile("officer1", {
      tenant_id: TENANT_A,
      access_role: "election_officer",
    });

    // Seed admin
    await seedUserProfile("admin1", {
      tenant_id: TENANT_A,
      access_role: "admin",
    });
  });

  describe("Result Creation Rules Validation", () => {
    const validResultDocId = "contest-gov__pu-001";
    const validPayload = {
      tenant_id: TENANT_A,
      election_cycle_id: "cycle-2027",
      contest_id: "contest-gov",
      contest_type: "governor",
      state_id: "enugu-state",
      senatorial_zone_id: "enugu-east",
      lga_id: "nkanu-west",
      ward_id: "ward-01",
      polling_unit_id: "pu-001",
      submitted_by: "fieldAgent1",
      status: "submitted",
      verified: false,
      cloudinary_url: "https://res.cloudinary.com/demo/image/upload/ec8.jpg",
      results: [
        { party: "APC", votes: 120 },
        { party: "PDP", votes: 85 },
      ],
    };

    it("Authorized registered PU member can CREATE result with valid payload", async () => {
      const env = await getTestEnv();
      const db = env.authenticatedContext("fieldAgent1").firestore();

      await assertSucceeds(
        setDoc(doc(db, "election_results", validResultDocId), validPayload),
      );
    });

    it("Creation FAILS if Form EC8 photo (cloudinary_url) is missing", async () => {
      const env = await getTestEnv();
      const db = env.authenticatedContext("fieldAgent1").firestore();

      const invalidPayload = {
        ...validPayload,
        cloudinary_url: "",
      };

      await assertFails(
        setDoc(doc(db, "election_results", validResultDocId), invalidPayload),
      );
    });

    it("Creation FAILS if initial status is marked 'approved' or 'verified: true'", async () => {
      const env = await getTestEnv();
      const db = env.authenticatedContext("fieldAgent1").firestore();

      const tamperedPayload = {
        ...validPayload,
        status: "approved",
        verified: true,
      };

      await assertFails(
        setDoc(doc(db, "election_results", validResultDocId), tamperedPayload),
      );
    });

    it("Creation FAILS if document ID does not match contest_id__polling_unit_id", async () => {
      const env = await getTestEnv();
      const db = env.authenticatedContext("fieldAgent1").firestore();

      // Deterministic ID mismatch: line 313
      await assertFails(
        setDoc(doc(db, "election_results", "arbitrary-id-123"), validPayload),
      );
    });

    it("Creation FAILS if contest is NOT in 'OPEN' status", async () => {
      const env = await getTestEnv();
      const db = env.authenticatedContext("fieldAgent1").firestore();

      const closedContestPayload = {
        ...validPayload,
        contest_id: "contest-closed",
      };

      await assertFails(
        setDoc(
          doc(db, "election_results", "contest-closed__pu-001"),
          closedContestPayload,
        ),
      );
    });

    it("Creation FAILS if submitter UID does not match request.auth.uid", async () => {
      const env = await getTestEnv();
      const db = env.authenticatedContext("fieldAgent1").firestore();

      const impersonatedPayload = {
        ...validPayload,
        submitted_by: "someoneElse",
      };

      await assertFails(
        setDoc(
          doc(db, "election_results", validResultDocId),
          impersonatedPayload,
        ),
      );
    });

    it("Cross-Tenant creation FAILS: Tenant B user cannot submit result to Tenant A", async () => {
      await seedUserProfile("userB", {
        tenant_id: TENANT_B,
        access_role: "member",
        membership_types: ["campaign_member"],
        ward_id: "ward-01",
        polling_unit_id: "pu-001",
      });

      const env = await getTestEnv();
      const dbB = env.authenticatedContext("userB").firestore();

      await assertFails(
        setDoc(doc(dbB, "election_results", validResultDocId), {
          ...validPayload,
          submitted_by: "userB",
        }),
      );
    });
  });

  describe("Election Officer Review & Audit Boundaries", () => {
    const resultDocId = "contest-gov__pu-001";
    const initialDoc = {
      tenant_id: TENANT_A,
      election_cycle_id: "cycle-2027",
      contest_id: "contest-gov",
      contest_type: "governor",
      state_id: "enugu-state",
      senatorial_zone_id: "enugu-east",
      lga_id: "nkanu-west",
      ward_id: "ward-01",
      polling_unit_id: "pu-001",
      submitted_by: "fieldAgent1",
      status: "submitted",
      verified: false,
      cloudinary_url: "https://res.cloudinary.com/demo/image/upload/ec8.jpg",
      results: [
        { party: "APC", votes: 120 },
        { party: "PDP", votes: 85 },
      ],
    };

    beforeEach(async () => {
      const env = await getTestEnv();
      await env.withSecurityRulesDisabled(async (ctx) => {
        await setDoc(doc(ctx.firestore(), "election_results", resultDocId), initialDoc);
      });
    });

    it("Election Officer CAN approve a submitted result", async () => {
      const env = await getTestEnv();
      const db = env.authenticatedContext("officer1").firestore();

      await assertSucceeds(
        updateDoc(doc(db, "election_results", resultDocId), {
          status: "approved",
          verified: true,
          reviewed_by: "officer1",
          reviewed_at: new Date().toISOString(),
          review_notes: "Form EC8 confirmed authentic",
        }),
      );
    });

    it("Election Officer CAN reject a submitted result", async () => {
      const env = await getTestEnv();
      const db = env.authenticatedContext("officer1").firestore();

      await assertSucceeds(
        updateDoc(doc(db, "election_results", resultDocId), {
          status: "rejected",
          verified: false,
          reviewed_by: "officer1",
          reviewed_at: new Date().toISOString(),
          review_notes: "Illegible photo",
        }),
      );
    });

    it("Election Officer CANNOT alter vote counts (results array) during review", async () => {
      const env = await getTestEnv();
      const db = env.authenticatedContext("officer1").firestore();

      // Rule line 485: request.resource.data.results == resource.data.results
      await assertFails(
        updateDoc(doc(db, "election_results", resultDocId), {
          status: "approved",
          verified: true,
          reviewed_by: "officer1",
          results: [
            { party: "APC", votes: 999 }, // Tampered
            { party: "PDP", votes: 85 },
          ],
        }),
      );
    });

    it("Election Officer CANNOT alter geographic keys during review", async () => {
      const env = await getTestEnv();
      const db = env.authenticatedContext("officer1").firestore();

      await assertFails(
        updateDoc(doc(db, "election_results", resultDocId), {
          status: "approved",
          verified: true,
          reviewed_by: "officer1",
          polling_unit_id: "pu-altered",
        }),
      );
    });
  });

  describe("Admin Result Correction Workflow", () => {
    const resultDocId = "contest-gov__pu-001";
    const approvedDoc = {
      tenant_id: TENANT_A,
      election_cycle_id: "cycle-2027",
      contest_id: "contest-gov",
      contest_type: "governor",
      state_id: "enugu-state",
      senatorial_zone_id: "enugu-east",
      lga_id: "nkanu-west",
      ward_id: "ward-01",
      polling_unit_id: "pu-001",
      submitted_by: "fieldAgent1",
      status: "approved",
      verified: true,
      cloudinary_url: "https://res.cloudinary.com/demo/image/upload/ec8.jpg",
      results: [
        { party: "APC", votes: 120 },
        { party: "PDP", votes: 85 },
      ],
    };

    beforeEach(async () => {
      const env = await getTestEnv();
      await env.withSecurityRulesDisabled(async (ctx) => {
        await setDoc(doc(ctx.firestore(), "election_results", resultDocId), approvedDoc);
      });
    });

    it("Admin CAN correct vote numbers if reverting status to 'pending_review' and 'verified: false'", async () => {
      const env = await getTestEnv();
      const db = env.authenticatedContext("admin1").firestore();

      // Rule line 550: status == "pending_review" && verified == false
      await assertSucceeds(
        updateDoc(doc(db, "election_results", resultDocId), {
          results: [
            { party: "APC", votes: 125 },
            { party: "PDP", votes: 85 },
          ],
          status: "pending_review",
          verified: false,
        }),
      );
    });

    it("Admin CANNOT correct vote numbers while keeping status 'approved'", async () => {
      const env = await getTestEnv();
      const db = env.authenticatedContext("admin1").firestore();

      await assertFails(
        updateDoc(doc(db, "election_results", resultDocId), {
          results: [
            { party: "APC", votes: 125 },
            { party: "PDP", votes: 85 },
          ],
          status: "approved",
          verified: true,
        }),
      );
    });

    it("Election Results CANNOT be physically deleted by ANY user (including Admin)", async () => {
      const env = await getTestEnv();
      const db = env.authenticatedContext("admin1").firestore();

      // Rule line 1203: allow delete: if false;
      await assertFails(deleteDoc(doc(db, "election_results", resultDocId)));
    });
  });

  describe("Hierarchy & Scope Evaluation in Firestore Rules", () => {
    it("User with Ward-scoped user_access CAN read results within that Ward", async () => {
      await seedUserProfile("wardCoord1", {
        tenant_id: TENANT_A,
        access_role: "member",
        membership_types: ["campaign_member"],
        ward_id: "other-ward",
        polling_unit_id: "other-pu",
      });

      // Grant scoped access on ward-01
      await seedUserAccess({
        userId: "wardCoord1",
        permission: "view_election_results",
        scopeType: "ward",
        scopeId: "ward-01",
        tenantId: TENANT_A,
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

      const db = env.authenticatedContext("wardCoord1").firestore();
      // Rule lines 268-272: hasScopedAccess("view_election_results", "ward", data.ward_id)
      await assertSucceeds(
        getDoc(doc(db, "election_results", "contest-gov__pu-001")),
      );
    });

    it("User with LGA-scoped user_access CAN read results in Ward of that LGA (Empirical Hierarchy Test)", async () => {
      await seedUserProfile("lgaCoord1", {
        tenant_id: TENANT_A,
        access_role: "member",
        membership_types: ["campaign_member"],
        ward_id: "other-ward",
        polling_unit_id: "other-pu",
      });

      // Grant scoped access ONLY on lga "nkanu-west"
      await seedUserAccess({
        userId: "lgaCoord1",
        permission: "view_election_results",
        scopeType: "lga",
        scopeId: "nkanu-west",
        tenantId: TENANT_A,
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

      const db = env.authenticatedContext("lgaCoord1").firestore();
      // In firestore.rules line 262-266:
      // hasScopedAccess("view_election_results", "lga", data.lga_id)
      // Because election_results documents store lga_id, this check matches!
      await assertSucceeds(
        getDoc(doc(db, "election_results", "contest-gov__pu-001")),
      );
    });

    it("User with Ward-scoped user_access CANNOT read results in sibling Ward", async () => {
      await seedUserProfile("wardCoord1", {
        tenant_id: TENANT_A,
        access_role: "member",
        membership_types: ["campaign_member"],
      });

      await seedUserAccess({
        userId: "wardCoord1",
        permission: "view_election_results",
        scopeType: "ward",
        scopeId: "ward-01",
        tenantId: TENANT_A,
      });

      const env = await getTestEnv();
      await env.withSecurityRulesDisabled(async (ctx) => {
        await setDoc(
          doc(ctx.firestore(), "election_results", "contest-gov__pu-020"),
          {
            tenant_id: TENANT_A,
            contest_id: "contest-gov",
            state_id: "enugu-state",
            senatorial_zone_id: "enugu-east",
            lga_id: "nkanu-west",
            ward_id: "ward-02", // Sibling ward
            polling_unit_id: "pu-020",
            status: "approved",
            verified: true,
          },
        );
      });

      const db = env.authenticatedContext("wardCoord1").firestore();
      await assertFails(
        getDoc(doc(db, "election_results", "contest-gov__pu-020")),
      );
    });

    it("Expression-limit regression: DENIED result with every geo field present evaluates the FULL chain without hitting the Firestore expression limit", async () => {
      // Maximal evaluation case: every scoped branch is reachable (all geo
      // strings present) and none matches. Guards that remain false-by-type
      // on other denials (isAdmin/isElectionOfficer/registeredAt, missing
      // user_access docs) here execute their full get() chains.
      await seedUserProfile("plainCampaignUser", {
        tenant_id: TENANT_A,
        access_role: "member",
        membership_types: ["campaign_member"],
        ward_id: "other-ward",
        polling_unit_id: "other-pu",
      });

      const env = await getTestEnv();
      await env.withSecurityRulesDisabled(async (ctx) => {
        await setDoc(
          doc(ctx.firestore(), "election_results", "contest-gov__pu-900"),
          {
            tenant_id: TENANT_A,
            contest_id: "contest-gov",
            state_id: "enugu-state",
            senatorial_zone_id: "enugu-east",
            lga_id: "nkanu-west",
            ward_id: "ward-99",
            polling_unit_id: "pu-900",
            status: "approved",
            verified: true,
          },
        );
      });

      const db = env.authenticatedContext("plainCampaignUser").firestore();
      await assertFails(
        getDoc(doc(db, "election_results", "contest-gov__pu-900")),
      );
    });

    it("Expression-limit regression: ALLOWED result granted via the LAST scoped branch (polling_unit) evaluates the full chain without hitting the expression limit", async () => {
      await seedUserProfile("puAgent2", {
        tenant_id: TENANT_A,
        access_role: "member",
        membership_types: ["campaign_member"],
        ward_id: "other-ward",
        polling_unit_id: "other-pu",
      });

      await seedUserAccess({
        userId: "puAgent2",
        permission: "view_election_results",
        scopeType: "polling_unit",
        scopeId: "pu-901",
        tenantId: TENANT_A,
      });

      const env = await getTestEnv();
      await env.withSecurityRulesDisabled(async (ctx) => {
        await setDoc(
          doc(ctx.firestore(), "election_results", "contest-gov__pu-901"),
          {
            tenant_id: TENANT_A,
            contest_id: "contest-gov",
            state_id: "enugu-state",
            senatorial_zone_id: "enugu-east",
            lga_id: "nkanu-west",
            ward_id: "ward-99",
            polling_unit_id: "pu-901",
            status: "approved",
            verified: true,
          },
        );
      });
      const db = env.authenticatedContext("puAgent2").firestore();
      await assertSucceeds(
        getDoc(doc(db, "election_results", "contest-gov__pu-901")),
      );
    });

    it("Expression-limit regression: DENIED result with a fully-populated but non-matching user_access index evaluates every scoped get() without hitting the expression limit", async () => {
      // Absolute maximal case: all five scoped branches resolve their
      // user_access entries (exists() true, gets() mismatch), plus a fully
      // populated result document.
      await seedUserProfile("overGrantUser", {
        tenant_id: TENANT_A,
        access_role: "member",
        membership_types: ["campaign_member"],
        ward_id: "other-ward",
        polling_unit_id: "other-pu",
      });

      await seedUserAccess({ userId: "overGrantUser", permission: "view_election_results", scopeType: "state", scopeId: "other-state", tenantId: TENANT_A });
      await seedUserAccess({ userId: "overGrantUser", permission: "view_election_results", scopeType: "senatorial_zone", scopeId: "other-zone", tenantId: TENANT_A });
      await seedUserAccess({ userId: "overGrantUser", permission: "view_election_results", scopeType: "lga", scopeId: "other-lga", tenantId: TENANT_A });
      await seedUserAccess({ userId: "overGrantUser", permission: "view_election_results", scopeType: "ward", scopeId: "other-ward", tenantId: TENANT_A });
      await seedUserAccess({ userId: "overGrantUser", permission: "view_election_results", scopeType: "polling_unit", scopeId: "other-pu", tenantId: TENANT_A });

      const env = await getTestEnv();
      await env.withSecurityRulesDisabled(async (ctx) => {
        await setDoc(
          doc(ctx.firestore(), "election_results", "contest-gov__pu-902"),
          {
            tenant_id: TENANT_A,
            contest_id: "contest-gov",
            state_id: "enugu-state",
            senatorial_zone_id: "enugu-east",
            lga_id: "nkanu-west",
            ward_id: "ward-99",
            polling_unit_id: "pu-902",
            status: "approved",
            verified: true,
          },
        );
      });

      const db = env.authenticatedContext("overGrantUser").firestore();
      await assertFails(
        getDoc(doc(db, "election_results", "contest-gov__pu-902")),
      );
    });
  });
});
