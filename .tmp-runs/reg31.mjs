/** Per-file regression runner for Phase 31 (pglite IPC breaks shared processes). */
import { execSync } from "child_process";
import { readdirSync } from "fs";

const files = readdirSync("tests/security")
  .filter((f) => f.endsWith(".test.ts"))
  .map((f) => `tests/security/${f}`)
  .sort();
console.log(`TOTAL_FILES=${files.length}`);
let pass = 0, fail = 0;
const failed = [];
for (const f of files) {
  const log = ".tmp-runs/reg31-last.log";
  try {
    execSync(
      `npx vitest run ${f} --config vitest.security.config.ts > ${log} 2>&1`,
      { stdio: "ignore", timeout: 600_000 });
    pass++;
    console.log(`PASS ${f}`);
  } catch {
    fail++;
    failed.push(f);
    console.log(`FAIL ${f}`);
  }
}
console.log(`REGRESSION_SUMMARY files=${files.length} pass=${pass} fail=${fail}`);
if (failed.length) console.log(`FAILED_FILES: ${failed.join(",")}`);
