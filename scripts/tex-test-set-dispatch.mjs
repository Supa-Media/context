#!/usr/bin/env node
/**
 * Starts main's Tex test set when a pull request needs it, instead of waiting
 * for the replay check to fail first (docs/decisions/testing/test-set-service.md).
 * The gate is unchanged: scripts/tex-replay-required.mjs still passes a model
 * area only on a successful "Tex test set" status, and nothing here changes a
 * budget or an eval threshold.
 *
 * `--early` runs before the prompt fingerprints and starts only when the
 * changed files themselves reach a model area. `--prompts` runs when the gate
 * failed and starts only a reach the files did not name (the prompts changed),
 * so the two never start two runs. A second run on one commit is capped, and
 * the cap's failure must not replace a pass (tex-test-set.yml).
 *
 * An owner's skip, a status already on the commit, or a Test Set run already
 * queued for this pull request does not start another. Forks are excluded by
 * the workflow's `if`.
 *
 *   node scripts/tex-test-set-dispatch.mjs --self-test
 *   BASE_SHA= HEAD_SHA= PR_NUMBER= node scripts/tex-test-set-dispatch.mjs --early
 *   FINGERPRINT_AREAS=a,b node scripts/tex-test-set-dispatch.mjs --prompts
 */
import { execFileSync } from "node:child_process";

import { areasFor } from "../apps/mcp/bench/replayAreas.mjs";
import { liveBody } from "./pr-description.mjs";
import { ownerSkip, reachedAreas, STATUS } from "./tex-replay-required.mjs";

const RUNNING = new Set(["queued", "in_progress", "waiting", "pending", "requested"]);

/**
 * Whether this mode should dispatch. `statuses` are newest first, as the
 * statuses API returns them. `printed` is the fingerprint areas.
 */
export function dispatchPlan({ files, printed = [], statuses = [], body, mode }) {
  if (ownerSkip(body)) return { start: false, why: "the owner's skip is in effect" };
  const byFiles = areasFor(files);
  const areas = reachedAreas(files, printed);
  if (mode === "early") {
    if (byFiles.length === 0) return { start: false, why: "no file reaches a model area" };
  } else if (mode === "prompts") {
    if (byFiles.length > 0) return { start: false, why: "file areas are started before the fingerprints" };
    if (areas.length === 0) return { start: false, why: "no model area" };
  } else {
    throw new Error(`unknown mode ${mode}`);
  }
  const latest = statuses.find((status) => status.context === STATUS);
  if (latest) return { start: false, why: `"${STATUS}" is already ${latest.state} on this commit` };
  return { start: true, areas: mode === "early" ? byFiles : areas };
}

function selfTest() {
  const files = ["packages/tex/gateway/agent/turn.js"];
  const quiet = ["packages/tex/gateway/agent/warmCopy.js"];
  const map = ["packages/tex/gateway/agent/texArchitecture.generated.js"];
  const pending = [{ context: STATUS, state: "pending", description: "running" }];
  const ok = [{ context: STATUS, state: "success" }];
  const skip = "Replay skipped on the owner's call: config graph lands first";
  const cases = [
    ["files that reach an area start early", dispatchPlan({ files, mode: "early" }).start === true],
    ["files that reach nothing do not start early", dispatchPlan({ files: quiet, mode: "early" }).start === false],
    ["a prompt-only reach does not start early", dispatchPlan({ files: map, printed: ["core"], mode: "early" }).start === false],
    ["a prompt-only reach starts after the fingerprints", dispatchPlan({ files: map, printed: ["core"], mode: "prompts" }).start === true],
    ["file areas are not started again after the fingerprints", dispatchPlan({ files, printed: ["core"], mode: "prompts" }).start === false],
    ["an existing status is not started again", dispatchPlan({ files, statuses: pending, mode: "early" }).start === false],
    ["a pass is not started again", dispatchPlan({ files, statuses: ok, mode: "early" }).start === false],
    ["the owner's skip does not start a run", dispatchPlan({ files, body: skip, mode: "early" }).start === false],
    ["no area at all does not start", dispatchPlan({ files: quiet, printed: [], mode: "prompts" }).start === false],
    ["a newer failure hides an older pass", dispatchPlan({ files, statuses: [{ context: STATUS, state: "failure" }, ok[0]], mode: "early" }).start === false],
  ];
  let failed = 0;
  for (const [name, good] of cases) {
    if (!good) failed += 1;
    console.log(`${good ? "ok" : "FAIL"} - ${name}`);
  }
  if (failed) {
    console.error(`\n${failed} self-test case(s) failed.`);
    process.exit(1);
  }
  console.log("\nself-test: all cases behave as stated.");
}

function gh(args, inherit) {
  return execFileSync("gh", args, inherit ? { stdio: "inherit" } : { encoding: "utf8" });
}

function bodyOf() {
  const pr = process.env.PR_NUMBER || "";
  return liveBody({
    pr,
    eventBody: process.env.EVENT_BODY ?? process.env.PR_BODY ?? "",
    run: () => gh(["pr", "view", pr, "--repo", process.env.GITHUB_REPOSITORY, "--json", "body", "--jq", ".body"]),
  });
}

function queued(repo, pr) {
  const rows = JSON.parse(gh(["run", "list", "--repo", repo, "--workflow", "tex-test-set.yml", "--limit", "40", "--json", "displayTitle,status"]));
  const title = `Tex test set for #${pr}`;
  return rows.some((row) => row.displayTitle === title && RUNNING.has(row.status));
}

function main(mode) {
  const { BASE_SHA, HEAD_SHA, GITHUB_REPOSITORY, PR_NUMBER } = process.env;
  if (!BASE_SHA || !HEAD_SHA || !PR_NUMBER) {
    console.log("tex-test-set-dispatch: not a pull request; nothing to start.");
    return;
  }
  const files = execFileSync("git", ["diff", "--name-only", BASE_SHA, "HEAD"], { encoding: "utf8" }).split("\n").filter(Boolean);
  const printed = String(process.env.FINGERPRINT_AREAS ?? "").split(",").map((area) => area.trim()).filter(Boolean);
  // The body and the status list are reads. Skip them when the files already say this mode will not start.
  let plan = dispatchPlan({ files, printed, mode });
  const body = plan.start ? bodyOf() : "";
  if (plan.start) plan = dispatchPlan({ files, printed, body, mode });
  if (plan.start) {
    const statuses = JSON.parse(gh(["api", `repos/${GITHUB_REPOSITORY}/commits/${HEAD_SHA}/statuses`]));
    plan = dispatchPlan({ files, printed, body, mode, statuses });
  }
  if (!plan.start) {
    console.log(`tex-test-set-dispatch: not starting (${plan.why}).`);
    return;
  }
  if (queued(GITHUB_REPOSITORY, PR_NUMBER)) {
    console.log(`tex-test-set-dispatch: a Tex test set run is already queued for #${PR_NUMBER}.`);
    return;
  }
  gh(["workflow", "run", "tex-test-set.yml", "--repo", GITHUB_REPOSITORY, "--ref", "main", "-f", `pr=${PR_NUMBER}`], true);
  console.log(`tex-test-set-dispatch: started the Tex test set for ${plan.areas.join(", ")}.`);
}

if (process.argv[1]?.endsWith("tex-test-set-dispatch.mjs")) {
  if (process.argv.includes("--self-test")) selfTest();
  else {
    const mode = process.argv.includes("--early") ? "early" : process.argv.includes("--prompts") ? "prompts" : "";
    if (!mode) {
      console.error("tex-test-set-dispatch: pass --early or --prompts.");
      process.exit(1);
    }
    main(mode);
  }
}
