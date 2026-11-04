/**
 * A chat's job slots: three in the cloud, and each computer's own
 * (`agent/jobSlots.js`, Dev, 2026-11-04: "count machine slots separately from
 * the 3 cloud slots").
 *
 * ## Sabotage record
 *
 * Applied, suite run, named check observed failing, reverted.
 *
 *  1. `jobSlots` counting a computer's jobs against the cloud's three.
 *     → "jobs on a computer leave the cloud's three free" fails.
 *  2. `room` ignoring a computer's own slots.
 *     → "a computer takes as many jobs as its slots, and says so when full" fails.
 *  3. `runningJobsOf` dropping `on`.
 *     → "a running job on a computer is read as on it" fails.
 */

import assert from "node:assert/strict";
import { test } from "node:test";

import { MAX_CLOUD_JOBS, MAX_MACHINE_SLOTS, jobSlots, machineOf, slotsOf } from "../src/agent/jobSlots.js";
import { backgroundSession, runningJobsOf, withBackground } from "../src/agent/background.js";

const NOW = Date.UTC(2026, 10, 4, 15, 0, 0);
const STUDIO = { workspaceId: "ws_maya", id: "mch_studio1", name: "Studio Mac", online: true, tools: ["claude", "codex"], folders: ["~/code"], ownerId: "u1", slots: 2 };
const words = (result) => result.content.map((part) => part.text).join("");
const NAMES = ["", "Trip research", "Gift ideas", "Tax forms"];
const run = (n, on = null) => ({ id: `job-slots-${n}0000`, title: NAMES[n], state: "running", startedAt: NOW - 1, ...(on ? { on } : {}) });

test("a computer's slots are its owner's count, one when unnamed, never over the most", () => {
  assert.equal(slotsOf({ slots: 3 }), 3);
  assert.equal(slotsOf({}), 1);
  assert.equal(slotsOf({ slots: 40 }), MAX_MACHINE_SLOTS);
  assert.equal(slotsOf({ slots: 0 }), 1);
  assert.equal(machineOf({ on: "mch_studio1" }), "mch_studio1");
  assert.equal(machineOf({ machine: { machineId: "mch_studio1" } }), "mch_studio1");
  assert.equal(machineOf({ title: "cloud" }), null);
});

test("a running job on a computer is read as on it", () => {
  const [entry, cloud] = runningJobsOf([run(1, "mch_studio1"), run(2)]);
  assert.equal(entry.on, "mch_studio1");
  assert.equal(cloud.on, null);
  assert.equal(runningJobsOf([{ ...run(3), on: "../x" }])[0].on, null, "a malformed id is no computer");
});

test("jobs on a computer leave the cloud's three free", async () => {
  const background = backgroundSession({ running: runningJobsOf([run(1, STUDIO.id), run(2, STUDIO.id)]), job: null, now: NOW, machines: async () => [STUDIO] });
  assert.equal(background.freeSlots(), MAX_CLOUD_JOBS);
  assert.equal(background.freeOn(STUDIO), 0);
  const call = withBackground(background, async () => ({ content: [] }));
  for (const title of ["Flights to Lisbon", "Dinner spots", "Packing list"]) assert.equal((await call("start_background_job", { title, brief: "b" })).isError, undefined, title);
  const fourth = await call("start_background_job", { title: "Physio near her", brief: "b" });
  assert.equal(fourth.isError, true);
  assert.match(words(fourth), /3 jobs are already running in the cloud/);
});

test("a computer takes as many jobs as its slots, and says so when full", async () => {
  const background = backgroundSession({ running: runningJobsOf([run(1), run(2), run(3)]), job: null, now: NOW, machines: async () => [STUDIO] });
  const call = withBackground(background, async () => ({ content: [] }));
  for (const title of ["Weekly digest routine", "Digest card drawing"]) assert.equal((await call("start_background_job", { title, brief: "b", on_computer: { name: "Studio Mac" } })).isError, undefined, title);
  const third = await call("start_background_job", { title: "Fix the login bug", brief: "b", on_computer: { name: "Studio Mac" } });
  assert.equal(third.isError, true);
  assert.match(words(third), /Every slot on "Studio Mac" is taken/);
  assert.deepEqual(background.started.map((job) => job.machine.machineId), [STUDIO.id, STUDIO.id]);
  const slots = jobSlots(() => [{ on: STUDIO.id }]);
  assert.equal(slots.room(STUDIO), true);
  assert.equal(slots.room(null), true);
});
