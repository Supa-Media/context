/**
 * THE REPLAY GATE'S MODEL HALF (`bench/replayGate.mjs`; Dev2, 2026-11-13).
 *
 * Sabotage record (applied, run, observed failing, reverted, 2026-11-13):
 *  1. `regressions` counting a single wrong run as a regression -> "noise is not a regression" fails
 *     (again 2026-11-13 with `every` loosened back to `most` on main);
 *  2. `feedback` printing a held-out case's id -> "a held-out case is reported by its cause alone" fails;
 *  3. `areasFor` sending every Tex file to every area -> "a change runs only the areas its files reach" fails;
 *  4. `blocking` keeping target ids -> "a target is reported, never blocks" fails;
 *  5. dropping `areasFor` from replayGate's own import -> "the areas command runs" fails.
 *  6. dropping the key-file filter in `publishCoreRecords` -> "the core area's judged answers go to Context" fails.
 */
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { test } from "node:test";

import { AREA_LIMITS, areasFor, blocking, feedback, gate, heldOutJson, markHeldOut, mergeRuns, regressions, rowsFor, RUNNERS } from "../replayGate.mjs";

test("a change runs only the areas its files reach, and plumbing alone runs none", () => {
  assert.deepEqual(areasFor(["packages/shared/src/textDecide.cjs"]), ["respond"]);
  assert.deepEqual(areasFor(["apps/mcp/src/agent/replyJudge.js"]), ["review"]);
  assert.deepEqual(areasFor(["apps/mcp/bench/review/chat.json", "apps/mcp/bench/respond/cases.json"]), ["respond", "review"]);
  assert.deepEqual(areasFor(["apps/mcp/bench/respond.mjs", "apps/mcp/bench/review.mjs"]), [], "the scorers are not Tex");
  assert.deepEqual(areasFor(["apps/mcp/src/agent/warmCopy.js", "apps/mobile/app/index.tsx"]), []);
});

test("an advisor role's file runs that role alone, and the shared core runs every role", () => {
  assert.deepEqual(areasFor(["apps/mcp/src/agent/advisorRoles/chat.js"]), ["advisor-chat"]);
  assert.deepEqual(areasFor(["apps/mcp/src/agent/advisorRoles/jobCheck.js"]), ["advisor-job-check"]);
  assert.deepEqual(areasFor(["apps/mcp/src/agent/advisorRoles/planner.js"]), ["advisor-planner"]);
  assert.deepEqual(areasFor(["apps/mcp/src/agent/advisorRoles/jobMail.js"]), ["advisor-job-mail"]);
  assert.deepEqual(areasFor(["apps/mcp/bench/advisor/planner.json"]), ["advisor-planner"], "a role's cases run that role");
  assert.deepEqual(areasFor(["apps/mcp/src/agent/jobCheck.js"]), ["advisor-job-check"], "the role's brief builder too");
  assert.deepEqual(areasFor(["apps/mcp/src/agent/advisorRoles/knowsMail.js"]), ["advisor-job-check", "advisor-job-mail"], "the mail line reaches both roles that read a job");
  assert.deepEqual(areasFor(["apps/mcp/src/agent/advisorRoles/core.js"]), ["advisor-chat", "advisor-job-check", "advisor-planner", "advisor-job-mail"]);
  assert.deepEqual(areasFor(["apps/mcp/bench/advisor.mjs"]), [], "the scorer is not a role");
  assert.ok(!areasFor(["apps/mcp/src/agent/jobNote.js"]).some((area) => area.startsWith("advisor-")), "the mail's plumbing is the jobs area's, not a role");
});

test("a change to every advisor role at once still fits the cap with a case to rerun", async () => {
  const { AREA_LIMITS, RUNNERS } = await import("../replayGate.mjs");
  const { ROLES, loadRoleCases } = await import("../advisor.mjs");
  let first = 0;
  for (const role of Object.keys(ROLES)) {
    assert.equal(AREA_LIMITS[role].pool, "shared", `${role} shares the $1 a change`);
    assert.equal(typeof RUNNERS[role], "function", `${role} has a runner`);
    first += AREA_LIMITS[role].usdPerCase * (await loadRoleCases(role)).length;
  }
  const chat = AREA_LIMITS["advisor-chat"];
  assert.ok(first + chat.usdPerCase * (chat.reruns.branch + chat.reruns.main) <= chat.maxUsd, `all four roles cost about $${first.toFixed(2)} before reruns`);
});

test("noise is not a regression: a case regresses only when the change is wrong in every run and main right in every run", () => {
  assert.deepEqual(regressions({ a: [false, true, true] }, { a: [true, true, true] }), [], "wrong once, right twice: noise");
  assert.deepEqual(regressions({ a: [false, false, false] }, { a: [true, true, true] }), ["a"]);
  assert.deepEqual(regressions({ a: [false, false, false] }, { a: [true, true, false] }), [], "main is right only sometimes: the model's coin");
  assert.deepEqual(regressions({ a: [false, false, true] }, { a: [true, true, true] }), [], "the change is right sometimes too");
  assert.deepEqual(regressions({ a: [false, false, false] }, { a: [false, false, true] }), [], "main was wrong too: not this change's");
  assert.deepEqual(regressions({ fresh: [false, false, true] }, { fresh: [] }), ["fresh"], "a change must pass the cases it adds");
});

