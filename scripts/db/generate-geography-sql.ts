/**
 * POLITICORE — Geography SQL generator (Phase 1A)
 *
 * Reads the validated /lgas source directory (17 per-LGA TypeScript files,
 * canonical Enugu State electoral geography: 17 LGAs / 260 wards / 4,145
 * polling units — verified by validation on 2026-09-21) and emits a
 * deterministic SQL seed migration for the geography reference tables.
 *
 * Zones (canonical): Enugu North (6 LGAs), Enugu East (6 LGAs),
 * Enugu West (5 LGAs). "Enugu South" is an LGA of Enugu East, not a zone
 * (corrected 2026-09-21 — 0013 repairs databases seeded with the old
 * third zone).
 *
 * The generated SQL is committed; the /lgas source directory is local
 * reference data (not committed). Re-run this generator after any change
 * to /lgas, then re-run validation before committing.
 *
 * Usage: npx tsx scripts/db/generate-geography-sql.ts
 */
import * as fs from "fs";
import * as path from "path";

// Senatorial-zone membership (canonical Enugu structure, cross-checked in validation).
const ZONE_MEMBERSHIP: { id: string; name: string; lgas: string[] }[] = [
  {
    id: "enugu-north-zone",
    name: "Enugu North",
    lgas: ["igbo-etiti", "igbo-eze-north", "igbo-eze-south", "nsukka", "udenu", "uzo-uwani"],
  },
  {
    id: "enugu-east-zone",
    name: "Enugu East",
    lgas: ["enugu-east", "enugu-north", "enugu-south", "isi-uzo", "nkanu-east", "nkanu-west"],
  },
  {
    id: "enugu-west-zone",
    name: "Enugu West",
    lgas: ["aninri", "awgu", "ezeagu", "oji-river", "udi"],
  },
];

// LGA codes — same derivation as the legacy seed script, with the one
// approved disambiguation: Udi=UDI (Udenu keeps UD). Codes are stable keys.
const LGA_CODES: Record<string, string> = {
  aninri: "AN",
  awgu: "AW",
  "enugu-east": "EE",
  "enugu-north": "EN",
  "enugu-south": "ES",
  ezeagu: "EZ",
  "igbo-etiti": "IE",
  "igbo-eze-north": "IEN",
  "igbo-eze-south": "IES",
  "isi-uzo": "IU",
  "nkanu-east": "NE",
  "nkanu-west": "NW",
  nsukka: "NS",
  "oji-river": "OR",
  udenu: "UD",
  udi: "UDI",
  "uzo-uwani": "UU",
};

interface PU {
  id: string;
  code: string;
  name: string;
  isNew?: boolean;
}
interface Ward {
  id: string;
  code: string;
  name: string;
  pollingUnits: PU[];
}
interface LGAFile {
  file: string;
  id: string;
  name: string;
  wards: Ward[];
}

function parseLgaFile(dir: string, file: string): LGAFile {
  const content = fs.readFileSync(path.join(dir, file), "utf-8");
  const match = content.match(/export const (.*?ElectoralData): Ward/);
  if (!match) throw new Error(`${file}: export pattern not found`);
  const varName = match[1];
  const jsContent = content.replace(/export const (.*?ElectoralData): Ward\[\] =/, "const $1 =");
  const wards: Ward[] = eval(`(function() { ${jsContent}; return ${varName}; })()`);
  const id = file.replace(/_PUs\.ts$/, "").toLowerCase().replace(/_/g, "-");
  const name = file.replace(/_PUs\.ts$/, "").replace(/_/g, " ");
  return { file, id, name, wards };
}

function q(s: string): string {
  return `'${s.replace(/'/g, "''")}'`;
}

function main() {
  const dir = path.join(process.cwd(), "lgas");
  if (!fs.existsSync(dir)) throw new Error(`Directory not found: ${dir}`);

  const files = fs.readdirSync(dir).filter((f) => f.endsWith(".ts")).sort();
  if (files.length !== 17) throw new Error(`Expected 17 LGA files, found ${files.length}`);

  const lgas = files.map((f) => parseLgaFile(dir, f));

  // Sanity: every LGA must have an approved code and a zone.
  const zoneOf = new Map<string, string>();
  for (const z of ZONE_MEMBERSHIP) for (const l of z.lgas) zoneOf.set(l, z.id);
  for (const lga of lgas) {
    if (!LGA_CODES[lga.id]) throw new Error(`No code defined for LGA '${lga.id}'`);
    if (!zoneOf.has(lga.id)) throw new Error(`No zone defined for LGA '${lga.id}'`);
  }

  const out: string[] = [];
  out.push(`-- =====================================================================`);
  out.push(`-- 0003: GEOGRAPHY DATA — Enugu State (generated, do not edit by hand)`);
  out.push(`-- Source: /lgas (17 files), generator: scripts/db/generate-geography-sql.ts`);
  out.push(`-- Counts: 1 state, 3 zones, 17 LGAs, 260 wards, 4,145 polling units`);
  out.push(`-- Validation: scripts/validate-geography (0 errors) — 2026-09-21`);
  out.push(`-- =====================================================================`);
  out.push(``);
  out.push(`INSERT INTO politicore.states (id, name, code) VALUES ('enugu-state', 'Enugu', 'EN');`);
  out.push(``);
  for (const z of ZONE_MEMBERSHIP) {
    out.push(
      `INSERT INTO politicore.senatorial_zones (id, state_id, name, code) VALUES ('${z.id}', 'enugu-state', ${q(z.name)}, '${z.name
        .split(" ")
        .map((w) => w[0].toUpperCase())
        .join("")}');`
    );
  }
  out.push(``);

  let wardCount = 0;
  let puCount = 0;

  for (const lga of lgas) {
    const zoneId = zoneOf.get(lga.id)!;
    out.push(
      `INSERT INTO politicore.lgas (id, state_id, zone_id, name, code) VALUES ('${lga.id}', 'enugu-state', '${zoneId}', ${q(lga.name)}, '${LGA_CODES[lga.id]}');`
    );

    const wardRows: string[] = [];
    const puRows: string[] = [];
    for (const w of lga.wards) {
      wardCount++;
      wardRows.push(`('${w.id}', '${lga.id}', ${q(w.name)}, '${w.code}')`);
      for (const pu of w.pollingUnits) {
        puCount++;
        puRows.push(
          `('${pu.id}', '${w.id}', '${lga.id}', ${q(pu.name)}, '${pu.code}', ${pu.isNew ? "true" : "false"})`
        );
      }
    }
    out.push(`INSERT INTO politicore.wards (id, lga_id, name, code) VALUES`);
    out.push(wardRows.join(",\n") + ";");
    out.push(`INSERT INTO politicore.polling_units (id, ward_id, lga_id, name, code, is_new) VALUES`);
    out.push(puRows.join(",\n") + ";");
    out.push(``);
  }

  out.push(`-- Totals check: wards=${wardCount} polling_units=${puCount}`);
  if (wardCount !== 260 || puCount !== 4145) {
    throw new Error(`Count regression: wards=${wardCount} (want 260), PUs=${puCount} (want 4145)`);
  }

  const outPath = path.join(process.cwd(), "supabase", "migrations", "0003_geography_data.sql");
  fs.writeFileSync(outPath, out.join("\n") + "\n");
  console.log(`Wrote ${outPath}`);
  console.log(`LGAs: ${lgas.length}, wards: ${wardCount}, polling units: ${puCount}`);
}

main();
