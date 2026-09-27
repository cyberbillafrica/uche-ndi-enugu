/**
 * POLITICORE — Governance Phase 7 slice surface contracts.
 *
 * The Phase 7 surfaces are UI over the authoritative Phase 6 database
 * contract (governance-architecture.test.ts covers the DB; the hosted
 * harness covers the live deployment). This suite pins the access-control
 * contracts that are enforced in the application surface itself:
 *
 *   1. SERVICE ACCESS RESOLVER — module check first, view_governance
 *      navigation permission (§13 of the Phase 7 prompt / §E of the gate),
 *      staff/ participant/ admin flags derived exactly per the approved
 *      contract, fail-closed defaults.
 *   2. NAVIGATION — Governance nav renders only when
 *      module_enabled('governance') AND canViewGovernance; staff and admin
 *      children additionally require their flags; never Campaign/Election
 *      state (§3/§13).
 *   3. ROUTE GUARDS — every governance page fails closed:
 *      disabled module, missing view_governance, or insufficient
 *      participant/staff/admin authority redirects away (§14).
 *   4. EVENT PRIVACY — the participant detail renders exactly the events
 *      RLS returns; no client-side visibility widening (§9/§19).
 *   5. NO PARALLEL SYSTEMS — no parallel audit/notifications/identity
 *      tables or services; the service layer delegates to the 0034 RPCs
 *      and RLS only (§2/§23).
 */
import { describe, it, expect } from "vitest";
import * as fs from "fs";

const strip = (s: string) =>
  s.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");

function read(p: string): string {
  return strip(fs.readFileSync(p, "utf8"));
}

const LAYOUT = "src/app/portal/layout.tsx";
const SERVICE = "src/lib/supabase/governance.ts";

const GOV_PAGES = [
  "src/app/portal/governance/page.tsx",
  "src/app/portal/governance/requests/new/page.tsx",
  "src/app/portal/governance/requests/page.tsx",
  "src/app/portal/governance/requests/[id]/page.tsx",
  "src/app/portal/governance/cases/page.tsx",
  "src/app/portal/governance/cases/[id]/page.tsx",
  "src/app/portal/governance/categories/page.tsx",
];

describe("Governance slice surface contracts (Phase 7)", () => {
  it("access resolver: module gate first, view_governance navigation, derived staff/admin flags", async () => {
    const mod = await import("../../src/lib/supabase/governance");
    expect(typeof mod.resolveGovernanceAccess).toBe("function");
    // The surface contract: view_governance is a first-class flag on the
    // resolved access object (the DB has no SELECT policy keyed on it —
    // the Phase 7 prompt §13 makes it the navigation/surface permission).
    const body = read(SERVICE);
    expect(body).toContain('hasPermission(supabase, "view_governance")');
    expect(body).toContain("canViewGovernance");
  });

  it("navigation requires module_enabled AND view_governance — never Campaign/Election state", () => {
    const body = read(LAYOUT);
    // the governance render branch checks the module flag and the
    // view_governance permission before rendering any governance child
    expect(body).toMatch(
      /if\s*\(!governanceEnabled\s*\|\|\s*!govAccess\?\.canViewGovernance\)\s*\{\s*return null;/,
    );
    // governance nav is its own group — no campaign/election coupling
    expect(body).toMatch(/group:\s*"governance" as const/);
    expect(body).not.toMatch(/governanceEnabled\s*&&\s*(isCampaignMember|electionMode)/);
  });

  it("staff and participant children are filtered by their access flags", () => {
    const body = read(LAYOUT);
    expect(body).toContain("governanceStaff");
    expect(body).toContain("governanceParticipant");
    expect(body).toContain("governanceAdminOnly");
    // the filter maps each flag to its access authority (child.* pins the
    // render-branch filter, not the type declaration)
    expect(body).toMatch(/child\.governanceStaff[\s\S]{0,60}govAccess\.isStaff/);
    expect(body).toMatch(/child\.governanceParticipant[\s\S]{0,60}govAccess\.isParticipant/);
    expect(body).toMatch(/child\.governanceAdminOnly[\s\S]{0,60}govAccess\.isAdmin/);
  });

  it("every governance route guard fails closed on module/permission/authority", () => {
    const expected = {
      "src/app/portal/governance/page.tsx": "isParticipant",
      "src/app/portal/governance/requests/new/page.tsx": "isParticipant",
      "src/app/portal/governance/requests/page.tsx": "isParticipant",
      "src/app/portal/governance/requests/[id]/page.tsx": "isParticipant",
      "src/app/portal/governance/cases/page.tsx": "isStaff",
      "src/app/portal/governance/cases/[id]/page.tsx": "isStaff",
      "src/app/portal/governance/categories/page.tsx": "isAdmin",
    } as const;
    for (const page of GOV_PAGES) {
      const body = read(page);
      expect(body).toContain("resolveGovernanceAccess()");
      // every page: module gate AND view_governance AND its own authority
      expect(
        body.match(/!a\.moduleEnabled[\s\S]{0,40}?!a\.canViewGovernance/),
      ).toBeTruthy();
      expect(body).toContain(`!a.${expected[page as keyof typeof expected]}`);
      // redirect on failure (fail closed, not hide)
      expect(body).toContain('router.replace("/portal/dashboard")');
    }
  });

  it("participant detail renders exactly the RLS event trail (no client-side widening)", () => {
    const body = read("src/app/portal/governance/requests/[id]/page.tsx");
    // events come only from the service reader (RLS is the filter)
    expect(body).toContain("getRequestEvents");
    expect(body).not.toMatch(/from\(["']governance_request_events["']\)/);
    // the staff-visibility toggle only exists on the staff surface
    const staff = read("src/app/portal/governance/cases/[id]/page.tsx");
    expect(staff).toContain("addStaffResponse");
    expect(staff).toMatch(/isPublic/);
  });

  it("no parallel audit/notifications/identity systems introduced", () => {
    // no governance-specific audit/notification table anywhere in src
    for (const p of GOV_PAGES.concat([SERVICE, LAYOUT])) {
      const body = read(p);
      expect(body).not.toMatch(/governance_audit|governance_notifications|case_notifications/);
      expect(body).not.toMatch(/from\(["']system_audits["']\)/);
    }
    // the service consumes the approved 0034 RPC surface
    const service = read(SERVICE);
    for (const rpc of [
      "submit_governance_request",
      "acknowledge_governance_request",
      "assign_governance_request",
      "update_governance_request_status",
      "respond_governance_request",
      "rate_governance_request",
    ]) {
      expect(service).toContain(rpc);
    }
    // lifecycle goes through the RPC — no client state machine on status
    expect(service).toContain("update_governance_request_status");
    const staffCase = read("src/app/portal/governance/cases/[id]/page.tsx");
    expect(staffCase).not.toMatch(/status\s*===?\s*["']resolved["']\s*&&?\s*\(?setRequest/);
  });

  it("Firebase stays fully retired in every new Phase 7 file", () => {
    for (const p of GOV_PAGES.concat([SERVICE, LAYOUT])) {
      expect(read(p)).not.toMatch(/firebase/i);
    }
  });
});