test("a case is right as its area reads it", () => {
  const [quiet, dropped, sentBack, letGo] = [
    ...rowsFor("respond", [{ id: "q", want: "hush", hushed: true }, { id: "d", want: "reply", hushed: true, verdict: { ok: true } }]),
    ...rowsFor("review", [{ id: "f", fault: true, sent: false }, { id: "g", fault: false, sent: null }]),
  ];
  assert.equal(quiet.right, true);
  assert.equal(dropped.right, false);
  assert.equal(sentBack.right, true);
  assert.equal(letGo.right, false, "no verdict on a good reply is not right");
});

test("a held-out case is reported by its cause alone, never its id or words", () => {
  const secret = markHeldOut({ id: "tacos-at-noon", text: "@lee: tacos at noon?", cause: "a plan between people, not for Tex", want: "hush" });
  const rows = [{ id: secret.id, right: false, heldOut: true, cause: secret.cause, must: false, expected: "stay quiet or react" }, { id: "g-carpool", right: false, heldOut: false, cause: null, must: true, expected: "reach the model" }];
  const report = feedback({ areas: ["respond"], results: [{ area: "respond", rows, regressed: rows, usd: 0.01 }] });
  assert.match(report, /❌ 2 case/);
  assert.match(report, /`g-carpool` \(must pass\): expected to reach the model/);
  assert.match(report, /1 about respond: a plan between people, not for Tex/);
  assert.doesNotMatch(report, /tacos/);
});

test("a held-out note's cases are its json block", () => {
  assert.deepEqual(heldOutJson("# Held out\n\nText.\n\n```json\n{\"cases\":[{\"id\":\"x\"}]}\n```\n"), { cases: [{ id: "x" }] });
  assert.equal(heldOutJson("no block"), null);
});

test("a target is reported, never blocks: a known unfixed bug can fail without stopping a merge", () => {
  const rows = rowsFor("respond", [{ id: "t", want: "reply", hushed: true, target: "a cause" }, { id: "p", want: "reply", hushed: true }]);
  assert.equal(rows[0].target, true);
  assert.equal(rows[1].target, false);
  assert.deepEqual(blocking(["t", "p"], rows), ["p"]);
  const report = feedback({ areas: ["respond"], results: [{ area: "respond", rows, regressed: [], usd: 0 }] });
  assert.ok(report.includes("respond targets** (known bugs, never block): 0/1 right"));
});

test("the areas command runs: it names a change's areas from git (it once threw, areasFor unbound)", () => {
  const run = fileURLToPath(new URL("../run.mjs", import.meta.url));
  const out = execFileSync(process.execPath, [run, "gate", "areas", "--base-sha", "HEAD"], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] });
  assert.equal(out, "\n", "HEAD against itself changes nothing, so no area");
});

/** A scripted area: `answers[tree][id]` is the list of results it gives, one a run, taken in order. */
function scripted(answers, cost = 0.01) {
  const calls = [];
  const runner = async (tree, { only, runs = 1, tag }) => {
    calls.push({ tree, tag, only, runs });
    const ids = only ?? Object.keys(answers[tree]);
    const rows = ids.filter((id) => id in answers[tree]).map((id) => {
      const results = answers[tree][id].splice(0, runs);
      return { id, results, right: results.filter(Boolean).length * 2 > results.length, target: id.startsWith("t-") ? "a known bug" : null, must: false, heldOut: false, cause: null, expected: "pass" };
    });
    return { rows, usd: cost * rows.length * runs };
  };
  return { runner, calls };
}
const LIMITS = { core: { maxUsd: 1, pool: "shared", usdPerCase: 0.01, reruns: { branch: 2, main: 3 } }, respond: { maxUsd: 1, pool: "shared", usdPerCase: 0.01, reruns: { branch: 2, main: 3 } } };

test("only the change's wrong cases run again, on the change and on main, and a target never blocks", async () => {
  const { runner, calls } = scripted({
    branch: { ok: [true], broke: [false, false, false], flaky: [false, true, true], "t-known": [false, false, false] },
    main: { broke: [true, true, true], flaky: [true, true, true], "t-known": [true, true, true] },
  });
  const result = await gate({ branch: "branch", base: "main", areas: ["core"], scratch: "/nowhere", runners: { core: runner }, limits: LIMITS, hasArea: async () => true });
  assert.deepEqual(result.results[0].regressed.map((row) => row.id), ["broke"]);
  assert.equal(result.pass, false);
  assert.deepEqual(calls.map((call) => [call.tree, call.runs, call.only?.join(",") ?? "all"]), [["branch", 1, "all"], ["branch", 2, "broke,flaky,t-known"], ["main", 3, "broke,flaky,t-known"]]);
});

