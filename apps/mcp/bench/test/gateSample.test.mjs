/**
 * THE REPLAY GATE'S SAMPLE (`bench/gateSample.mjs`; Dev2, 2026-11-15: cut the reply checker, Decide and the jobs a
 * change's replay runs, for speed).
 *
 * Since 2026-11-15 every step keeps at most 20 cases (Dev2: "a max of 20 test cases per unit"), so only the jobs are
 * sampled; the cap itself fails `node scripts/tex-lab-data.mjs` (fast guards).
 *
 * Sabotage record (applied, run, observed failing, reverted, 2026-11-15):
 *  1. `changedIds` ignoring edits -> "a task the change adds or edits always runs" fails;
 *  2. `inSample` dropping held-out cases -> "held-out cases always run" fails.
 */
import assert from "node:assert/strict";
import { test } from "node:test";

import { changedIds, GATE_JOB_TASKS, inSample, jobsSample, UNIT_LIMIT } from "../gateSample.mjs";
import { loadCases as loadRespond } from "../respond.mjs";
import { loadCases } from "../jobTasks.mjs";
import { GATE_SAMPLED } from "../replayGate.mjs";
import { loadSets } from "../review.mjs";

test("a task the change adds or edits always runs", () => {
  const base = [{ id: "a" }, { id: "b" }];
  const head = [{ id: "a", reply: "edited" }, { id: "b" }, { id: "new" }];
  assert.deepEqual([...changedIds(head, base)].sort(), ["a", "new"]);
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

test("the reviewer and Decide keep at most UNIT_LIMIT cases each, every reviewer set and both kinds in; jobs runs one task of each kind", async () => {
  assert.equal(UNIT_LIMIT, 50);
  const sets = await loadSets();
  const review = Object.values(sets).flat();
  assert.ok(review.length <= UNIT_LIMIT, `${review.length} reviewer cases`);
  assert.ok(Object.values(sets).every((cases) => cases.length > 0), "every reviewer set keeps a case");
  const faults = review.filter((item) => item.fault).length;
  assert.ok(faults >= review.length * 0.4 && faults <= review.length * 0.6, `${faults} faults of ${review.length}`);
  const decide = await loadRespond();
  assert.ok(decide.length <= UNIT_LIMIT, `${decide.length} Decide cases`);
  assert.ok(decide.some((item) => item.must) && decide.some((item) => item.want === "hush") && decide.some((item) => item.want !== "hush" && !item.must));
  const tasks = await loadCases();
  const kept = tasks.filter((item) => jobsSample(tasks, tasks).has(item.id));
  assert.deepEqual(kept.map((item) => item.id).sort(), [...GATE_JOB_TASKS].sort(), "every gate task still exists");
  assert.deepEqual(new Set(kept.map((item) => item.kind)), new Set(tasks.map((item) => item.kind)), "one task of each kind");
  assert.deepEqual([...GATE_SAMPLED], ["jobs"]);
});
