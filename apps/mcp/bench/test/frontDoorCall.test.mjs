/**
 * Which model call is Tex's Front door (`bench/frontDoorCall.mjs`). A quiet row's words must come from the Front
 * door's own last call, not from a reviewer, judge or summary that ran after it (Lab, 2026-11-18: quiet group rows
 * showed words about an earlier topic). Sabotage record: `lastFrontDoorCall` returning `calls.at(-1)` → the first
 * test fails; dropping the `cf-aig-metadata` read in `modelLog.mjs` → the modelLog test fails.
 */
import assert from "node:assert/strict";
import { test } from "node:test";

import { isFrontDoorCall, lastFrontDoorCall, quietCallsOf } from "../frontDoorCall.mjs";

const call = (client, text, { feature = "assistant" } = {}) => ({
  metadata: client === undefined ? undefined : { feature, client },
  answer: { content: [{ type: "text", text }] },
});

test("the Front door's last call is the one a quiet row reads, not a reviewer's that ran after it", () => {
  const calls = [call("texts", "I'll check the calendar."), call("texts", "Still looking."), call("reviewer", "a reviewer's words about an old topic")];
  assert.equal(lastFrontDoorCall(calls), calls[1]);
  assert.deepEqual(quietCallsOf(calls), [calls[1]]);
});

test("a group's Front door call counts too, and a summary or judge call never does", () => {
  assert.equal(isFrontDoorCall(call("texts-group", "x")), true);
  for (const client of ["reviewer", "day-summary", "threads", "job-check", "advisor", "reflect"]) assert.equal(isFrontDoorCall(call(client, "x")), false, client);
  assert.equal(isFrontDoorCall(call("texts", "x", { feature: "bench" })), false, "the feature must be the assistant's");
});

test("with no call that can be told, the old reading stands: the turn's last call", () => {
  const plain = [{ answer: { content: [{ type: "text", text: "one" }] } }, { answer: { content: [{ type: "text", text: "two" }] } }];
  assert.deepEqual(quietCallsOf(plain), [plain[1]], "no metadata at all");
  const judgeOnly = [call("reviewer", "judge only")];
  assert.deepEqual(quietCallsOf(judgeOnly), [judgeOnly[0]], "no Front door call in the turn");
  assert.deepEqual(quietCallsOf([]), [], "no call at all");
});
