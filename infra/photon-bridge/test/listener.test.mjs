import assert from "node:assert/strict";
import test from "node:test";

import { BACKOFF_MS, eventInstant, probeHead, proveRead, runLine, streamOnce } from "../container/listener.mjs";
import { formatLog } from "../container/log.mjs";
import { createReads } from "../container/reads.mjs";
import { createLedger } from "../container/ledger.mjs";

const LINE = "+15550100123";
const DM = "any;-;+15550100999";
const WHEN = new Date("2026-11-14T12:00:00.000Z");

function text(seq, at = WHEN) {
  return {
    type: "message.received",
    sequence: seq,
    chatGuid: DM,
    isFromMe: false,
    occurredAt: at,
    message: {
      guid: `msg-${seq}`,
      chatGuids: [DM],
      isFromMe: false,
      dateCreated: at,
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
  // Current events: a catch-up event older than MAX_REPLAY_MS is dropped, which is tested below.
  const fresh = new Date();
  const client = fakeClient({ catchup: () => replay([text(101, fresh), text(102, fresh)], 102), live });
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

test("the first catch-up reports the replay count and the oldest event's age", async () => {
  const live = { messages: feed(), chats: feed(), groups: feed() };
  const oldest = new Date("2026-11-17T15:00:00.000Z");
  const newer = new Date("2026-11-17T16:00:00.000Z");
  const client = fakeClient({ catchup: () => replay([text(101, oldest), text(102, newer)], 102), live });
  const ledger = createLedger({ checkpoints: { [LINE]: 100 }, runId: "lag" });
  const reads = [];
  const now = Date.parse("2026-11-17T16:30:00.000Z");
  const pending = streamOnce({
    client,
    line: LINE,
    ledger,
    onQueued: () => {},
    signal: new AbortController().signal,
    now: () => now,
    onCatchup: (stats) => reads.push(stats),
  });
  await new Promise((resolve) => setTimeout(resolve, 20));
  live.messages.fail(Object.assign(new Error("stop"), { code: "networkError" }));
  await assert.rejects(pending, /stop/);
  assert.deepEqual(reads, [{ replayed: 2, lagMs: 90 * 60 * 1000 }]);
  assert.equal(eventInstant({ message: { dateCreated: oldest } }), oldest.getTime());
  assert.equal(eventInstant({ type: "catchup.complete" }), null);
});

test("a Photon read that finishes counts, and one that hangs does not", async () => {
  const ok = fakeClient({ catchup: () => completeAt(9), live: {} });
  assert.equal(await proveRead(ok, 1000), 9);
  const hung = fakeClient({
    catchup: () => (async function* () {
      await new Promise(() => {});
    })(),
    live: {},
  });
  await assert.rejects(proveRead(hung, 30), (error) => error.code === "readTimeout");
});

test("the first catch-up is logged with its lag, and a later poll is a read with nothing replayed", () => {
  const logs = [];
  let clock = 1_000;
  const reads = createReads((record) => logs.push(JSON.parse(formatLog(record, new Date(clock)))), () => clock);
  reads.start();
  reads.catchup(LINE, { replayed: 4, lagMs: 8 * 60_000 });
  reads.catchup(LINE, { replayed: 1, lagMs: 5 });
  clock = 2_000;
  reads.poll(LINE);
  reads.fail(LINE, "readTimeout");
  assert.equal(logs[0].event, "line.read");
  assert.equal(logs[0].first, true);
  assert.equal(logs[0].replayed, 4);
  assert.equal(logs[0].lag_ms, 8 * 60_000);
  assert.equal(logs[0].line, "0123");
  assert.equal(logs.filter((record) => record.first === true).length, 1);
  assert.deepEqual(logs[1], { ts: new Date(2000).toISOString(), event: "line.read", line: "0123", replayed: 0, lag_ms: 0 });
  assert.equal(logs[2].event, "line.read_failed");
  assert.equal(logs[2].error, "readTimeout");
  assert.equal(JSON.stringify(logs).includes(LINE), false);
  assert.deepEqual(reads.snapshot(), { startedAt: 1000, lastReadAt: 2000 });
});

test("a first catch-up that replays many events, or reaches far back, is an alert; a small one is not", () => {
  const logs = [];
  const reads = createReads((record) => logs.push(record), () => 0);
  reads.catchup(LINE, { replayed: 3, lagMs: 60_000 });
  assert.equal(logs.some((record) => record.event === "bridge.alert"), false);
  reads.catchup("+15550100999", { replayed: 744, lagMs: 55 * 3600_000 });
  assert.deepEqual(logs.find((record) => record.event === "bridge.alert"), {
    event: "bridge.alert",
    outcome: "big_replay",
    line: "+15550100999",
    replayed: 744,
    lag_ms: 55 * 3600_000,
  });
  const alerts = logs.filter((record) => record.event === "bridge.alert").length;
  reads.catchup("+15550100999", { replayed: 744, lagMs: 55 * 3600_000 });
  assert.equal(logs.filter((record) => record.event === "bridge.alert").length, alerts, "only the first catch-up per line");
});

test("a restart skips the sequence Photon never sent, delivers only the recent replay, and does not replay again", async () => {
  const recent = new Date();
  const old = new Date(Date.now() - 55 * 3600_000);
  const replayed = [
    ...Array.from({ length: 8 }, (_, i) => text(1198 + i, old)),
    ...Array.from({ length: 5 }, (_, i) => text(1206 + i, recent)),
  ];
  const first = new AbortController();
  const logs = [];
  const client = fakeClient({ catchup: () => replay(replayed, 1210), live: { messages: feed(), chats: feed(), groups: feed() } });
  const ledger = createLedger({ checkpoints: { [LINE]: 1196 }, runId: "restart1" });
  const pending = streamOnce({ client, line: LINE, ledger, onQueued: () => {}, signal: first.signal, log: (record) => logs.push(record) });
  await new Promise((resolve) => setTimeout(resolve, 20));

  // 1197 never came, 1198..1205 are older than the replay window: only 1206..1210 are queued.
  assert.equal(ledger.frontier(LINE), 1205, "the missing 1197 and the dropped 1198..1205 pass the frontier");
  const delivered = [];
  for (let i = 0; i < 5; i += 1) {
    const item = ledger.next();
    assert.equal(item.event.replay, true, "a catch-up event is marked as a replay");
    delivered.push(item.seq);
    ledger.ack(item.id);
  }
  assert.deepEqual(delivered, [1206, 1207, 1208, 1209, 1210]);
  assert.equal(ledger.next(), null);
  assert.equal(ledger.frontier(LINE), 1210);
  assert.deepEqual(
    logs.find((record) => record.event === "line.gap_skipped"),
    { event: "line.gap_skipped", line: LINE, seq: 1197, frontier: 1205, count: 1, outcome: "catchup" },
  );
  for (const seq of [1197, 1198, 1210]) assert.equal(ledger.offer(LINE, text(seq)), "seen", `${seq} is not delivered again`);
  first.abort();
  await pending.catch(() => {});

  // A second restart from the stored 1210: an empty catch-up queues nothing.
  const second = new AbortController();
  const logs2 = [];
  const client2 = fakeClient({ catchup: () => replay([], 1210), live: { messages: feed(), chats: feed(), groups: feed() } });
  const ledger2 = createLedger({ checkpoints: { [LINE]: 1210 }, runId: "restart2" });
  const pending2 = streamOnce({ client: client2, line: LINE, ledger: ledger2, onQueued: () => {}, signal: second.signal, log: (record) => logs2.push(record) });
  await new Promise((resolve) => setTimeout(resolve, 20));
  assert.equal(client2.catchUps[0], 1210);
  assert.equal(ledger2.next(), null);
  assert.equal(logs2.some((record) => record.event === "line.gap_skipped"), false);
  second.abort();
  await pending2.catch(() => {});
});
