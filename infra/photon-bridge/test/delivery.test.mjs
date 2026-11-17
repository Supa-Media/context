import assert from "node:assert/strict";
import test from "node:test";

import { createDeliveryWatch, statusEvent } from "../container/delivery.mjs";
import { createLedger } from "../container/ledger.mjs";

const LINE = "+15550100123";
const DM = "any;-;+15550100999";
const GROUP = "any;+;chat-fixture-1";

/** A clock whose timers run only when the test says so. */
function clock() {
  const timers = [];
  return {
    setTimer: (fn, ms) => {
      const timer = { fn, ms, cleared: false };
      timers.push(timer);
      return timer;
    },
    async run(ms) {
      for (const timer of timers.filter((t) => t.ms === ms && !t.cleared)) await timer.fn();
      await new Promise((resolve) => setImmediate(resolve));
    },
    timers,
  };
}

function watcher(reads) {
  const pushed = [];
  const logged = [];
  const c = clock();
  const watch = createDeliveryWatch({
    get: async (_line, guid) => {
      const next = reads[guid]?.shift();
      if (next instanceof Error) throw next;
      return next;
    },
    push: (line, event) => pushed.push({ line, event }),
    log: (record) => logged.push(record),
    setTimer: c.setTimer,
    after: [30, 180],
  });
  return { watch, pushed, logged, clock: c };
}

test("a send that answers with an error code is reported failed at once", () => {
  const { watch, pushed } = watcher({});
  watch.watch(LINE, DM, { guid: "g1", sendErrorCode: 22 });
  assert.equal(pushed.length, 1);
  assert.deepEqual(pushed[0].event.status, { targetGuid: "g1", state: "failed", code: 22 });
  assert.equal(pushed[0].event.type, "message.status");
  assert.equal(pushed[0].event.seq, null);
  assert.equal(watch.size(), 0);
});

test("a send read back with an error code is failed; one delivered stops being watched", async () => {
  const { watch, pushed, clock: c } = watcher({ bad: [{ sendErrorCode: 4 }], good: [{ sendErrorCode: 0, isDelivered: true }] });
  watch.watch(LINE, DM, { guid: "bad", sendErrorCode: 0 });
  watch.watch(LINE, GROUP, { guid: "good", sendErrorCode: 0 });
  await c.run(30);
  assert.equal(pushed.length, 1);
  assert.equal(pushed[0].event.status.state, "failed");
  assert.equal(pushed[0].event.status.code, 4);
  assert.equal(watch.size(), 0);
  await c.run(180);
  assert.equal(pushed.length, 1);
});

test("a send still not delivered at the last read is undelivered, never failed", async () => {
  const { watch, pushed, clock: c } = watcher({ slow: [{ sendErrorCode: 0, isDelivered: false }, { sendErrorCode: 0, isDelivered: false }] });
  watch.watch(LINE, GROUP, { guid: "slow", sendErrorCode: 0 });
  await c.run(30);
  assert.equal(pushed.length, 0);
  await c.run(180);
  assert.equal(pushed.length, 1);
  assert.deepEqual(pushed[0].event.status, { targetGuid: "slow", state: "undelivered" });
  assert.equal(pushed[0].event.chat.kind, "group");
});

test("a read that fails reports nothing and logs no words", async () => {
  const { watch, pushed, logged, clock: c } = watcher({ x: [new Error("down"), new Error("down")] });
  watch.watch(LINE, DM, { guid: "x", sendErrorCode: 0 });
  await c.run(30);
  await c.run(180);
  assert.equal(pushed.length, 0);
  assert.ok(logged.every((record) => record.event === "delivery.check" && !("text" in record)));
  assert.equal(watch.size(), 0);
});

test("a send with no guid or chat is not watched", () => {
  const { watch, pushed } = watcher({});
  watch.watch(LINE, DM, {});
  watch.watch(LINE, undefined, { guid: "g" });
  assert.equal(pushed.length, 0);
  assert.equal(watch.size(), 0);
});

test("a status event's id names the send and its state, so a repeat is the same event", () => {
  assert.equal(statusEvent(LINE, DM, "g", "failed", 3).eventId, "photon:message.status:g:failed");
});

test("an event the bridge pushes is queued without a sequence and moves no frontier when acked", () => {
  const ledger = createLedger({ checkpoints: { [LINE]: 10 }, runId: "run" });
  ledger.push(LINE, statusEvent(LINE, DM, "g", "failed", 3));
  const item = ledger.next();
  assert.equal(item.seq, null);
  assert.deepEqual(ledger.ack(item.id), { line: LINE, frontier: 10 });
  assert.equal(ledger.frontier(LINE), 10);
});

test("events with nothing for the agent are counted by type for the health line", () => {
  const ledger = createLedger({ checkpoints: { [LINE]: 10 }, runId: "run" });
  ledger.offer(LINE, { type: "chat.unknownThing", sequence: 11, chatGuid: "" });
  ledger.offer(LINE, { type: "message.someNew", sequence: 12 });
  ledger.offer(LINE, { type: "message.someNew", sequence: 13 });
  assert.deepEqual(ledger.snapshot().skipped, { "chat.unknownThing": 1, "message.someNew": 2 });
  assert.equal(ledger.frontier(LINE), 13);
});
