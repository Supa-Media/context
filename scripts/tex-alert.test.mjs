/**
 * The 15 minute alert on Tex's group path (scripts/tex-alert.mjs): quiet when
 * healthy, and naming each failure of 2026-10-27 in codes and counts.
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import { problemsIn } from "./tex-alert.mjs";

const decide = (outcome, reason) => ({ event: "group_decide", outcome, ...(reason ? { reason } : {}) });
const turn = (outcome, reason) => ({ event: "group_turn", outcome, ...(reason ? { reason } : {}) });

test("a healthy window, or too few decides to judge, raises nothing", () => {
  assert.deepEqual(problemsIn([decide("answer"), decide("silent"), decide("unavailable", "timeout"), turn("workflow_answered")]), []);
  assert.deepEqual(problemsIn([decide("unavailable", "no_group"), decide("unavailable", "no_group")]), []);
  assert.deepEqual(problemsIn([]), []);
});

test("names decide failing on most calls, with its causes", () => {
  const [line] = problemsIn([decide("unavailable", "no_group"), decide("unavailable", "no_group"), decide("unavailable", "model_failed"), decide("answer")]);
  assert.equal(line, "group decide unavailable on 3 of 4 calls (causes: no_group 2, model_failed 1)");
});

test("names texts dropped as unbound, and turns the workflow could not run", () => {
  assert.deepEqual(problemsIn([turn("untagged_ignored", "unbound"), turn("untagged_kept", "style"), turn("workflow_unavailable"), { ...turn("workflow_gave_up", "agent:502"), kind: "routine" }]), [
    "1 untagged group texts dropped as unbound",
    "1 group turns: workflow_unavailable (kinds: asked 1)",
    "1 group turns: workflow_gave_up (reasons: agent:502 1; kinds: routine 1)",
  ]);
});

test("never carries anything but codes into the report", () => {
  const [line] = problemsIn([decide("unavailable", "x <script>+15555550101"), decide("unavailable"), decide("unavailable")]);
  assert.equal(line, "group decide unavailable on 3 of 3 calls (causes: other 1, unknown 2)");
  const [phone] = problemsIn([decide("unavailable", "15555550101"), decide("unavailable", "x"), decide("unavailable", "x")]);
  assert.doesNotMatch(phone, /5555550101/);
});
