/**
 * The gateway consumes no queue. The retired job queues were deleted on the
 * Cloudflare side (2026-10-26), so the empty `queue` handler that kept uploads
 * working while they still named this Worker is gone too. A handler or a
 * queue binding coming back means a queue was brought back without a design.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import worker from "../src/index.js";

test("the gateway has no queue handler and binds no queue", async () => {
  assert.equal(worker.queue, undefined);
  const config = await readFile(new URL("../wrangler.toml", import.meta.url), "utf8");
  assert.doesNotMatch(config, /^\s*\[\[(?:env\.\w+\.)?queues\./m);
});
