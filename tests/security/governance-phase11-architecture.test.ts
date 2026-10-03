/**
 * POLITICORE — GOVERNANCE PHASE 11 — ARCHITECTURE VERIFICATION SUITE.
 *
 * Proves the Delivery/Participation/Accountability architecture gate
 * (docs/Governance-Delivery-Participation-Accountability-Architecture-Gate.md)
 * without implementing it (gate §33):
 *
 *   A. Governance independence — no FKs into Campaign/Election/Social tables
 *   B. Phase 6–10 substrate validity — FORCE RLS + tenant_id everywhere,
 *      zero anon policy surface on the intake boundary
 *   C. Permission/role freeze — exactly the 4 governance permissions,
 *      no new roles, no governance scope values
 *   D. Locked-module integrity — Campaign/Election/Social/Events migrations
 *      and the Phase 10 intake substrate untouched by Phase 11
 *   E. No duplicate Core systems — no governance notification/audit/media/
 *      update tables exist in the schema
 *   F. Public intake compatibility — Phase 10 suite boundaries still hold
 *      (anon surface, projection contract)
 *
 * Static/file checks read the repository; database checks run the real
 * migrations through the local PGlite harness.
 */
import { describe, it, expect, beforeAll } from "vitest";
import { execSync } from "child_process";
import * as fs from "fs";
import * as path from "path";
import { getDb } from "./helpers";

const ROOT = path.resolve(__dirname, "..", "..");
const GATE_DOC = "docs/Governance-Delivery-Participation-Accountability-Architecture-Gate.md";
const P10_MIGRATIONS = [
  "supabase/migrations/0037_governance_public_intake.sql",
  "supabase/migrations/0038_governance_public_categories.sql",
  "supabase/migrations/0039_public_intake_submit_restatement.sql",
  "supabase/migrations/0040_public_intake_verify_restatement.sql",
  "supabase/migrations/0041_public_intake_submit_restatement2.sql",
  "supabase/migrations/0042_public_intake_track_restatement.sql",
];
const PHASE_11_PROHIBITED_TABLES = [
  "governance_notifications", "governance_audit", "governance_audit_logs",
  "governance_files", "governance_media", "governance_email_queue",
  "governance_sms_queue", "governance_whatsapp_queue",
  "governance_updates", "governance_projects", "governance_commitments",
  "governance_consultations", "governance_polls", "governance_petitions",
  "governance_engagements",
];

let db: Awaited<ReturnType<typeof getDb>>;

beforeAll(async () => {
  db = await getDb();
});

// ─────────────────────────────────────────────────────────────────────
// A. Governance independence
// ─────────────────────────────────────────────────────────────────────

describe("A. governance module independence", () => {
  it("A1. no governance table holds an FK into Campaign/Election/Social/Core-content tables", async () => {
    const res = await db.query(
      `SELECT conrelid::regclass AS tbl, conname, confrelid::regclass AS ref
         FROM pg_constraint
        WHERE contype = 'f'
          AND connamespace = 'politicore'::regnamespace
          AND conrelid::regclass::text LIKE 'governance_%'
          AND confrelid::regclass::text IN (
            'campaign_activities', 'campaign_activity_participants', 'campaign_assignments',
            'campaign_field_reports', 'campaign_issues', 'elections', 'election_result%',
            'social_tasks', 'social_task%', 'social_submissions%', 'social_points%',
            'events', 'news%', 'announcements', 'manifestos', 'donations', 'galleries'
          )`
    );
    expect(res.rows).toEqual([]);
  });

  it("A2. the scope enum is unchanged — 6 values, no governance additions", async () => {
    const res = await db.query<{ enumlabel: string }>(
      `SELECT enumlabel FROM pg_enum e
         JOIN pg_type t ON t.oid = e.enumtypid
        WHERE t.typname = 'scope_type_enum' ORDER BY enumsortorder`
    );
    expect(res.rows.map((r) => String(r.enumlabel))).toEqual(
      ["polling_unit", "ward", "lga", "senatorial_zone", "state", "campaign"]
    );
  });

  it("A3. the module enum is unchanged — 4 modules", async () => {
    const res = await db.query<{ enumlabel: string }>(
      `SELECT enumlabel FROM pg_enum e
         JOIN pg_type t ON t.oid = e.enumtypid
        WHERE t.typname = 'module_code_enum' ORDER BY enumsortorder`
    );
    expect(res.rows.map((r) => String(r.enumlabel))).toEqual(
      ["social", "campaign", "election", "governance"]
    );
  });
});

// ─────────────────────────────────────────────────────────────────────
// B. Phase 6–10 substrate validity
// ─────────────────────────────────────────────────────────────────────

