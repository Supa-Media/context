/**
 * THE REPLAY GATE'S MODEL HALF (`bench/replayGate.mjs`; Dev2, 2026-11-13).
 *
 * Sabotage record (applied, run, observed failing, reverted, 2026-11-13):
 *  1. `regressions` counting a single wrong run as a regression -> "noise is not a regression" fails;
 *  2. `feedback` printing a held-out case's id -> "a held-out case is reported by its cause alone" fails;
 *  3. `areasFor` sending every Tex file to every area -> "a change runs only the areas its files reach" fails.
 */
import assert from "node:assert/strict";
import { test } from "node:test";

import { areasFor, feedback, gate, heldOutJson, markHeldOut, mergeRuns, regressions, rowsFor } from "../replayGate.mjs";

test("a change runs only the areas its files reach, and plumbing alone runs none", () => {
  assert.deepEqual(areasFor(["packages/shared/src/textDecide.cjs"]), ["respond"]);
  assert.deepEqual(areasFor(["apps/mcp/src/agent/replyJudge.js"]), ["review"]);
  assert.deepEqual(areasFor(["apps/mcp/bench/review/chat.json", "apps/mcp/bench/respond/cases.json"]), ["respond", "review"]);
  assert.deepEqual(areasFor(["apps/mcp/bench/respond.mjs", "apps/mcp/bench/review.mjs"]), [], "the scorers are not Tex");
  assert.deepEqual(areasFor(["apps/mcp/src/agent/warmCopy.js", "apps/mobile/app/index.tsx"]), []);
});

test("noise is not a regression: a case regresses only when the change is wrong in most runs and main right in most", () => {
  assert.deepEqual(regressions({ a: [false, true, true] }, { a: [true, true, true] }), [], "wrong once, right twice: noise");
  assert.deepEqual(regressions({ a: [false, false, true] }, { a: [true, true, false] }), ["a"]);
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
    branch: { ok: [true], broke: [false, false, true], flaky: [false, true, true], "t-known": [false, false, false] },
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
  assert.deepEqual(areasFor(["apps/mcp/src/agent/turnWeb.js", "apps/mcp/src/agent/jobNote.js"]), []);
});
