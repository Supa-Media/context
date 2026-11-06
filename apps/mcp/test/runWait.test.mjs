// A job's read of its run on a computer, held by the workspace object until the run moves (`workspaceStore/runWait.js`;
// Dev2, 2026-11-06: jobs wait on pushes, with a slow safety read, instead of reading every ten seconds).
// Sabotage: return the run at once in `heldRun` → "a held read answers when the run moves" fails (it answers the first
// look). Drop the asker check → "another person's run is refused before anything waits" fails.
import { test } from "node:test";
import assert from "node:assert/strict";
import { heldRun, runVersion, MAX_RUN_WAIT_MS } from "../src/workspaceStore/runWait.js";

const RUN = { runId: "run_1", askerId: "user_a", machineId: "m1", state: "running", lastStep: 1, steps: [{ seq: 1, tool: "Bash" }] };

function machinesWith(run) {
  const held = { run: { ...run } };
  return { held, machines: { run: (id) => (id === held.run.runId ? { ...held.run, steps: [...held.run.steps] } : null) } };
}

test("a held read answers when the run moves", async () => {
  const { held, machines } = machinesWith(RUN);
  let clock = 0;
  let looks = 0;
  const wait = async (ms) => {
    clock += ms;
    looks += 1;
    if (looks === 4) held.run = { ...held.run, lastStep: 2, steps: [...held.run.steps, { seq: 2, tool: "Edit" }] };
  };
  const answer = await heldRun(machines, { runId: "run_1", askerId: "user_a", seen: runVersion(RUN), waitMs: 50_000 }, { now: () => clock, wait });
  assert.equal(answer.lastStep, 2);
  assert.equal(looks, 4);
  assert.notEqual(runVersion(answer), runVersion(RUN));
});

test("a held read with nothing new ends at its wait, never past the cap", async () => {
  const { machines } = machinesWith(RUN);
  let clock = 0;
  const answer = await heldRun(machines, { runId: "run_1", seen: runVersion(RUN), waitMs: 10 * 60_000 }, { now: () => clock, wait: async (ms) => void (clock += ms) });
  assert.equal(runVersion(answer), runVersion(RUN));
  assert.equal(clock, MAX_RUN_WAIT_MS);
});

test("a read that names no version, or a run that ended, is answered at once", async () => {
  const { machines } = machinesWith(RUN);
  const never = { now: () => 0, wait: async () => assert.fail("it waited") };
  assert.equal((await heldRun(machines, { runId: "run_1", waitMs: 50_000 }, never)).runId, "run_1");
  const ended = machinesWith({ ...RUN, state: "ended", result: { outcome: "finished" } });
  assert.equal((await heldRun(ended.machines, { runId: "run_1", seen: "anything", waitMs: 50_000 }, never)).state, "ended");
});

test("another person's run is refused before anything waits", async () => {
  const { machines } = machinesWith(RUN);
  const never = { now: () => 0, wait: async () => assert.fail("it waited") };
  assert.equal(await heldRun(machines, { runId: "run_1", askerId: "user_b", seen: runVersion(RUN), waitMs: 50_000 }, never), null);
  assert.equal(await heldRun(machines, { runId: "run_2", seen: "x", waitMs: 50_000 }, never), null);
});
