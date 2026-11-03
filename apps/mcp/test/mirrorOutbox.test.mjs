// The workspace object's outbox of changes not yet mirrored to Convex (`src/workspaceStore/mirrorOutbox.js`):
// queued in the order taken, read oldest first, dropped once the mirror has them, counted for the readout.
import { test } from "node:test";
import assert from "node:assert/strict";

import { mirrorOutbox } from "../src/workspaceStore/mirrorOutbox.js";
import { durableSqlite } from "./durableSqlite.mjs";

test("changes are read back oldest first, each with its workspace and its change, and seq rises", () => {
  const outbox = mirrorOutbox(durableSqlite().sql);
  const a = outbox.enqueue("ws_a", { op: "wrote", record: { path: "a.md", etag: "e1" }, objectAt: 5 }, 100);
  const b = outbox.enqueue("ws_b", { op: "wrote", record: { path: "b.md", etag: "e2" }, objectAt: 6 }, 101);
  const c = outbox.enqueue("ws_a", { op: "wrote", record: { path: "c.md", etag: "e3" }, objectAt: 7 }, 102);
  assert.ok(a < b && b < c);
  assert.deepEqual(outbox.pending(), [
    { seq: a, workspaceId: "ws_a", change: { op: "wrote", record: { path: "a.md", etag: "e1" }, objectAt: 5 } },
    { seq: b, workspaceId: "ws_b", change: { op: "wrote", record: { path: "b.md", etag: "e2" }, objectAt: 6 } },
    { seq: c, workspaceId: "ws_a", change: { op: "wrote", record: { path: "c.md", etag: "e3" }, objectAt: 7 } },
  ]);
});

test("pending takes at most the limit, oldest first", () => {
  const outbox = mirrorOutbox(durableSqlite().sql);
  for (let n = 1; n <= 5; n += 1) outbox.enqueue("ws_a", { op: "wrote", n }, n);
  assert.deepEqual(outbox.pending(2).map((item) => item.change.n), [1, 2]);
  assert.deepEqual(outbox.pending().map((item) => item.change.n), [1, 2, 3, 4, 5]);
});

test("drop forgets exactly the seqs named, and the rest stay in order", () => {
  const outbox = mirrorOutbox(durableSqlite().sql);
  const seqs = [1, 2, 3, 4].map((n) => outbox.enqueue("ws_a", { op: "wrote", n }, n));
  outbox.drop([seqs[0], seqs[2]]);
  assert.deepEqual(outbox.pending().map((item) => item.seq), [seqs[1], seqs[3]]);
  assert.equal(outbox.count(), 2);
  outbox.drop([]);
  assert.equal(outbox.count(), 2);
});

test("a dropped change is not re-read, and a new change after a drop still gets a fresh seq", () => {
  const outbox = mirrorOutbox(durableSqlite().sql);
  const first = outbox.enqueue("ws_a", { op: "wrote", n: 1 }, 1);
  outbox.drop([first]);
  const second = outbox.enqueue("ws_a", { op: "wrote", n: 2 }, 2);
  assert.ok(second > first, "AUTOINCREMENT never reuses a seq");
  assert.deepEqual(outbox.pending().map((item) => item.seq), [second]);
});

test("stats counts what is pending, what the mirror skipped and what failed to send", () => {
  const outbox = mirrorOutbox(durableSqlite().sql);
  assert.deepEqual(outbox.stats(), { pending: 0, skipped: 0, failures: 0 });
  outbox.enqueue("ws_a", { op: "wrote" }, 1);
  outbox.enqueue("ws_a", { op: "wrote" }, 2);
  outbox.noteSkipped(2);
  outbox.noteSkipped(0);
  outbox.noteFailure();
  outbox.noteFailure();
  assert.deepEqual(outbox.stats(), { pending: 2, skipped: 2, failures: 2 });
});

test("a change must name its workspace, be an object and carry a clock", () => {
  const outbox = mirrorOutbox(durableSqlite().sql);
  assert.throws(() => outbox.enqueue("", { op: "wrote" }, 1), TypeError);
  assert.throws(() => outbox.enqueue("ws_a", "wrote", 1), TypeError);
  assert.throws(() => outbox.enqueue("ws_a", { op: "wrote" }, Number.NaN), TypeError);
  assert.equal(outbox.count(), 0);
});

test("the queue and its counters survive a second outbox opened on the same storage", () => {
  const { sql } = durableSqlite();
  mirrorOutbox(sql).enqueue("ws_a", { op: "wrote" }, 1);
  mirrorOutbox(sql).noteFailure();
  const reopened = mirrorOutbox(sql);
  assert.equal(reopened.count(), 1);
  assert.deepEqual(reopened.stats(), { pending: 1, skipped: 0, failures: 1 });
});
