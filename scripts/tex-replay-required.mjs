#!/usr/bin/env node
/**
 * The pull request's required check for the replay gate's model half
 * (docs/decisions/testing/replay-gate.md; Dev2, 2026-11-13: "changes to [Tex]
 * can't merge without doing the full replay and passing").
 *
 * The model runs need production's AI keys, and a workflow holding those never
 * runs on a pushed branch by itself (scripts/check-workflow-triggers.mjs). So
 * the agent that opens a Tex pull request dispatches "Tex replay" on its
 * branch; that run marks the commit with the status `Tex replay` and re-runs
 * this check. This check holds no secret: it reads which model areas the change
 * reaches (`apps/mcp/bench/replayAreas.mjs`) and, when there are any, passes
 * only when the head commit carries a successful `Tex replay` status.
 *
 *   BASE_SHA HEAD_SHA GH_TOKEN GITHUB_REPOSITORY node scripts/tex-replay-required.mjs
 *   node scripts/tex-replay-required.mjs --self-test
 */
import { execFileSync } from "node:child_process";

import { areasFor } from "../apps/mcp/bench/replayAreas.mjs";

export const STATUS = "Tex replay";

/** The verdict: null to pass, else what is missing. `statuses` are the head commit's, newest first. */
export function verdict(files, statuses) {
  const areas = areasFor(files);
  if (areas.length === 0) return null;
  const latest = statuses.find((status) => status.context === STATUS);
  if (latest?.state === "success") return null;
  const how = `Dispatch it on this branch: Actions → "Tex replay" → Run workflow (or the GitHub API: workflow tex-replay.yml, ref = this branch). It re-runs this check when it ends.`;
  if (!latest) return `This change reaches the model areas ${areas.join(", ")} and has no "${STATUS}" run on its head commit. ${how}`;
  return `"${STATUS}" ${latest.state} on this commit: ${latest.description ?? ""} Read its summary for what regressed, fix the cause, push, and run it again. ${how}`;
}

function selfTest() {
  const ok = { context: STATUS, state: "success" };
  const cases = [
    ["no model area: passes with no run", ["apps/mcp/src/agent/warmCopy.js"], [], true],
    ["a judge change with no run fails", ["packages/shared/src/textDecide.cjs"], [], false],
    ["a judge change with a passing run passes", ["packages/shared/src/textDecide.cjs"], [ok], true],
    ["the newest status wins", ["apps/mcp/src/agent/replyJudge.js"], [{ context: STATUS, state: "failure" }, ok], false],
    ["another context's success is not this one", ["apps/mcp/src/agent/replyJudge.js"], [{ context: "ci", state: "success" }], false],
    ["a pending run is not a pass", ["apps/mcp/bench/review/chat.json"], [{ context: STATUS, state: "pending" }], false],
  ];
  let failed = 0;
  for (const [name, files, statuses, passes] of cases) {
    const good = (verdict(files, statuses) === null) === passes;
    if (!good) failed += 1;
    console.log(`${good ? "ok" : "FAIL"} - ${name}`);
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
    const { BASE_SHA, HEAD_SHA, GITHUB_REPOSITORY } = process.env;
    if (!BASE_SHA || !HEAD_SHA) {
      console.log("tex-replay-required: not a pull request; nothing to check.");
      process.exit(0);
    }
    const files = execFileSync("git", ["diff", "--name-only", BASE_SHA, "HEAD"], { encoding: "utf8" }).split("\n").filter(Boolean);
    const statuses = areasFor(files).length ? JSON.parse(execFileSync("gh", ["api", `repos/${GITHUB_REPOSITORY}/commits/${HEAD_SHA}/statuses`], { encoding: "utf8" })) : [];
    const problem = verdict(files, statuses);
    if (problem) {
      console.error(`::error::${problem}`);
      process.exit(1);
    }
    console.log(`tex-replay-required: ${areasFor(files).join(", ") || "no model area"}; the rule holds.`);
  }
}
