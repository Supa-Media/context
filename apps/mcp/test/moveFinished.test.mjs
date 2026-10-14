/**
 * When a `materialize_move` pass says a legacy move needs no more passes.
 *
 * The queue consumer, the owner's resume and the bulk tests all asked
 * `text.includes("complete")`, which "move <id>: reference inventory complete"
 * also answers: the queued worker reported the move complete and stopped one
 * step in, until an owner's call revived it. Sabotage: `moveFinished` as
 * `text.includes("complete")` fails the first check.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { moveFinished } from "../src/moves/jobs.js";

test("a finished inventory is a step, not the end of the move", () => {
  assert.equal(moveFinished("move move-abc: reference inventory complete"), false);
  assert.equal(moveFinished("move move-abc: copying\nphysical storage sync: 20/501"), false);
});

test("a completed move, or one with no work, needs no more passes", () => {
  assert.equal(moveFinished("move move-abc: complete\nphysical storage sync: complete\nreferences rewritten: 2"), true);
  assert.equal(moveFinished("move move-abc: complete\nphysical storage sync: no active work"), true);
});