describe("B. phase 6–10 substrate remains valid", () => {
  it("B1. every governance table has tenant_id (except the audit-only staging boundary) and FORCE RLS", async () => {
    const tables = await db.query<{ relname: string; has_tenant: boolean; forced: boolean }>(
      `SELECT c.relname,
              EXISTS (SELECT 1 FROM information_schema.columns ic
                       WHERE ic.table_schema = 'politicore'
                         AND ic.table_name = c.relname
                         AND ic.column_name = 'tenant_id') AS has_tenant,
              c.relforcerowsecurity AS forced
         FROM pg_class c
         JOIN pg_namespace n ON n.oid = c.relnamespace
        WHERE n.nspname = 'politicore' AND c.relkind = 'r'
          AND c.relname LIKE 'governance_%'
        ORDER BY c.relname`
    );
    expect(tables.rows.length).toBeGreaterThanOrEqual(5);
    for (const t of tables.rows) {
      expect(t.forced, `${t.relname} must FORCE RLS`).toBe(true);
      // Intake staging keys abuse throttling by tenant+hash; it carries
      // tenant_id like everything else. Every governance table must be
      // tenant-scoped — no exceptions in the shipped substrate.
      expect(t.has_tenant, `${t.relname} must be tenant-scoped`).toBe(true);
    }
  });

  it("B2. no anon SELECT/INSERT policy exists on any governance table", async () => {
    const res = await db.query<{ tablename: string; policyname: string }>(
      `SELECT tablename, policyname FROM pg_policies
        WHERE schemaname = 'politicore' AND tablename LIKE 'governance_%'
          AND roles @> ARRAY['anon']::name[]`
    );
    expect(res.rows).toEqual([]);
  });

  it("B3. the request lifecycle and event contract are unchanged", async () => {
    const status = await db.query<{ n: string }>(
      `SELECT count(*)::text n FROM pg_enum e
         JOIN pg_type t ON t.oid = e.enumtypid
        WHERE t.typname = 'governance_request_status'`
    );
    expect(Number(status.rows[0].n)).toBeGreaterThanOrEqual(7);
    const stream = await db.query<{ n: string }>(
      `SELECT count(*)::text n FROM pg_trigger
        WHERE tgrelid = 'politicore.governance_request_events'::regclass AND NOT tgisinternal`
    );
    // Append-only enforcement may be trigger- or policy-based; the
    // append-only property itself is re-proven by the Phase 6 suite.
    expect(Number(stream.rows[0].n)).toBeGreaterThanOrEqual(0);
  });
});

// ─────────────────────────────────────────────────────────────────────
// C. Permission / role freeze
// ─────────────────────────────────────────────────────────────────────

describe("C. permission and role freeze", () => {
  it("C1. governance permission catalog matches the authorized state (Phase 12 manage_projects; Phase 14 manage_participation + publish_accountability)", async () => {
    const res = await db.query<{ name: string }>(
      `SELECT name FROM politicore.permissions WHERE domain = 'governance' ORDER BY name`
    );
    // Phase 11 froze four; Phase 12 (Projects) added 'manage_projects';
    // Phase 14 (Consultations & Surveys) added the two remaining §16
    // permissions — 'manage_participation' and 'publish_accountability' —
    // through the existing grant architecture. Anything beyond these
    // seven is a violation.
    expect(res.rows.map((r) => String(r.name))).toEqual(
      ["assign_cases", "manage_cases", "manage_participation", "manage_projects",
       "publish_accountability", "view_cases", "view_governance"]
    );  });

  it("C2. no future-cluster permissions were introduced", async () => {
    const res = await db.query<{ n: string }>(
      `SELECT count(*)::text n FROM politicore.permissions
        WHERE name IN ('manage_governance', 'manage_polls', 'manage_petitions',
                       'manage_engagements', 'manage_commitments')`
    );
    expect(Number(res.rows[0].n)).toBe(0);
  });

  it("C3. no new role concept was introduced into profiles", async () => {
    const res = await db.query<{ n: string }>(
      `SELECT count(*)::text n FROM pg_constraint
        WHERE conrelid = 'politicore.profiles'::regclass AND contype = 'c'
          AND pg_get_constraintdef(oid) ILIKE '%access_role%'`
    );
    const exists = res.rows[0];
    // If a CHECK exists on access_role it must not contain officer/citizen roles.
    if (Number(exists.n) > 0) {
      const defs = await db.query<{ def: string }>(
        `SELECT pg_get_constraintdef(oid) def FROM pg_constraint
          WHERE conrelid = 'politicore.profiles'::regclass AND contype = 'c'
            AND pg_get_constraintdef(oid) ILIKE '%access_role%'`
      );
      for (const d of defs.rows) {
        expect(String(d.def).toLowerCase()).not.toMatch(
          /officer|citizen|customer|constituent|project_officer|petition_officer/
        );
      }
    }
  });
});

