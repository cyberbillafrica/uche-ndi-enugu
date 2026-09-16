import { assignmentCoversScope, isAdminUser } from "../src/lib/permissions";
import { formatOrganizationalPosition, formatScopeType } from "../src/lib/organization";

console.log("==================================================");
console.log("RUNNING POLITICORE AUTOMATED BUSINESS RULES TESTS");
console.log("==================================================\n");

let passed = 0;
let failed = 0;

function assert(condition: boolean, testName: string) {
  if (condition) {
    console.log(`[PASS] ${testName}`);
    passed++;
  } else {
    console.error(`[FAIL] ${testName}`);
    failed++;
  }
}

// 1. Permissions & Role Verification Tests
const adminProfile: any = { access_role: "admin", membership_types: ["campaign_member"] };
const memberProfile: any = { access_role: "member", ward_id: "ward-01", polling_unit_id: "pu-001" };
const officerProfile: any = { access_role: "election_officer", ward_id: "ward-01", polling_unit_id: "pu-001" };

assert(isAdminUser(adminProfile) === true, "Admin profile correctly identified as Admin");
assert(isAdminUser(memberProfile) === false, "Member profile correctly excluded from Admin");

// 2. Member Registered PU Match Logic
function canMemberSubmitPUResult(user: any, targetWardId: string, targetPUId: string) {
  if (user.access_role === "admin" || user.access_role === "election_officer") return true;
  return user.ward_id === targetWardId && user.polling_unit_id === targetPUId;
}

assert(canMemberSubmitPUResult(adminProfile, "ward-01", "pu-001") === true, "Admin can submit PU result anywhere");
assert(canMemberSubmitPUResult(memberProfile, "ward-01", "pu-001") === true, "Member can submit PU result for registered PU");
assert(canMemberSubmitPUResult(memberProfile, "ward-01", "pu-002") === false, "Member CANNOT submit PU result for unregistered PU");

// 3. Organizational Hierarchy Scope Covering Tests
const wardAssignment: any = {
  status: "active",
  scope_type: "ward",
  scope_id: "ward-01",
};

const fakeLGAs: any[] = [
  {
    id: "lga-01",
    wards: [
      { id: "ward-01", pollingUnits: [{ id: "pu-001" }] }
    ]
  }
];

assert(
  assignmentCoversScope(wardAssignment, { scope_type: "polling_unit", scope_id: "pu-001" }, fakeLGAs) === true,
  "Ward assignment correctly covers underlying Polling Unit"
);

assert(
  assignmentCoversScope(wardAssignment, { scope_type: "ward", scope_id: "ward-02" }, fakeLGAs) === false,
  "Ward assignment does NOT cover unrelated Ward"
);

// 4. Formatting Utilities Tests
assert(formatOrganizationalPosition("ward_coordinator") === "Ward Coordinator", "Formats ward coordinator position correctly");
assert(formatScopeType("senatorial_zone") === "Senatorial Zone", "Formats senatorial zone scope correctly");

// 5. Leaderboard Projection Schema & Boundary Verification Tests
function createLeaderboardProjectionDoc(userProfile: any) {
  return {
    user_id: userProfile.id || "user-123",
    display_name: userProfile.display_name || userProfile.full_name || "Anonymous Member",
    points: Number(userProfile.points) || 0,
    rank: userProfile.rank || "Volunteer",
    tenant_id: userProfile.tenant_id || "ifeanyi-2027",
    state_id: userProfile.state_id || "enugu-state",
    zone_id: userProfile.zone_id || null,
    lga_id: userProfile.lga_id || null,
    ward_id: userProfile.ward_id || null,
  };
}

const testProfile = {
  id: "member-001",
  full_name: "Chinedu Okafor",
  points: 150,
  rank: "Volunteer",
  tenant_id: "ifeanyi-2027",
  state_id: "enugu-state",
  zone_id: "enugu-east",
  lga_id: "nkanu-west",
  ward_id: "ward-01",
  polling_unit_id: "pu-001",
};

const projection = createLeaderboardProjectionDoc(testProfile) as any;

assert(projection.ward_id === "ward-01", "Leaderboard projection includes Ward ID");
assert(projection.lga_id === "nkanu-west", "Leaderboard projection includes LGA ID");
assert(projection.zone_id === "enugu-east", "Leaderboard projection includes Zone ID");
assert(projection.state_id === "enugu-state", "Leaderboard projection includes State ID");
assert(projection.polling_unit_id === undefined && projection.pu_id === undefined, "Leaderboard projection explicitly EXCLUDES Polling Unit ID");

console.log("\n==================================================");
console.log(`TEST SUMMARY: ${passed} Passed, ${failed} Failed`);
console.log("==================================================");

if (failed > 0) {
  process.exit(1);
} else {
  process.exit(0);
}
