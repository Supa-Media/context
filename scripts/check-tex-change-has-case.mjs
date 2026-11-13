#!/usr/bin/env node
/**
 * A change to Tex ships with the case that proves it (Dev2, 2026-11-13:
 * "changes to text can't merge without doing the full replay and passing";
 * docs/decisions/testing/replay-gate.md).
 *
 * A pull request that changes how Tex behaves (its gateway code, its texting
 * Worker, the shared judge) must add or change at least one case Tex is
 * replayed against: a plumbing replay (`apps/mcp/test/replay/cases/`), a
 * reply-or-quiet case (`apps/mcp/bench/respond/`), a reviewer case
 * (`apps/mcp/bench/review/`), an advisor role's case (`apps/mcp/bench/advisor/`) or a benchmark question
 * (`apps/mcp/bench/ai/tests/`).
 * A bug fixed without its case can come back unseen; a feature added without
 * one is never checked again. That is how the same kind of break kept
 * returning before 2026-11-13.
 *
 * A change that cannot be shown by a case (a rename, a log line, a comment)
 * says so in its description, on a line of its own:
 *
 *   No replay case: <why, in at least a few words>
 *
 * The reason is read by a person later; "n/a" is not one.
 *
 *   node scripts/check-tex-change-has-case.mjs             # in CI: BASE_SHA, TEX_PR_BODY
 *   node scripts/check-tex-change-has-case.mjs --self-test
 */
import { execFileSync } from "node:child_process";

/** Files whose change changes what Tex does. */
export const TEX_CODE = [/^apps\/mcp\/src\/agent\//, /^apps\/agent\/src\//, /^packages\/shared\/src\/text[^/]*$/, /^packages\/shared\/src\/texConfig\.json$/];
/** Files that are cases Tex is replayed or benchmarked against. */
export const CASES = [/^apps\/mcp\/test\/replay\/cases\//, /^apps\/mcp\/bench\/respond\//, /^apps\/mcp\/bench\/review\//, /^apps\/mcp\/bench\/advisor\//, /^apps\/mcp\/bench\/ai\/tests\//];
const EXEMPT = /^\s*No replay case:\s*(.+?)\s*$/im;
const MIN_REASON = 12;

/** The verdict for one pull request: null when it may merge, else what is missing. */
export function verdict(files, body = "") {
  const tex = files.filter((file) => TEX_CODE.some((pattern) => pattern.test(file)));
  if (tex.length === 0) return null;
  if (files.some((file) => CASES.some((pattern) => pattern.test(file)))) return null;
  const reason = EXEMPT.exec(body ?? "")?.[1] ?? "";
  if (reason.length >= MIN_REASON) return null;
  const said = reason ? ` ("${reason}" is too short to be a reason)` : "";
  return (
    `This pull request changes Tex (${tex.slice(0, 3).join(", ")}${tex.length > 3 ? ", ..." : ""}) and adds no case it is replayed against.\n` +
    `Add one that fails before this change and passes after it: apps/mcp/test/replay/cases/ for plumbing, apps/mcp/bench/respond/ or review/ for the judges, apps/mcp/bench/advisor/ for the advisor's roles, apps/mcp/bench/ai/tests/ for answers.\n` +
    `Write it from the cause, with invented people and words, never a real chat's.\n` +
    `If no case can show this change, say why in the description on its own line: "No replay case: <why>"${said}.`
  );
}

function selfTest() {
  const cases = [
    ["a change outside Tex needs nothing", ["apps/mobile/app/index.tsx"], "", true],
    ["a Tex change with a replay case passes", ["apps/mcp/src/agent/turn.js", "apps/mcp/test/replay/cases/sees-own-reply.mjs"], "", true],
    ["a Tex change with a bench question passes", ["apps/agent/src/inbox.ts", "apps/mcp/bench/ai/tests/core.md"], "", true],
    ["a judge change with a respond case passes", ["packages/shared/src/textDecide.cjs", "apps/mcp/bench/respond/cases.json"], "", true],
    ["an advisor role's change with its case passes", ["apps/mcp/src/agent/advisorRoles/planner.js", "apps/mcp/bench/advisor/planner.json"], "", true],
    ["a Tex change with no case fails", ["apps/mcp/src/agent/turn.js"], "", false],
    ["a Worker change with no case fails", ["apps/agent/src/inbox.ts"], "Fixes the inbox.", false],
    ["a stated reason passes", ["apps/mcp/src/agent/turn.js"], "Body\n\nNo replay case: renames a log field, no behaviour changes\n", true],
    ["a token reason fails", ["apps/mcp/src/agent/turn.js"], "No replay case: n/a", false],
    ["the reason must be its own line", ["apps/mcp/src/agent/turn.js"], "we said No replay case: renames a log field only", false],
    ["a unit test alone is not a replay case", ["apps/mcp/src/agent/turn.js", "apps/mcp/test/agentTurn.test.mjs"], "", false],
  ];
  let failed = 0;
  for (const [name, files, body, passes] of cases) {
    const ok = (verdict(files, body) === null) === passes;
    if (!ok) failed += 1;
    console.log(`${ok ? "ok" : "FAIL"} - ${name}`);
  }
  if (failed) {
    console.error(`\n${failed} self-test case(s) failed.`);
    process.exit(1);
  }
  console.log("\nself-test: all cases behave as stated.");
}

if (import.meta.url === `file://${process.argv[1]}`) {
  if (process.argv.includes("--self-test")) selfTest();
  else {
    const { BASE_SHA, TEX_PR_BODY = "" } = process.env;
    if (!BASE_SHA) {
      console.log("check-tex-change-has-case: not a pull request (no BASE_SHA); nothing to check.");
      process.exit(0);
    }
    // The checkout is the pull request merged onto its base, so base..HEAD is exactly what it changes.
    const files = execFileSync("git", ["diff", "--name-only", BASE_SHA, "HEAD"], { encoding: "utf8" }).split("\n").filter(Boolean);
    const problem = verdict(files, TEX_PR_BODY);
    if (problem) {
      console.error(`::error::${problem.split("\n")[0]}`);
      console.error(problem);
      process.exit(1);
    }
    console.log(`check-tex-change-has-case: ${files.length} file(s) changed; the rule holds.`);
  }
}
