/**
 * THE REPLAY GATE'S SAMPLE (`bench/gateSample.mjs`; Dev2, 2026-11-15: cut the reply checker, Decide and the jobs a
 * change's replay runs, for speed).
 *
 * Sabotage record (applied, run, observed failing, reverted, 2026-11-15):
 *  1. `spread` ignoring its limit -> "each unit step runs 20 cases" fails;
 *  2. `changedIds` ignoring edits -> "a case the change adds or edits always runs" fails;
 *  3. `inSample` dropping held-out cases -> "held-out cases always run" fails.
 */
import assert from "node:assert/strict";
import { test } from "node:test";

import { changedIds, GATE_JOB_TASKS, inSample, jobsSample, respondSample, reviewSample, spread, UNIT_LIMIT } from "../gateSample.mjs";
import { loadCases as loadRespond } from "../respond.mjs";
import { loadCases } from "../jobTasks.mjs";
import { GATE_SAMPLED } from "../replayGate.mjs";
import { loadSets } from "../review.mjs";

const set = (name, faults, good) => [...Array.from({ length: faults }, (_, i) => ({ id: `${name}/f${i}`, fault: true })), ...Array.from({ length: good }, (_, i) => ({ id: `${name}/g${i}`, fault: false }))];

test("a reviewer sample covers every set before taking a second from any, both kinds alike", () => {
  const sets = { a: set("a", 5, 6), b: set("b", 1, 3), c: set("c", 4, 4) };
  assert.equal(UNIT_LIMIT, 20);
  assert.deepEqual(spread([[1, 2, 3], [4], [5, 6]], 4), [1, 4, 5, 2]);
  const small = [...reviewSample(sets, sets)];
  assert.equal(small.length, 20, "every case of these 21 but one");
  const three = spread([["a/f0", "a/g0"], ["b/g0", "b/f0"], ["c/f0", "c/g0"]], 3);
  assert.deepEqual(three, ["a/f0", "b/g0", "c/f0"], "neighbouring sets start on opposite kinds");
});

test("a case the change adds or edits always runs", () => {
  const base = { a: set("a", 5, 5) };
  const head = { a: [...base.a.map((item) => (item.id === "a/f4" ? { ...item, reply: "edited" } : item)), { id: "a/new", fault: true }] };
  assert.deepEqual([...changedIds(head.a, base.a)].sort(), ["a/f4", "a/new"]);
  const sample = reviewSample(head, base);
  assert.ok(sample.has("a/f4") && sample.has("a/new"));
  const many = { a: set("a", 30, 30) };
  const grown = { a: [...many.a, { id: "a/new", fault: true }] };
  assert.equal(reviewSample(grown, many).size, 21, "the 20 and the new case");
  const replies = [{ id: "r1", want: "reply" }, { id: "added", want: "hush" }];
  assert.ok(respondSample(replies, replies.slice(0, 1)).has("added"));
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

test("on the real cases each unit step runs 20, spread over every set and kind, and jobs runs one task of each kind", async () => {
  const sets = await loadSets();
  const review = [...reviewSample(sets, sets)];
  assert.equal(review.length, 20);
  assert.equal(new Set(review.map((id) => id.split("/")[0])).size, Object.keys(sets).length, "every reviewer set is in it");
  const faults = Object.values(sets).flat().filter((item) => review.includes(item.id) && item.fault).length;
  assert.ok(faults >= 8 && faults <= 12, `${faults} faults of 20`);
  const decide = await loadRespond();
  const picked = decide.filter((item) => respondSample(decide, decide).has(item.id));
  assert.equal(picked.length, 20);
  assert.ok(picked.some((item) => item.must) && picked.some((item) => item.want === "hush") && picked.some((item) => item.want !== "hush" && !item.must));
  const tasks = await loadCases();
  const kept = tasks.filter((item) => jobsSample(tasks, tasks).has(item.id));
  assert.deepEqual(kept.map((item) => item.id).sort(), [...GATE_JOB_TASKS].sort(), "every gate task still exists");
  assert.deepEqual(new Set(kept.map((item) => item.kind)), new Set(tasks.map((item) => item.kind)), "one task of each kind");
  assert.deepEqual([...GATE_SAMPLED].sort(), ["jobs", "respond", "review"]);
});
