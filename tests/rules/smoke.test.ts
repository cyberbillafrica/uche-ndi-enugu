import { readFileSync } from "fs";
import { resolve } from "path";
import { beforeAll, afterAll, beforeEach, describe, it } from "vitest";
import {
  initializeTestEnvironment,
  assertSucceeds,
  assertFails,
  RulesTestEnvironment,
} from "@firebase/rules-unit-testing";
import { doc, getDoc, setDoc } from "firebase/firestore";

const PROJECT_ID = "demo-politicore-test";

describe("Firestore Security Rules - Smoke Test", () => {
  let testEnv: RulesTestEnvironment;

  beforeAll(async () => {
    testEnv = await initializeTestEnvironment({
      projectId: PROJECT_ID,
      firestore: {
        host: "127.0.0.1",
        port: 8080,
        rules: readFileSync(resolve(__dirname, "../../firestore.rules"), "utf8"),
      },
    });
  });

  afterAll(async () => {
    if (testEnv) {
      await testEnv.cleanup();
    }
  });

  beforeEach(async () => {
    if (testEnv) {
      await testEnv.clearFirestore();
    }
  });

  it("Test A (Allowed): Authenticated user can self-register their own profile with member role and 0 points", async () => {
    const userId = "user-smoke-1";
    const authContext = testEnv.authenticatedContext(userId);
    const db = authContext.firestore();

    const userProfileRef = doc(db, "users", userId);

    // Rule: firestore.rules lines 578-582:
    // allow create: if isOwner(userId)
    //   && request.resource.data.access_role == "member"
    //   && request.resource.data.points == 0
    //   && request.resource.data.tenant_id is string;
    await assertSucceeds(
      setDoc(userProfileRef, {
        access_role: "member",
        points: 0,
        tenant_id: "ifeanyi-2027",
        email: "smoke1@example.com",
        full_name: "Smoke Test User",
      }),
    );

    // Rule: firestore.rules lines 574-575:
    // allow read: if isAdmin() || isOwner(userId);
    await assertSucceeds(getDoc(userProfileRef));
  });

  it("Test B (Denied): Unauthenticated user cannot read a private user profile", async () => {
    const userId = "user-smoke-1";

    // Pre-populate user profile using rules-disabled admin context
    await testEnv.withSecurityRulesDisabled(async (context) => {
      const adminDb = context.firestore();
      await setDoc(doc(adminDb, "users", userId), {
        access_role: "member",
        points: 0,
        tenant_id: "ifeanyi-2027",
        email: "smoke1@example.com",
        full_name: "Smoke Test User",
      });
    });

    const unauthContext = testEnv.unauthenticatedContext();
    const unauthDb = unauthContext.firestore();

    const userProfileRef = doc(unauthDb, "users", userId);

    // Rule: unauthenticated access must be denied
    await assertFails(getDoc(userProfileRef));
  });

  it("Test B2 (Denied): Authenticated user cannot elevate self to admin during profile creation", async () => {
    const userId = "user-malicious";
    const authContext = testEnv.authenticatedContext(userId);
    const db = authContext.firestore();

    const userProfileRef = doc(db, "users", userId);

    // Rule: strictly requires access_role == "member"
    await assertFails(
      setDoc(userProfileRef, {
        access_role: "admin",
        points: 0,
        tenant_id: "ifeanyi-2027",
        email: "attacker@example.com",
      }),
    );
  });
});
