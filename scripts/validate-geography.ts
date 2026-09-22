/**
 * POLITICORE — Geography validation (Phase 1A, re-runnable)
 *
 * Validates the /lgas directory (17 per-LGA TypeScript data files, canonical
 * Enugu State electoral geography) against expectations:
 *   - 1 state (Enugu), 3 senatorial zones, 17 LGAs, 260 wards, 4,145 PUs
 *   - duplicate / orphan / malformed record detection
 *   - ID and code integrity (per-parent uniqueness, format consistency)
 *
 * READ-ONLY. Exit 0 = valid, 1 = failures.
 * Usage: npx tsx scripts/validate-geography.ts
 */
import * as fs from "fs";
import * as path from "path";

const EXPECTED = { lgas: 17, wards: 260, pollingUnits: 4145 };

const ZONE_MEMBERSHIP: { zoneId: string; zoneName: string; lgas: string[] }[] = [
  {
    zoneId: "enugu-north-zone",
    zoneName: "Enugu North",
    lgas: ["igbo-etiti", "igbo-eze-north", "igbo-eze-south", "nsukka", "udenu", "uzo-uwani"],
  },
  {
    zoneId: "enugu-east-zone",
    zoneName: "Enugu East",
    lgas: ["enugu-east", "enugu-north", "enugu-south", "isi-uzo", "nkanu-east", "nkanu-west"],
  },
  {
    zoneId: "enugu-west-zone",
    zoneName: "Enugu West",
    lgas: ["aninri", "awgu", "ezeagu", "oji-river", "udi"],
  },
];

interface PU { id: string; code: string; name: string; isNew?: boolean }
interface Ward { id: string; code: string; name: string; pollingUnits: PU[] }
interface LGA { id: string; code: string; name: string; wards: Ward[] }

function formatLgaNameAndCode(filename: string) {
  const baseName = filename.replace(/_PUs\.ts$/, "").replace(/\.ts$/, "");
  const lgaId = baseName.toLowerCase().replace(/_/g, "-");
  const lgaName = baseName.replace(/_/g, " ");
  const parts = lgaId.split("-");
  const code = parts.length >= 2 ? parts.map((p) => p[0].toUpperCase()).join("") : lgaId.slice(0, 2).toUpperCase();
  return { lgaId, lgaName, code };
}

function parseLgaFile(filePath: string, filename: string): LGA {
  const content = fs.readFileSync(filePath, "utf-8");
  const match = content.match(/export const (.*?ElectoralData): Ward/);
  if (!match) throw new Error(`${filename}: export pattern not found`);
  const varName = match[1];
  const jsContent = content.replace(/export const (.*?ElectoralData): Ward\[\] =/, "const $1 =");
  const wards: Ward[] = eval(`(function() { ${jsContent}; return ${varName}; })()`);
  const { lgaId, lgaName, code } = formatLgaNameAndCode(filename);
  return { id: lgaId, code, name: lgaName, wards };
}

const errors: string[] = [];

