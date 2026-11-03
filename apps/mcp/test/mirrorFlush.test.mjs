// The flush that sends a workspace object's queued changes to Convex (`src/workspaceStore/mirrorFlush.js`): what the
// mirror took or refused leaves the queue, what it did not take stays, one flush runs at a time, and a change's
// content never reaches a log.
import { test } from "node:test";
import assert from "node:assert/strict";

import { mirrorOutbox } from "../src/workspaceStore/mirrorOutbox.js";
import { flushMirror } from "../src/workspaceStore/mirrorFlush.js";
import { durableSqlite } from "./durableSqlite.mjs";

/** A store with a queue of `changes` (`[workspaceId, n]`), and a log that keeps every line. */
function harness(changes) {
  const store = { mirror: mirrorOutbox(durableSqlite().sql) };
  const seqs = changes.map(([workspaceId, n]) => store.mirror.enqueue(workspaceId, { op: "wrote", record: { path: `note-${n}.md`, etag: `e${n}` }, objectAt: n }, n));
  const lines = [];
  const log = (event, fields) => lines.push({ event, ...fields });
  return { store, seqs, lines, log };
}

test("what the mirror applied or skipped leaves the queue; a skip is counted and logged with ids only", async () => {
  const { store, seqs, lines, log } = harness([["ws_a", 1], ["ws_a", 2], ["ws_a", 3]]);
  const sent = [];
  const result = await flushMirror(store, async (workspaceId, changes) => {
    sent.push({ workspaceId, changes });
    return { applied: [seqs[0], seqs[1]], skipped: [{ seq: seqs[2], reason: "older" }] };
  }, log);
  assert.deepEqual(result, { done: true });
  assert.equal(store.mirror.count(), 0);
  assert.deepEqual(sent, [{ workspaceId: "ws_a", changes: [
    { seq: seqs[0], op: "wrote", record: { path: "note-1.md", etag: "e1" }, objectAt: 1 },
    { seq: seqs[1], op: "wrote", record: { path: "note-2.md", etag: "e2" }, objectAt: 2 },
    { seq: seqs[2], op: "wrote", record: { path: "note-3.md", etag: "e3" }, objectAt: 3 },
  ] }]);
  assert.equal(store.mirror.stats().skipped, 1);
  assert.deepEqual(lines, [{ event: "workspace_mirror_skipped", seq: seqs[2], reason: "older" }]);
  assert.equal(JSON.stringify(lines).includes("note-3"), false, "a skipped change's path never reaches the log");
});

test("a stopped answer drops what it took and keeps the rest: done is false and the failure is counted", async () => {
  const { store, seqs, lines, log } = harness([["ws_a", 1], ["ws_a", 2], ["ws_a", 3]]);
  const result = await flushMirror(store, async () => ({ applied: [seqs[0]], stopped: true }), log);
  assert.deepEqual(result, { done: false });
  assert.deepEqual(store.mirror.pending().map((item) => item.seq), [seqs[1], seqs[2]]);
  assert.equal(store.mirror.stats().failures, 1);
  assert.deepEqual(lines.map((line) => line.event), ["workspace_mirror_failed"]);
  assert.equal(lines[0].reason, "stopped");
});

test("a throw keeps everything queued, counts the failure and logs no change content", async () => {
  const { store, lines, log } = harness([["ws_a", 1], ["ws_a", 2]]);
  const result = await flushMirror(store, async () => {
    throw new Error("control plane unreachable: note-1.md");
  }, log);
  assert.deepEqual(result, { done: false });
  assert.equal(store.mirror.count(), 2);
  assert.equal(store.mirror.stats().failures, 1);
  assert.deepEqual(lines.map((line) => line.event), ["workspace_mirror_failed"]);
  assert.equal(JSON.stringify(lines).includes("note-1"), false);
});

test("an answer that names none of a group neither drops it nor loops: the flush stops and the changes stay", async () => {
  const { store } = harness([["ws_a", 1]]);
  let calls = 0;
  const result = await flushMirror(store, async () => {
    calls += 1;
    return {};
  }, () => {});
  assert.deepEqual(result, { done: false });
  assert.equal(calls, 1);
  assert.equal(store.mirror.count(), 1);
});

test("two flushes at once send each change once: the second waits for the first, then finds nothing left", async () => {
  const { store } = harness([["ws_a", 1], ["ws_a", 2]]);
  let calls = 0;
  const send = async (_workspaceId, changes) => {
    calls += 1;
    await new Promise((resolve) => setTimeout(resolve, 5));
    return { applied: changes.map((change) => change.seq) };
  };
  const [first, second] = await Promise.all([flushMirror(store, send, () => {}), flushMirror(store, send, () => {})]);
  assert.deepEqual(first, { done: true });
  assert.deepEqual(second, { done: true });
  assert.equal(calls, 1, "one batch of both changes, sent once");
  assert.equal(store.mirror.count(), 0);
  assert.equal(store.mirrorRunning, null, "no flush is left marked as running");
});

test("a second flush that arrives after the first failed sends again, once", async () => {
  const { store } = harness([["ws_a", 1]]);
  let attempt = 0;
  const send = async (_workspaceId, changes) => {
    attempt += 1;
    if (attempt === 1) throw new Error("down");
    return { applied: changes.map((change) => change.seq) };
  };
  assert.deepEqual(await flushMirror(store, send, () => {}), { done: false });
  assert.deepEqual(await flushMirror(store, send, () => {}), { done: true });
  assert.equal(attempt, 2);
  assert.deepEqual(store.mirror.pending(), []);
});

test("changes are sent in runs of one workspace, in the order taken", async () => {
  const { store, seqs } = harness([["ws_a", 1], ["ws_b", 2], ["ws_a", 3]]);
  const runs = [];
  const result = await flushMirror(store, async (workspaceId, changes) => {
    runs.push([workspaceId, changes.map((change) => change.seq)]);
    return { applied: changes.map((change) => change.seq) };
  }, () => {});
  assert.deepEqual(result, { done: true });
  assert.deepEqual(runs, [["ws_a", [seqs[0]]], ["ws_b", [seqs[1]]], ["ws_a", [seqs[2]]]]);
});

test("a queue longer than one batch is drained in batches of 100 until it is empty", async () => {
  const changes = Array.from({ length: 150 }, (_, index) => ["ws_a", index + 1]);
  const { store } = harness(changes);
  const sizes = [];
  const result = await flushMirror(store, async (_workspaceId, batch) => {
    sizes.push(batch.length);
    return { applied: batch.map((change) => change.seq) };
  }, () => {});
  assert.deepEqual(result, { done: true });
  assert.deepEqual(sizes, [100, 50]);
});
