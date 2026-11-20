#!/usr/bin/env node
/**
 * Tex's tools against the four tool rules (`packages/shared/src/toolRules.cjs`), measured on real turns.
 *
 *   node scripts/tool-rules.mjs            print the report
 *   node scripts/tool-rules.mjs --write    also rewrite apps/mcp/test/toolRules/baseline.json after a fix
 *
 * The baseline is what CI holds the code to: it may only get better (`apps/mcp/test/toolRules.test.mjs`).
 */
import { writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { toolRulesReport } from "../apps/mcp/test/toolRules/report.mjs";

const report = await toolRulesReport();
const baseline = {
  limit: report.limit,
  sizes: report.sizes,
  mcp: report.mcp,
  fixedList: Object.fromEntries(Object.entries(report.fixedList).map(([chat, one]) => [chat, { lists: one.lists, differ: one.differ }])),
  state: report.state,
  notActionableByFile: report.errors.notActionableByFile,
};
if (process.argv.includes("--write")) {
  const path = fileURLToPath(new URL("../apps/mcp/test/toolRules/baseline.json", import.meta.url));
  writeFileSync(path, `${JSON.stringify(baseline, null, 2)}\n`);
  console.error(`tool-rules: wrote ${path}`);
}
const { notActionableByFile, ...summary } = report.errors;
console.log(JSON.stringify({ ...report, errors: summary }, null, 2));
