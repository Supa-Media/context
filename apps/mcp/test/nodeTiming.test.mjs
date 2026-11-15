/**
 * What a node's logged time covers (Dev2, 2026-11-15: "The Text them node doesnt seem to be logging the actual time it
 * takes, 3 nodes are actually logging as 0s ... not sure how this is slipping by"). The runner's `own` time reaches the
 * ledger beside the whole run, and the texting Worker's delivery of a reply (Text them's own work, which runs after the
 * gateway answered) is kept under the turn it delivers.
 *
 * Sabotage: drop the `own` line in `ledger.js` `nodeEntry` and the first test fails; drop `turn` from
 * `workerStepEntry` and the second does.
 */
import { test } from "node:test";
import assert from "node:assert/strict";

import { eventEntry, nodeEntry } from "../src/agent/ledger.js";

test("a node's entry keeps its whole run and its own time, never more own than whole", () => {
  const e = nodeEntry({ node: "checks", input: {}, output: {}, ms: 4595, own: 2.4, ok: true, via: "wait" }, { turn: "t-1", at: 1 });
  assert.deepEqual([e.name, e.ms, e.own], ["checks", 4595, 2]);
  assert.equal(nodeEntry({ node: "send", ms: 10, own: 99, ok: true }, { at: 1 }).own, 10);
  assert.equal("own" in nodeEntry({ node: "send", ms: 10, ok: true }, { at: 1 }), false);
});

test("the Worker's delivery of a reply is a send step under the turn it delivers, with its time", () => {
  const e = eventEntry({ id: "1794772822042-001207", at: 1794772822042, kind: "step", chat: "texts", turn: "c0b69277-aaaa", step: { name: "send", of: "delivery", ok: true, ms: 470, input: { parts: 1 }, output: { sent: 1 } } });
  assert.deepEqual([e.kind, e.step, e.name, e.turn, e.ms, e.ok], ["step", "send", "delivery", "c0b69277-aaaa", 470, true]);
});
