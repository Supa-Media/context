#!/usr/bin/env node
/**
 * Tex's speed budgets only move down unless a person reads why (Dev2,
 * 2026-11-13: "the speed keeps regressing ... it's like agents keep modifying
 * the speed baseline"; docs/decisions/testing/replay-gate.md).
 *
 * `apps/mcp/test/replay/speed-budget.json` holds, for five simple turns, the
 * most model calls a turn may make and the most calls it may make before its
 * first model call; the replay case `speed-budgets.mjs` fails a change that
 * goes over one. `scripts/tex-speed-budgets.json` holds production's bars and
 * targets for the wait to Tex's first text, judged every hour. The cheap way past that is to raise the number, which is
 * how a slower Tex kept passing. So a pull request that raises any number, or
 * drops a budgeted turn, says why on a line of its own in its description:
 *
 *   Speed budget raised: <why, in at least a few words>
 *
 * Lowering a number needs nothing.
 *
 *   node scripts/check-speed-budget.mjs             # in CI: BASE_SHA, TEX_PR_BODY
 *   node scripts/check-speed-budget.mjs --self-test
 */
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";

/** The replay's per-turn call budgets, and production's reply-time bars and targets: each only moves down unless a reason is given. */
export const BUDGET_FILES = ["apps/mcp/test/replay/speed-budget.json", "scripts/tex-speed-budgets.json"];
const RAISED = /^\s*Speed budget raised:\s*(.+?)\s*$/im;
const MIN_REASON = 12;

/** Every number that went up, or a budgeted turn that went away, between two budget files. */
export function raises(base, head) {
  return ["paths", "targets"].flatMap((section) => raisesIn(base?.[section] ?? {}, head?.[section] ?? {}, section === "targets" ? "target " : ""));
}

function raisesIn(before, after, label) {
  const found = [];
  for (const [path, limits] of Object.entries(before)) {
    if (!(path in after)) {
      found.push(`${label}"${path}" is no longer budgeted`);
      continue;
    }
    for (const [kind, limit] of Object.entries(limits)) {
      const now = after[path][kind];
      if (typeof now !== "number") found.push(`${label}${path}: ${kind} is no longer budgeted`);
      else if (now > limit) found.push(`${label}${path}: ${kind} ${limit} -> ${now}`);
    }
  }
  return found;
}

/** The verdict for one pull request: null when it may merge, else what is missing. */
export function verdict(base, head, body = "", file = BUDGET_FILES[0]) {
  const found = raises(base, head);
  if (found.length === 0) return null;
  const reason = RAISED.exec(body ?? "")?.[1] ?? "";
  if (reason.length >= MIN_REASON) return null;
  const said = reason ? ` ("${reason}" is too short to be a reason)` : "";
  return (
    `This pull request raises Tex's speed budget (${file}): ${found.join("; ")}.\n` +
    `A slower simple turn is what people feel. Find the call the change added and remove it, or move it behind the reply.\n` +
    `If the turn truly needs it, say why in the description on its own line: "Speed budget raised: <why>"${said}.`
  );
}

function selfTest() {
  const budget = (first, warm = 12, model = 1) => ({ paths: { "1:1 first text": { model, beforeModel: first }, "1:1 warm text": { model: 1, beforeModel: warm } } });
  const cases = [
    ["no budget file on the base passes", null, budget(19), "", true],
    ["an unchanged budget passes", budget(19), budget(19), "", true],
    ["a lowered budget passes", budget(19), budget(17, 10), "", true],
    ["a raised count fails", budget(19), budget(20), "", false],
    ["a raised model count fails", budget(19), budget(19, 12, 2), "", false],
    ["a dropped turn fails", budget(19), { paths: { "1:1 first text": { model: 1, beforeModel: 19 } } }, "", false],
    ["a raise with a reason passes", budget(19), budget(20), "Body\n\nSpeed budget raised: the first text now reads the calendar, which every reply needs\n", true],
    ["a token reason fails", budget(19), budget(20), "Speed budget raised: needed", false],
    ["the reason must be its own line", budget(19), budget(20), "we said Speed budget raised: the first text now reads the calendar", false],
    ["a raised live target fails", { paths: {}, targets: { group: { p50Ms: 5000 } } }, { paths: {}, targets: { group: { p50Ms: 8000 } } }, "", false],
    ["a lowered live bar passes", { paths: { group: { p50Ms: 18500 } } }, { paths: { group: { p50Ms: 15000 } } }, "", true],
  ];
  let failed = 0;
  for (const [name, base, head, body, passes] of cases) {
    const ok = (verdict(base, head, body) === null) === passes;
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
      console.log("check-speed-budget: not a pull request (no BASE_SHA); nothing to check.");
      process.exit(0);
    }
    const problems = BUDGET_FILES.flatMap((file) => {
      let base = null;
      try {
        base = JSON.parse(execFileSync("git", ["show", `${BASE_SHA}:${file}`], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }));
      } catch {
        base = null; // The base has no budget yet: nothing to raise.
      }
      const problem = verdict(base, JSON.parse(readFileSync(file, "utf8")), TEX_PR_BODY, file);
      return problem ? [problem] : [];
    });
    if (problems.length > 0) {
      for (const problem of problems) {
        console.error(`::error::${problem.split("\n")[0]}`);
        console.error(problem);
      }
      process.exit(1);
    }
    console.log("check-speed-budget: no budget raised without a reason.");
  }
}