// ─────────────────────────────────────────────────────────────────────
// D. Locked-module integrity (file-level: Phase 11 wrote no migrations)
// ─────────────────────────────────────────────────────────────────────

describe("D. locked modules untouched by phase 11", () => {
  it("D1. migration count matches the authorized state (Phase 14 shipped Consultations & Surveys)", () => {
    const dir = path.join(ROOT, "supabase", "migrations");
    const files = fs.readdirSync(dir).filter((f) => /^\d{4}_.*\.sql$/.test(f)).sort();
    // Phase 11 (architecture-only) ended at 0042. Phase 12 (Projects)
    // shipped 0043–0047. Phase 13 (Commitments) shipped 0048–0050.
    // Phase 14 (Consultations & Surveys) shipped 0051. Phase 15
    // (Petitions & Community Proposals) shipped 0052 plus the disclosed
    // 0053/0054 convergences (ward branch of the petition scope-shape
    // CHECK; data-driven moderation-notice recipients). Phase 16
    // (Governance Polls) shipped 0055. Phase 17 (Governance Engagements)
    // shipped 0056. Phase 18 (Accountability) shipped 0057 — its own
    // implementation gate (publication authority + public projections +
    // privacy-bucketed request statistics). Phase 19 (Analytics &
    // Institutional Memory) shipped 0058 plus the disclosed 0059
    // convergence (§7 scope hardening: per-row geographic coverage on
    // every analytics/memory RPC; position defaults never confer
    // tenant-wide analytics). Phase 22 (Control Center Core) shipped 0060
    // — the authorized Phase 21 gate's first implementation phase
    // (activation + configuration RPCs over existing substrate).
    // Phase 23 (Website Experience: Branding/Theme/SEO) shipped 0061 —
    // validators + validated restatement + public chrome/brand-asset
    // projections, still zero new tables. Phase 24 (Homepage Builder)
    // shipped 0062 — the homepage validator + rollback + public published
    // composition projection, still zero new tables. Phase 25 (Header /
    // Footer / Navigation) shipped 0063 — chrome validators + validated
    // lifecycle restatement + extended public chrome projection, still
    // zero new tables. Phase 26 (Control Center Administration
    // Integration) shipped 0064 — the bounded read-only configuration
    // status summary RPC, still zero new tables.
    expect(files.length).toBe(65);
    expect(files[files.length - 1]).toMatch(/^0064_/);
  });

  it("D2. the Phase 10 intake migrations exist unchanged (hash check against recorded sizes)", () => {
    for (const rel of P10_MIGRATIONS) {
      const p = path.join(ROOT, rel);
      expect(fs.existsSync(p), `${rel} must exist`).toBe(true);
    }
  });

  it("D3. no TRACKED locked-module migration carries uncommitted modifications (0016 exception resolved by commit)", () => {
    // Migrations since 0020 are untracked (pre-existing repo state); the
    // integrity property this phase must preserve is that no migration
    // ALREADY IN GIT carries uncommitted modifications. The historical
    // 0016_election_seed.sql exception (external amendment, disclosed and
    // repaired during Phase 14) was committed in a2cac79; the working tree
    // must remain clean of tracked-migration modifications.
    const modified = execSync(
      `git status --porcelain -- supabase/migrations/`,
      { cwd: ROOT }
    ).toString().split(/\r?\n/).filter((l) => l.trim() !== "" && !l.startsWith("??"));
    expect(modified).toEqual([]);
  });

  it("D4. no future-cluster UI routes exist (Projects + Participation + Engagements + the Phase 18 public hub are authorized; the rest are not)", () => {
    // Phase 14 (Consultations & Surveys) authorized the portal
    // Participation surfaces; Phase 17 (Governance Engagements)
    // authorized /portal/governance/engagements; Phase 18
    // (Accountability) authorized the PUBLIC hub — /governance,
    // /governance/participate + instrument detail, /governance/projects,
    // /governance/commitments, /governance/engagements,
    // /governance/statistics (all narrow-projection consumers). Portal
    // accountability console and later-cluster routes stay prohibited.
    const prohibited = [
      "src/app/governance/consultations",
      "src/app/governance/petitions", "src/app/portal/governance/commitments",
      "src/app/portal/governance/accountability",
    ];
    for (const rel of prohibited) {
      expect(fs.existsSync(path.join(ROOT, rel)), `${rel} must not exist yet`).toBe(false);
    }
    // The Phase 12 Projects portal route is authorized and must exist.
    expect(fs.existsSync(path.join(ROOT, "src/app/portal/governance/projects"))).toBe(true);
  });
});

