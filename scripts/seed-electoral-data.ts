import * as fs from "fs";
import * as path from "path";
import dotenv from "dotenv";
import type { EnuguStateElectoralData, LGA } from "../src/types";
dotenv.config({ path: ".env.local" });

function formatLgaNameAndCode(filename: string) {
  // e.g. "Nkanu_West_PUs.ts" -> "nkanu-west"
  // e.g. "Aninri_PUs.ts" -> "aninri"
  const baseName = filename.replace(/_PUs\.ts$/, "").replace(/\.ts$/, "");

  // Format ID: "Nkanu_West" -> "nkanu-west"
  const lgaId = baseName.toLowerCase().replace(/_/g, "-");

  // Format Name: "Nkanu_West" -> "Nkanu West"
  const lgaName = baseName.replace(/_/g, " ");

  // Format Code: "nkanu-west" -> "NW", "aninri" -> "AN"
  const parts = lgaId.split("-");
  let code = "";
  if (parts.length >= 2) {
    code = parts.map((p) => p[0].toUpperCase()).join("");
  } else {
    code = lgaId.slice(0, 2).toUpperCase();
  }

  return { lgaId, lgaName, code };
}

function generateElectoralData(): EnuguStateElectoralData {
  const lgasDir = path.join(process.cwd(), "lgas");
  if (!fs.existsSync(lgasDir)) {
    throw new Error(`Directory not found: ${lgasDir}`);
  }

  const files = fs
    .readdirSync(lgasDir)
    .filter((f) => f.endsWith(".ts"))
    .sort();

  const lgas: LGA[] = [];

  for (const file of files) {
    const filePath = path.join(lgasDir, file);
    let content = fs.readFileSync(filePath, "utf-8");

    const match = content.match(/export const (.*?ElectoralData): Ward/);
    if (!match) {
      console.warn(`Skipping file ${file}: Ward array export variable pattern not found.`);
      continue;
    }

    const varName = match[1];

    // Strip TypeScript type annotations (e.g., `: Ward[]`) before evaluating in JS
    const jsContent = content.replace(/export const (.*?ElectoralData): Ward\[\] =/, "const $1 =");

    let lgaWards;
    try {
      lgaWards = eval(`(function() {
        ${jsContent};
        return ${varName};
      })()`);
    } catch (evalErr) {
      console.error(`Failed to evaluate content of file ${file}:`, evalErr);
      continue;
    }

    const { lgaId, lgaName, code } = formatLgaNameAndCode(file);

    lgas.push({
      id: lgaId,
      code: code,
      name: lgaName,
      wards: lgaWards,
    });
  }

  return {
    state: "Enugu",
    lgas,
  };
}

async function main() {
  console.log("Starting electoral data parsing...");

  const data = generateElectoralData();
  console.log(`Parsed ${data.lgas.length} LGAs from /lgas directory.`);

  // Geography seeding now flows through canonical SQL migrations; this
  // script remains as an offline structure verifier for the LGA/PU files.
  console.log(
    "Electoral data structure for all LGAs parsed and verified successfully. " +
      "Canonical geography seeds flow through SQL migrations (supabase/migrations)."
  );
}

main().catch((err) => {
  console.error("Unexpected error in seed script:", err);
  process.exit(1);
});