function main() {
  const lgasDir = path.join(process.cwd(), "lgas");
  if (!fs.existsSync(lgasDir)) {
    console.error(`FATAL: directory not found: ${lgasDir}`);
    process.exit(1);
  }

  const files = fs.readdirSync(lgasDir).filter((f) => f.endsWith(".ts")).sort();
  if (files.length !== EXPECTED.lgas) errors.push(`Expected ${EXPECTED.lgas} LGA files, found ${files.length}`);

  const seenLgaIds = new Map<string, string>();
  const seenWardIds = new Map<string, string>();
  const seenPuIds = new Map<string, string>();
  let totalWards = 0;
  let totalPUs = 0;

  for (const file of files) {
    let lga: LGA;
    try {
      lga = parseLgaFile(path.join(lgasDir, file), file);
    } catch (e) {
      errors.push(`${file}: parse failure — ${(e as Error).message}`);
      continue;
    }

    if (seenLgaIds.has(lga.id)) errors.push(`LGA id '${lga.id}' duplicated`);
    seenLgaIds.set(lga.id, file);
    if (!/^[a-z0-9]+(-[a-z0-9]+)*$/.test(lga.id)) errors.push(`${file}: LGA id not kebab-case`);
    if (!Array.isArray(lga.wards) || lga.wards.length === 0) { errors.push(`${file}: no wards`); continue; }

    const wardCodes = new Set<string>();
    let lgaWards = 0, lgaPUs = 0;

    for (const w of lga.wards) {
      lgaWards++; totalWards++;
      if (!w.id || !/^[a-z0-9]+(-[a-z0-9]+)*$/.test(w.id)) errors.push(`${lga.id}/${w.id || "?"}: malformed ward id`);
      if (seenWardIds.has(w.id)) errors.push(`Ward id '${w.id}' duplicated (also ${seenWardIds.get(w.id)})`);
      seenWardIds.set(w.id, lga.id);
      if (!/^\d{2}$/.test(w.code)) errors.push(`${lga.id}/${w.id}: ward code not 2-digit`);
      if (wardCodes.has(w.code)) errors.push(`${lga.id}: duplicate ward code '${w.code}'`);
      wardCodes.add(w.code);
      if (!w.name || w.name.trim().length < 2) errors.push(`${lga.id}/${w.id}: implausible ward name`);
      if (!Array.isArray(w.pollingUnits) || w.pollingUnits.length === 0) { errors.push(`${lga.id}/${w.id}: no PUs`); continue; }

      const puCodes = new Set<string>();
      for (const pu of w.pollingUnits) {
        lgaPUs++; totalPUs++;
        if (!pu.id || !/^[a-z0-9]+(-[a-z0-9]+)*$/.test(pu.id)) errors.push(`${pu.id || "?"}: malformed PU id`);
        if (seenPuIds.has(pu.id)) errors.push(`PU id '${pu.id}' duplicated (also ${seenPuIds.get(pu.id)})`);
        seenPuIds.set(pu.id, lga.id);
        if (!pu.id.startsWith(`${w.id}-pu-`)) errors.push(`${lga.id}/${w.id}: orphan PU '${pu.id}'`);
        if (!/^\d{3}$/.test(pu.code)) errors.push(`${pu.id}: PU code not 3-digit`);
        if (puCodes.has(pu.code)) errors.push(`${w.id}: duplicate PU code '${pu.code}'`);
        puCodes.add(pu.code);
        if (!pu.name || pu.name.trim().length < 3) errors.push(`${pu.id}: implausible PU name`);
        if (pu.isNew !== undefined && typeof pu.isNew !== "boolean") errors.push(`${pu.id}: isNew not boolean`);
      }
    }
    console.log(`  ${lga.id.padEnd(18)} ${String(lgaWards).padStart(3)} wards  ${String(lgaPUs).padStart(4)} PUs  (code ${lga.code})`);
  }

  // Zone membership: every LGA in exactly one zone
  const all = new Set(seenLgaIds.keys());
  const assigned = new Set<string>();
  for (const z of ZONE_MEMBERSHIP) {
    for (const l of z.lgas) {
      if (!all.has(l)) errors.push(`Zone ${z.zoneId}: unknown LGA '${l}'`);
      if (assigned.has(l)) errors.push(`LGA '${l}' in multiple zones`);
      assigned.add(l);
    }
  }
  for (const l of all) if (!assigned.has(l)) errors.push(`LGA '${l}' not in any zone`);

  console.log("\nTOTALS");
  console.log(`  LGAs: ${seenLgaIds.size} (expected ${EXPECTED.lgas})`);
  console.log(`  Wards: ${totalWards} (expected ${EXPECTED.wards})`);
  console.log(`  Polling units: ${totalPUs} (expected ${EXPECTED.pollingUnits})`);

  const totalsOk = seenLgaIds.size === EXPECTED.lgas && totalWards === EXPECTED.wards && totalPUs === EXPECTED.pollingUnits;
  console.log(`\nERRORS: ${errors.length}`);
  for (const e of errors) console.log(`  ✗ ${e}`);
  const ok = errors.length === 0 && totalsOk;
  console.log(ok ? "\n✓ GEOGRAPHY VALIDATION PASSED" : "\n✗ GEOGRAPHY VALIDATION FAILED");
  process.exit(ok ? 0 : 1);
}

main();
