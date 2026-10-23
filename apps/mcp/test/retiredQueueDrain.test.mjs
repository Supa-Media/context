/**
 * The retired byte-move queue's consumer is still attached to this Worker on
 * Cloudflare, which refuses a deploy with no `queue` handler. The handler only
 * acknowledges what is left, so nothing is retried and nothing runs.
 *
 * Sabotage: delete `queue` from the default export and the first case fails
 * (and staging's "Deploy mcp" fails with Cloudflare code 11001).
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import worker from "../src/index.js";

test("the gateway still exports a queue handler", () => {
  assert.equal(typeof worker.queue, "function");
});

test("every message left on the retired queue is acknowledged and dropped", async () => {
  const acked = [];
  const messages = [1, 2, 3].map((id) => ({
    id,
    body: { kind: "move" },
    ack: () => acked.push(id),
    retry: () => assert.fail("a retired job is never retried"),
  }));
  await worker.queue({ messages }, {});
  assert.deepEqual(acked, [1, 2, 3]);
});

test("an empty batch is fine", async () => {
  await worker.queue({ messages: [] }, {});
  await worker.queue(undefined, {});
});
