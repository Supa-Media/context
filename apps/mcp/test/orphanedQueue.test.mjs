/**
 * The retired gateway job queue can still be bound to this Worker as its
 * consumer on the Cloudflare side, and a Worker named as a consumer cannot be
 * uploaded without a `queue` handler. Its messages describe byte moves that no
 * longer exist, so the handler only acknowledges them.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import worker from "../src/index.js";

test("a leftover queue message is acknowledged and nothing else happens", async () => {
  let acked = 0;
  let retried = 0;
  const batch = {
    queue: "old-jobs",
    messages: [{ id: "m1", body: { kind: "materialize_move" } }],
    ackAll: () => acked++,
    retryAll: () => retried++,
  };
  assert.equal(typeof worker.queue, "function");
  await worker.queue(batch, {});
  assert.equal(acked, 1);
  assert.equal(retried, 0);
});