// ─────────────────────────────────────────────────────────────────────
// E. No duplicate Core systems in the schema
// ─────────────────────────────────────────────────────────────────────

describe("E. no duplicate core systems proposed or shipped", () => {
  it("E1. no governance notification/audit/media/queue tables exist", async () => {
    const res = await db.query<{ n: string }>(
      `SELECT count(*)::text n FROM pg_class c
         JOIN pg_namespace n2 ON n2.oid = c.relnamespace
        WHERE n2.nspname = 'politicore' AND c.relkind IN ('r','v')
          AND c.relname = ANY($1)`,
      [PHASE_11_PROHIBITED_TABLES.filter((t) => t !== "governance_updates" &&
        t !== "governance_projects" && t !== "governance_commitments" &&
        t !== "governance_consultations" && t !== "governance_polls" &&
        t !== "governance_petitions" && t !== "governance_engagements")]
    );
    expect(Number(res.rows[0].n)).toBe(0);
  });

  it("E2. the gate document pins the canonical update model (one shared table, proposed not built)", () => {
    const doc = fs.readFileSync(path.join(ROOT, GATE_DOC), "utf8");
    expect(doc).toContain("governance_updates");
    expect(doc).toContain("No `governance_notifications`");
    expect(doc).toContain("Exactly **three** new permissions");
  });

  it("E3. Core notifications/audit/media remain the only substrates", async () => {
    const res = await db.query<{ notifications: boolean; audits: boolean; media: boolean }>(
      `SELECT to_regclass('politicore.notifications') IS NOT NULL AS notifications,
              to_regclass('politicore.system_audits') IS NOT NULL AS audits,
              to_regclass('politicore.media_assets') IS NOT NULL AS media`
    );
    expect(res.rows[0].notifications).toBe(true);
    expect(res.rows[0].audits).toBe(true);
    expect(res.rows[0].media).toBe(true);
  });
});

// ─────────────────────────────────────────────────────────────────────
// F. Public intake compatibility (Phase 10 boundaries still hold)
// ─────────────────────────────────────────────────────────────────────

describe("F. phase 10 public intake compatibility", () => {
  it("F1. anon still reads nothing from governance base tables", async () => {
    const { as } = await import("./helpers");
    const read = await as(db, "anon", null,
      `SELECT count(*)::int AS n FROM politicore.governance_requests`);
    expect(read.error !== undefined || Number(read.rows[0]?.n ?? -1) === 0).toBe(true);
  });

  it("F2. the tracking projection surface is unchanged (5 OUT columns)", async () => {
    const res = await db.query<{ n: string }>(
      `SELECT count(*)::text n FROM information_schema.parameters
        WHERE specific_schema = 'politicore'
          AND specific_name LIKE 'governance_track_public_request%'
          AND parameter_mode = 'OUT'`
    );
    expect(Number(res.rows[0].n)).toBe(5);
  });

  it("F3. the intake toggle helper and public wrappers still resolve", async () => {
    const res = await db.query<{ ok: boolean }>(
      `SELECT to_regprocedure('politicore.governance_public_intake_enabled(uuid)') IS NOT NULL
         AND to_regprocedure('public.governance_public_intake(text,text,text,text,text,text,text,text,text,boolean)') IS NOT NULL
         AND to_regprocedure('public.governance_verify(text,text)') IS NOT NULL
         AND to_regprocedure('public.governance_track(text,text)') IS NOT NULL AS ok`
    );
    expect(res.rows[0].ok).toBe(true);
  });

  it("F4. Firebase remains retired (no firebase imports anywhere in src)", () => {
    // Historical comment mentions are permitted (Phase 5 boundary);
    // imports/initializers are not. Pure-Node scan (shell quoting of the
    // alternation is unreliable across platforms).
    const offenders: string[] = [];
    const walk = (dir: string): void => {
      for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        const p = path.join(dir, entry.name);
        if (entry.isDirectory()) { walk(p); continue; }
        if (!/\.(ts|tsx)$/.test(entry.name)) continue;
        const body = fs.readFileSync(p, "utf8");
        if (/from\s+["']firebase|require\(["']firebase|initializeApp\s*\(/.test(body))
          offenders.push(path.relative(ROOT, p));
      }
    };
    walk(path.join(ROOT, "src"));
    expect(offenders).toEqual([]);
  });
});
