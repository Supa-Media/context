import assert from "node:assert/strict";
import test from "node:test";

import { BACKOFF_MS, probeHead, runLine, streamOnce } from "../container/listener.mjs";
import { createLedger } from "../container/ledger.mjs";

const LINE = "+15550100123";
const DM = "any;-;+15550100999";
const WHEN = new Date("2026-11-14T12:00:00.000Z");

function text(seq) {
  return {
    type: "message.received",
    sequence: seq,
    chatGuid: DM,
    isFromMe: false,
    occurredAt: WHEN,
    message: {
      guid: `msg-${seq}`,
      chatGuids: [DM],
      isFromMe: false,
      dateCreated: WHEN,
      sender: { address: "+15550100999", service: "iMessage" },
      content: { text: `words ${seq}`, attachments: [], formatting: [], mentions: [] },
    },
  };
}

/** An async iterable the test can feed and end, standing in for an SDK stream. */
function feed() {
  const items = [];
  let wake;
  let ended = false;
  let failure;
  let closed = false;
  const stream = {
    push(event) {
      items.push(event);
      wake?.();
    },
    end() {
      ended = true;
      wake?.();
    },
    fail(error) {
      failure = error;
      wake?.();
    },
    closed: () => closed,
    close: async () => {
      closed = true;
    },
    async *[Symbol.asyncIterator]() {
      for (;;) {
        if (items.length > 0) {
          yield items.shift();
          continue;
        }
        if (failure) throw failure;
        if (ended) return;
        await new Promise((resolve) => {
          wake = resolve;
        });
        wake = undefined;
      }
    },
  };
  return stream;
}

function fakeClient({ catchup, live }) {
  const catchUps = [];
  return {
    catchUps,
    events: {
      catchUp(since) {
        catchUps.push(since);
        return catchup(since);
      },
    },
    messages: { subscribeEvents: () => live.messages },
    chats: { subscribeEvents: () => live.chats },
    groups: { subscribeEvents: () => live.groups },
  };
}

function completeAt(head) {
  return (async function* () {
    yield { type: "catchup.complete", headSequence: head };
  })();
}

function replay(events, head) {
  return (async function* () {
    for (const event of events) yield event;
    yield { type: "catchup.complete", headSequence: head };
  })();
}

test("the head probe takes the log head from catch-up, replaying nothing", async () => {
  const client = fakeClient({ catchup: () => completeAt(412), live: {} });
  assert.equal(await probeHead(client), 412);
  assert.equal(client.catchUps[0], Number.MAX_SAFE_INTEGER);
});

test("catch-up from the frontier and the live streams feed one ledger", async () => {
  const live = { messages: feed(), chats: feed(), groups: feed() };
  const client = fakeClient({ catchup: () => replay([text(101), text(102)], 102), live });
  const ledger = createLedger({ checkpoints: { [LINE]: 100 }, runId: "ls1" });
  let queued = 0;
  const pending = streamOnce({ client, line: LINE, ledger, onQueued: () => (queued += 1), signal: new AbortController().signal });
  await new Promise((resolve) => setTimeout(resolve, 10));
  live.messages.push(text(102));
  live.messages.push(text(103));
  await new Promise((resolve) => setTimeout(resolve, 10));
  assert.equal(client.catchUps[0], 100);
  assert.equal(queued, 3, "102 from catch-up and 102 from live count once");
  assert.equal(ledger.frontier(LINE), 100, "nothing acked yet, so the frontier stays put");
  live.messages.fail(Object.assign(new Error("stream reset"), { code: "networkError" }));
  await assert.rejects(pending, /stream reset/);
  assert.equal(live.chats.closed(), true, "every live stream is closed when the attempt ends");
});

test("a live stream that ends is a failure, so the line reconnects", async () => {
  const live = { messages: feed(), chats: feed(), groups: feed() };
  const client = fakeClient({ catchup: () => completeAt(0), live });
  const ledger = createLedger({ checkpoints: { [LINE]: 0 }, runId: "ls2" });
  const pending = streamOnce({ client, line: LINE, ledger, onQueued: () => {}, signal: new AbortController().signal });
  live.chats.end();
  await assert.rejects(pending, /live stream ended/);
});

test("runLine retries with backoff after a failure and stops when aborted", async () => {
  const sleeps = [];
  const logs = [];
  const controller = new AbortController();
  let attempts = 0;
  const client = fakeClient({
    catchup: () => {
      attempts += 1;
      if (attempts >= 3) controller.abort();
      return (async function* () {
        throw Object.assign(new Error("boom"), { code: "serviceUnavailable" });
      })();
    },
    live: { messages: feed(), chats: feed(), groups: feed() },
  });
  const ledger = createLedger({ checkpoints: { [LINE]: 0 }, runId: "ls3" });
  await runLine({
    client,
    line: LINE,
    ledger,
    onQueued: () => {},
    signal: controller.signal,
    log: (record) => logs.push(record),
    backoff: BACKOFF_MS,
    sleep: async (ms) => {
      sleeps.push(ms);
    },
  });
  assert.equal(attempts, 3);
  assert.deepEqual(sleeps.slice(0, 2), [1000, 2000]);
  const failure = logs.find((record) => record.event === "line.stream_failed");
  assert.equal(failure.error, "serviceUnavailable", "the log names the code, not the message");
  assert.equal(JSON.stringify(logs).includes("boom"), false);
});

test("runLine probes the head once for a line with no frontier", async () => {
  const controller = new AbortController();
  let probes = 0;
  const client = fakeClient({
    catchup: (since) => {
      if (since === Number.MAX_SAFE_INTEGER) {
        probes += 1;
        return completeAt(50);
      }
      controller.abort();
      return completeAt(50);
    },
    live: { messages: feed(), chats: feed(), groups: feed() },
  });
  const ledger = createLedger({ runId: "ls4" });
  await runLine({
    client,
    line: LINE,
    ledger,
    onQueued: () => {},
    signal: controller.signal,
    log: () => {},
    sleep: async () => {},
  });
  assert.equal(probes, 1);
  assert.equal(ledger.frontier(LINE), 50);
});
