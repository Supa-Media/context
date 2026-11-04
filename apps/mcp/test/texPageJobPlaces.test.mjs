/**
 * Where a Tex page job runs (`src/http/texPage/jobs.js`): a job on one of the
 * person's computers holds that computer's slot, never a cloud one, and its
 * summary names the computer, so the page can tell a computer's job from a
 * cloud job (owner, 2026-11-04).
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { jobDetail, jobsOverview, readJob, slotsOf } from "../src/http/texPage/jobs.js";

const NOW = Date.UTC(2026, 10, 4, 14, 0);
const raw = (id, startedAt, extra = {}) => ({ id, title: `Job ${id}`, state: "running", startedAt, steps: [{ at: startedAt, text: "shell run git" }], ...extra });
const vm = { id: "mch_1", name: "Cloud VM", tool: "claude" };

test("a computer's job is read with its computer, and a cloud job without one", () => {
  assert.deepEqual(readJob(raw("a", NOW - 10, { on: vm })).on, { id: "mch_1", name: "Cloud VM", tool: "Claude Code" });
  assert.equal(readJob(raw("b", NOW - 10)).on, undefined);
  // A malformed id is dropped whole; a missing name reads as "your computer".
  assert.equal(readJob(raw("c", NOW - 10, { on: { id: "../x", name: "x" } })).on, undefined);
  assert.deepEqual(readJob(raw("d", NOW - 10, { on: { id: "mch_2" } })).on, { id: "mch_2", name: "your computer" });
});

test("a computer's job takes that computer's slot, and the cloud keeps its three free", () => {
  const jobs = [raw("vm1", NOW - 30, { on: vm }), raw("cloud1", NOW - 20), raw("vm2", NOW - 10, { on: vm })].map(readJob);
  const slots = slotsOf(jobs);
  assert.equal(slots.get("vm1"), 1);
  assert.equal(slots.get("vm2"), 2);
  assert.equal(slots.get("cloud1"), 1);
  const { minions, status } = jobsOverview(jobs, NOW);
  assert.equal(status.jobs, 3);
  assert.deepEqual(minions.filter((slot) => slot.place === undefined).map((slot) => slot.job?.id ?? null), ["cloud1", null, null]);
  assert.deepEqual(minions.filter((slot) => slot.place === "mch_1").map((slot) => [slot.slot, slot.job.id]), [[1, "vm1"], [2, "vm2"]]);
});

test("four cloud jobs still fill only three cloud slots, whatever runs on a computer", () => {
  const jobs = [1, 2, 3, 4].map((n) => readJob(raw(`c${n}`, NOW - 100 + n))).concat([readJob(raw("vm", NOW, { on: vm }))]);
  const slots = slotsOf(jobs);
  assert.equal(slots.has("c4"), false);
  assert.equal(slots.get("vm"), 1);
});

test("a job's summary and page say where it runs, in words", () => {
  const job = readJob(raw("vm1", NOW - 30, { on: vm }));
  const detail = jobDetail(job, 1);
  assert.equal(detail.ranOn, "On Cloud VM");
  assert.equal(detail.tool, "Claude Code");
  assert.equal(detail.machine, "mch_1");
  assert.equal(detail.machineName, "Cloud VM");
  const cloud = jobDetail(readJob(raw("c", NOW - 30)), 1);
  assert.equal(cloud.ranOn, undefined);
  assert.equal(cloud.machine, undefined);
  // Finished today, it still says where it ran under "Earlier today".
  const done = readJob(raw("vm2", NOW - 60_000, { on: vm, state: "done", finishedAt: NOW - 1_000 }));
  assert.equal(jobsOverview([done], NOW).earlier[0].ranOn, "On Cloud VM");
});