test("a main without the area gives main no runs, and the change must pass its own cases", async () => {
  const { runner, calls } = scripted({ branch: { fresh: [false, false, false], good: [true] }, main: {} });
  const result = await gate({ branch: "branch", base: "main", areas: ["core"], scratch: "/nowhere", runners: { core: runner }, limits: LIMITS, hasArea: async () => false });
  assert.deepEqual(result.results[0].regressed.map((row) => row.id), ["fresh"]);
  assert.ok(!calls.some((call) => call.tree === "main"), "main was not asked to run an area it does not have");
});

test("areas in one pool share its cap: a change that would pass it is refused before its reruns", async () => {
  const many = Object.fromEntries(Array.from({ length: 20 }, (_, i) => [`c${i}`, [false]]));
  const { runner } = scripted({ branch: many, main: {} }, 0.02);
  await assert.rejects(gate({ branch: "branch", base: "main", areas: ["core"], scratch: "/nowhere", runners: { core: runner }, limits: LIMITS, hasArea: async () => true }), /shared pool past \$1/);
});

test("several runs read as one row a case, right when most were", () => {
  const merged = mergeRuns([[{ id: "a", right: false }], [{ id: "a", right: true }], [{ id: "a", right: true }]]);
  assert.deepEqual(merged.map((row) => [row.id, row.results, row.right]), [["a", [false, true, true], true]]);
});

test("the front door, the prompt and the turn reach the core area; their neighbours do not", () => {
  assert.deepEqual(areasFor(["apps/mcp/src/agent/texEntryPoint/runTheModel.js"]), ["core"]);
  assert.deepEqual(areasFor(["apps/mcp/src/agent/promptModules.js", "apps/mcp/bench/ai/tests/simple-asks.md"]), ["core"]);
  assert.deepEqual(areasFor(["apps/mcp/src/agent/turnWeb.js", "apps/mcp/src/agent/jobNote.js"]), ["jobs"], "a job note is the jobs area's, never core's");
});

test("a job or page change reaches the jobs area, on a pool of its own with fewer reruns", () => {
  assert.deepEqual(areasFor(["apps/agent/src/jobRun.ts"]), ["jobs"]);
  assert.deepEqual(areasFor(["apps/mcp/src/agent/jobNote.js", "apps/mcp/bench/job-tasks/cases.json"]), ["jobs"]);
  assert.deepEqual(areasFor(["apps/mcp/bench/jobTasks.mjs", "apps/mcp/bench/world.mjs"]), [], "the scorer and the world are not Tex");
  const jobs = AREA_LIMITS.jobs;
  assert.equal(jobs.pool, "jobs", "a job task's whole job never eats the cheap areas' $1");
  assert.deepEqual(jobs.reruns, { branch: 1, main: 1 });
  assert.ok(jobs.usdPerCase * (7 + 3 * 2) <= jobs.maxUsd, "seven tasks with three wrong stay inside the jobs cap");
  assert.equal(typeof RUNNERS.jobs, "function");
});

test("the core area's judged answers go to Context under the commit, and its key files never do", async () => {
  const { publishCoreRecords, recordsFolderFor } = await import("../replayGate.mjs");
  const { mkdtemp, writeFile: write } = await import("node:fs/promises");
  const { tmpdir } = await import("node:os");
  const { join: joinPath } = await import("node:path");
  const scratch = await mkdtemp(joinPath(tmpdir(), "records-"));
  await write(joinPath(scratch, "core-core-branch-1.md"), "answers and reasons");
  await write(joinPath(scratch, "core-core-branch-1 key.md"), "which setup wrote which answer");
  await write(joinPath(scratch, "respond-branch-1.json"), "[]");
  const writes = [];
  const fetchImpl = async (_url, init) => {
    const { params } = JSON.parse(init.body);
    if (params.name === "write_note") writes.push(params.arguments);
    const isError = params.name === "read_note"; // nothing there yet
    return new Response(JSON.stringify({ result: { content: [{ type: "text", text: isError ? "not found" : "ok" }], isError } }), { status: 200 });
  };
  const sha = "ab".repeat(20);
  const paths = await publishCoreRecords({ scratch, sha, connection: { endpoint: "https://example.invalid/mcp", accessToken: "t" }, fetchImpl });
  assert.deepEqual(paths, [`${recordsFolderFor(sha)}/core-core-branch-1.md`]);
  assert.equal(recordsFolderFor(sha), "ai/results/replay/abababababab");
  assert.deepEqual(writes.map((w) => [w.path, w.content]), [[paths[0], "answers and reasons"]]);
  await assert.rejects(publishCoreRecords({ scratch, sha: "../x", connection: {}, fetchImpl }), /not a commit sha/);
});
