/**
 * The helpers left in `src/chaos/report.js` once writes stopped carrying the chaos line (owner, 2026-11-03):
 *
 *  1. `withChaosLines` adds nothing when there is nothing to say, or to an error.
 *  2. A line joins the answer without losing what the handler hid on it.
 *  3. `within` never holds its caller past the wait.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { withChaosLines, within } from "../src/chaos/report.js";
import { withActivityHint, activityHintOf } from "../src/live/activityHint.js";

test("nothing to say, nothing added", () => {
  const result = { content: [{ type: "text", text: "saved" }] };
  assert.equal(withChaosLines(result, ""), result);
  const error = { isError: true, content: [{ type: "text", text: "no" }] };
  assert.equal(withChaosLines(error, "mail: 1 new"), error);
});

test("a line joins the answer and the handler's hidden hint survives", () => {
  const result = withActivityHint({ content: [{ type: "text", text: "saved: a.md" }] }, { created: true });
  const next = withChaosLines(result, "mail: 1 new");
  assert.equal(next.content[0].text, "saved: a.md\nmail: 1 new");
  assert.deepEqual(activityHintOf(next), { created: true });
});

test("a slow promise never holds the caller up", async () => {
  const started = Date.now();
  const value = await within(new Promise(() => {}), 50);
  assert.equal(value, null);
  assert.ok(Date.now() - started < 1000);
  assert.equal(await within(Promise.reject(new Error("x")), 50), null);
  assert.equal(await within(Promise.resolve(7), 50), 7);
});
