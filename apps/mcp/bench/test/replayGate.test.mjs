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

import { areasFor, feedback, heldOutJson, markHeldOut, regressions, rowsFor } from "../replayGate.mjs";

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
