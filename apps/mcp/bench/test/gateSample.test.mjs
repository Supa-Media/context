/**
 * THE REPLAY GATE'S SAMPLE (`bench/gateSample.mjs`; Dev2, 2026-11-15: cut the reply checker and the jobs a change's
 * replay runs, for speed).
 *
 * Sabotage record (applied, run, observed failing, reverted, 2026-11-15):
 *  1. `reviewSample` keeping every case -> "the reviewer sample is two faults and two good replies a set" fails;
 *  2. `changedIds` ignoring edits -> "a case the change adds or edits always runs" fails;
 *  3. `inSample` dropping held-out cases -> "held-out cases always run" fails.
 */
import assert from "node:assert/strict";
import { test } from "node:test";

import { changedIds, GATE_JOB_TASKS, inSample, jobsSample, REVIEW_PER_KIND, reviewSample } from "../gateSample.mjs";
import { loadCases } from "../jobTasks.mjs";
import { GATE_SAMPLED } from "../replayGate.mjs";
import { loadSets } from "../review.mjs";

const set = (name, faults, good) => [...Array.from({ length: faults }, (_, i) => ({ id: `${name}/f${i}`, fault: true })), ...Array.from({ length: good }, (_, i) => ({ id: `${name}/g${i}`, fault: false }))];

test("the reviewer sample is two faults and two good replies a set, the first in file order", () => {
  const sets = { a: set("a", 5, 6), b: set("b", 1, 3) };
  assert.equal(REVIEW_PER_KIND, 2);
  assert.deepEqual([...reviewSample(sets, sets)].sort(), ["a/f0", "a/f1", "a/g0", "a/g1", "b/f0", "b/g0", "b/g1"]);
});

test("a case the change adds or edits always runs", () => {
  const base = { a: set("a", 5, 5) };
  const head = { a: [...base.a.map((item) => (item.id === "a/f4" ? { ...item, reply: "edited" } : item)), { id: "a/new", fault: true }] };
  assert.deepEqual([...changedIds(head.a, base.a)].sort(), ["a/f4", "a/new"]);
  const sample = reviewSample(head, base);
  assert.ok(sample.has("a/f4") && sample.has("a/new"));
  assert.equal(sample.size, 6);
  const jobs = [{ id: GATE_JOB_TASKS[0] }, { id: "other" }, { id: "added" }];
  assert.deepEqual([...jobsSample(jobs, jobs.slice(0, 2))].sort(), ["added", GATE_JOB_TASKS[0]].sort());
});

test("held-out cases always run; no sample runs everything", () => {
  const keep = inSample(new Set(["a/f0"]));
  assert.ok(keep({ id: "a/f0" }));
  assert.ok(!keep({ id: "a/f1" }));
  assert.ok(keep({ id: "held-out/x", heldOut: true }));
  assert.ok(inSample(null)({ id: "anything" }));
});

test("on the real sets the gate runs about 60 reviewer cases and 3 job tasks, one of each kind", async () => {
  const sets = await loadSets();
  const sample = reviewSample(sets, sets);
  assert.ok(sample.size >= 50 && sample.size <= 70, `${sample.size} reviewer cases`);
  const tasks = await loadCases();
  const kept = tasks.filter((item) => jobsSample(tasks, tasks).has(item.id));
  assert.deepEqual(kept.map((item) => item.id).sort(), [...GATE_JOB_TASKS].sort(), "every gate task still exists");
  assert.deepEqual(new Set(kept.map((item) => item.kind)), new Set(tasks.map((item) => item.kind)), "one task of each kind");
  assert.deepEqual([...GATE_SAMPLED].sort(), ["jobs", "review"]);
});
