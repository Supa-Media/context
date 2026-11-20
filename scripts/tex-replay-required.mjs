#!/usr/bin/env node
/**
 * The pull request's required check for Tex's gate (docs/decisions/testing/replay-gate.md and
 * test-set-service.md). Since Dev2, 2026-11-15 ("the test set should become the actual thing that the CI/CD gates
 * on ... training shouldn't affect CI/CD speed. Even the dev shouldn't"), the gate is the Test Set alone: a change
 * that reaches a model area passes only when its head commit carries a successful `Tex test set` status, which
 * main's "Tex test set" workflow sets after the sealed eval service scored the change against main. The full
 * replay ("Tex replay", the Dev Set's practice cases) is on demand and never gates.
 *
 * The model runs need production's AI keys, and a workflow holding those never runs on a pushed branch's code by
 * itself (scripts/check-workflow-triggers.mjs). This check holds no secret: it reads which model areas the change
 * reaches (`apps/mcp/bench/replayAreas.mjs`), and its workflow starts "Tex test set" on main when the rule fails.
 *
 * An area is also reached when its prompts changed (Dev2, 2026-11-13: "even if
 * it's a letter different, we need to check that"): the workflow builds every
 * area's prompts on main and on the change with no model and no key
 * (`apps/mcp/bench/promptFingerprint.mjs`) and passes the areas that differ in
 * FINGERPRINT_AREAS, so a file no area names (the drawing's map, the
 * capability list) still requires the replay of every area it reaches.
 *
 *   BASE_SHA HEAD_SHA GH_TOKEN GITHUB_REPOSITORY [FINGERPRINT_AREAS=a,b] node scripts/tex-replay-required.mjs
 *   node scripts/tex-replay-required.mjs --self-test
 */
import { execFileSync } from "node:child_process";

import { areasFor } from "../apps/mcp/bench/replayAreas.mjs";

export const STATUS = "Tex test set";

/**
 * The owner's temporary skip (Dev2, 2026-11-14: "it's fine to bypass the replay
 * checks just for now because the config changes are so monumental ... the
 * replay should kind of wait for the config change first"). A pull request whose
 * body has a line starting `Replay skipped on the owner's call:` and a reason
 * passes without a run, until SKIP_ENDS; after that the line does nothing and
 * the gate is whole again. Each use is printed in the check's log.
 */
export const SKIP_LINE = "Replay skipped on the owner's call:";
export const SKIP_ENDS = "2026-11-22T00:00:00Z";

/** The skip's reason when the body carries one and the skip has not ended, else null. */
export function ownerSkip(body, now = new Date()) {
  if (now >= new Date(SKIP_ENDS)) return null;
  const line = String(body ?? "").split(/\r?\n/).find((text) => text.trim().startsWith(SKIP_LINE));
  const reason = line?.trim().slice(SKIP_LINE.length).trim();
  return reason ? reason : null;
}

/** The areas a change reaches: by its files, and by its prompts (`printed`, from the fingerprint run), in a fixed order. */
export function reachedAreas(files, printed = []) {
  const byFiles = areasFor(files);
  return [...byFiles, ...printed.filter((area) => !byFiles.includes(area))];
}

/** The verdict: null to pass, else what is missing. `statuses` are the head commit's, newest first. */
export function verdict(files, statuses, printed = []) {
  const areas = reachedAreas(files, printed);
  if (areas.length === 0) return null;
  const latest = statuses.find((status) => status.context === STATUS);
  if (latest?.state === "success") return null;
  const how = `This check starts it on main for this pull request (Actions → "Tex test set", ref main, pr = this number); it re-runs this check when it ends. Runs are capped at 1 a commit, 10 changes a pull request (a commit that only merges main is free) and 1000 a day; a person can allow one more in the Lab.`;
  if (!latest) return `This change reaches the model areas ${areas.join(", ")} and has no "${STATUS}" run on its head commit. ${how}`;
  return `"${STATUS}" ${latest.state} on this commit: ${latest.description ?? ""} Its summary says which step got fewer right than main, by count only: tune on the Dev Set (pnpm ai sets run --set dev), fix the cause, push. ${how}`;
}

function selfTest() {
  const ok = { context: STATUS, state: "success" };
  const cases = [
    ["no model area: passes with no run", ["apps/mcp/src/agent/warmCopy.js"], [], true],
    ["a judge change with no run fails", ["packages/tex/src/textDecide.cjs"], [], false],
    ["a judge change with a passing run passes", ["packages/tex/src/textDecide.cjs"], [ok], true],
    ["the newest status wins", ["apps/mcp/src/agent/replyJudge.js"], [{ context: STATUS, state: "failure" }, ok], false],
    ["another context's success is not this one", ["apps/mcp/src/agent/replyJudge.js"], [{ context: "ci", state: "success" }], false],
    // The full replay is the Dev Set's, and never gates (Dev2, 2026-11-15): only the Test Set's status passes.
    ["a passing full replay is not the Test Set", ["apps/mcp/src/agent/replyJudge.js"], [{ context: "Tex replay", state: "success" }], false],
    ["a pending run is not a pass", ["apps/mcp/bench/review/chat.json"], [{ context: STATUS, state: "pending" }], false],
    // A one-letter edit to the drawing's map names no area by file, but changes every prompt that reads it.
    ["changed prompts with no run fail", ["apps/mcp/src/agent/texArchitecture.generated.js"], [], false, ["core", "review"]],
    ["changed prompts with a passing run pass", ["apps/mcp/src/agent/texArchitecture.generated.js"], [ok], true, ["core"]],
    ["unchanged prompts and no area file pass with no run", ["apps/mcp/src/agent/texArchitecture.generated.js"], [], true, []],
  ];
  let failed = 0;
  const before = new Date("2026-11-15T00:00:00Z");
  const after = new Date(SKIP_ENDS);
  const skips = [
    ["the owner's skip with a reason holds before it ends", ownerSkip(`Intro\n${SKIP_LINE} config graph lands first`, before) === "config graph lands first"],
    ["the skip line with no reason is not a skip", ownerSkip(`${SKIP_LINE}   `, before) === null],
    ["a body with no skip line is not a skip", ownerSkip("No replay case: docs only", before) === null],
    ["the skip ends on its date", ownerSkip(`${SKIP_LINE} config graph`, after) === null],
  ];
  for (const [name, good] of skips) {
    if (!good) failed += 1;
    console.log(`${good ? "ok" : "FAIL"} - ${name}`);
  }
  for (const [name, files, statuses, passes, printed = []] of cases) {
    const good = (verdict(files, statuses, printed) === null) === passes;
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
    const printed = String(process.env.FINGERPRINT_AREAS ?? "").split(",").map((area) => area.trim()).filter(Boolean);
    const reached = reachedAreas(files, printed);
    const statuses = reached.length ? JSON.parse(execFileSync("gh", ["api", `repos/${GITHUB_REPOSITORY}/commits/${HEAD_SHA}/statuses`], { encoding: "utf8" })) : [];
    const problem = verdict(files, statuses, printed);
    const skipped = problem ? ownerSkip(process.env.PR_BODY) : null;
    if (skipped) {
      console.log(`::warning::tex-replay-required: ${reached.join(", ")} not replayed, skipped on the owner's call until ${SKIP_ENDS}: ${skipped}`);
      process.exit(0);
    }
    if (problem) {
      console.error(`::error::${problem}`);
      process.exit(1);
    }
    console.log(`tex-replay-required: ${reached.join(", ") || "no model area"}${printed.length ? ` (prompts changed: ${printed.join(", ")})` : ""}; the rule holds.`);
  }
}
