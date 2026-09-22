import { describe, it, expect, beforeAll } from "vitest";
import { getDb, as, createTenant } from "./helpers";

let db: Awaited<ReturnType<typeof getDb>>;

beforeAll(async () => {
  db = await getDb();
});

describe("geography reference data", () => {
  it("has exactly the expected Enugu totals", async () => {
    const r = await db.query(`
      SELECT
        (SELECT count(*) FROM politicore.states) states,
        (SELECT count(*) FROM politicore.senatorial_zones) zones,
        (SELECT count(*) FROM politicore.lgas) lgas,
        (SELECT count(*) FROM politicore.wards) wards,
        (SELECT count(*) FROM politicore.polling_units) pus
    `);
    expect(r.rows[0]).toEqual({ states: 1, zones: 3, lgas: 17, wards: 260, pus: 4145 });
  });

  it("every ward belongs to a valid LGA (no orphans)", async () => {
    const r = await db.query(`
      SELECT count(*)::int AS orphans FROM politicore.wards w
      LEFT JOIN politicore.lgas l ON l.id = w.lga_id WHERE l.id IS NULL
    `);
    expect((r.rows[0] as Record<string, unknown>).orphans).toBe(0);
  });

  it("every PU's denormalized lga_id matches its ward's LGA (consistency)", async () => {
    const r = await db.query(`
      SELECT count(*)::int AS mismatches FROM politicore.polling_units pu
      JOIN politicore.wards w ON w.id = pu.ward_id
      WHERE pu.lga_id <> w.lga_id
    `);
    expect((r.rows[0] as Record<string, unknown>).mismatches).toBe(0);
  });

  it("all 17 LGAs are assigned to exactly one of the 3 zones", async () => {
    const r = await db.query(`
      SELECT count(*)::int AS bad FROM politicore.lgas l
      LEFT JOIN politicore.senatorial_zones z ON z.id = l.zone_id
      WHERE z.id IS NULL
    `);
    expect((r.rows[0] as Record<string, unknown>).bad).toBe(0);
    const zc = await db.query(`
      SELECT count(DISTINCT zone_id)::int AS zones FROM politicore.lgas
    `);
    expect((zc.rows[0] as Record<string, unknown>).zones).toBe(3);
  });

  it("PU id embeds its ward id (source convention preserved)", async () => {
    const r = await db.query(`
      SELECT count(*)::int AS bad FROM politicore.polling_units
      WHERE NOT id LIKE ward_id || '-pu-%'
    `);
    expect((r.rows[0] as Record<string, unknown>).bad).toBe(0);
  });

  it("unique constraints hold: no duplicate (lga, ward code) or (ward, PU code)", async () => {
    const d1 = await db.query(`
      SELECT count(*)::int AS n FROM (
        SELECT lga_id, code FROM politicore.wards GROUP BY lga_id, code HAVING count(*) > 1
      ) x`);
    const d2 = await db.query(`
      SELECT count(*)::int AS n FROM (
        SELECT ward_id, code FROM politicore.polling_units GROUP BY ward_id, code HAVING count(*) > 1
      ) x`);
    expect((d1.rows[0] as Record<string, unknown>).n).toBe(0);
    expect((d2.rows[0] as Record<string, unknown>).n).toBe(0);
  });

  it("anonymous (unauthenticated) users can read geography but not profiles", async () => {
    const geo = await as(db, "anon", null, `SELECT count(*)::int AS n FROM politicore.polling_units`);
    expect(geo.error).toBeUndefined();
    expect(geo.rows[0].n).toBe(4145);

    const profiles = await as(db, "anon", null, `SELECT count(*)::int AS n FROM politicore.profiles`);
    expect(profiles.rows[0].n).toBe(0);
  });

  it("authenticated users cannot modify geography (platform-admin only)", async () => {
    const t = await createTenant(db, "geo-a", "Geo Tenant", {});
    const { createUser } = await import("./helpers");
    const u = await createUser(db, {
      tenantId: t, email: "geo@a.test", fullName: "Geo User", accessRole: "admin",
      membershipTypes: ["campaign_member"],
    });
    const r = await as(db, "authenticated", u.authId,
      `INSERT INTO politicore.states (id, name, code) VALUES ('fake-state', 'Fake', 'FK')`);
    expect(r.error).toBeDefined();
  });
});
