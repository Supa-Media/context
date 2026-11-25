import assert from "node:assert/strict";
import test from "node:test";

import { createEnricher, createLru } from "../container/enrich.mjs";
import { createLedger } from "../container/ledger.mjs";
import { GAP_TIMEOUT_MS, MAX_REPLAY_MS } from "../container/replay.mjs";
import { mapEvent } from "../container/map.mjs";
import { formatLog, last4 } from "../container/log.mjs";
import { basicAuth, linesOf, parseTokenData, renewalDelayMs, issueTokens, TokenError } from "../container/tokens.mjs";

const LINE = "+15550100123";
const DM = "any;-;+15550100999";
const WHEN = new Date("2026-11-14T12:00:00.000Z");

function text(seq, guid = `msg-${seq}`) {
  return {
    type: "message.received",
    sequence: seq,
    chatGuid: DM,
    isFromMe: false,
    occurredAt: WHEN,
    message: {
      guid,
      chatGuids: [DM],
      isFromMe: false,
      dateCreated: WHEN,
      sender: { address: "+15550100999", service: "iMessage" },
      content: { text: `words ${seq}`, attachments: [], formatting: [], mentions: [] },
    },
  };
}

test("the frontier advances only through contiguous completed sequences", () => {
  const ledger = createLedger({ checkpoints: { [LINE]: 100 }, runId: "run1" });
  assert.equal(ledger.offer(LINE, text(102)), "queued");
  assert.equal(ledger.frontier(LINE), 100, "101 has not completed, so 102 cannot move the frontier");
  assert.equal(
    ledger.offer(LINE, { type: "poll.changed", sequence: 101, chatGuid: DM }),
    "completed",
    "unmapped events still complete",
  );
  assert.equal(ledger.frontier(LINE), 101);
  const head = ledger.next();
  assert.equal(head.seq, 102);
  const acked = ledger.ack(head.id);
  assert.deepEqual(acked, { line: LINE, frontier: 102 });
});

test("a sequence already queued, completed or behind the frontier is seen, not repeated", () => {
  const ledger = createLedger({ checkpoints: { [LINE]: 100 }, runId: "run2" });
  assert.equal(ledger.offer(LINE, text(101)), "queued");
  assert.equal(ledger.offer(LINE, text(101)), "seen", "live and catch-up deliver the same event");
  assert.equal(ledger.offer(LINE, text(100)), "seen");
  ledger.ack(ledger.next().id);
  assert.equal(ledger.offer(LINE, text(101)), "seen", "acked events are not queued again");
});

test("in-order acks walk the frontier forward one event at a time", () => {
  const ledger = createLedger({ checkpoints: { [LINE]: 0 }, runId: "run3" });
  ledger.offer(LINE, text(1));
  ledger.offer(LINE, text(2));
  ledger.offer(LINE, text(3));
  for (let seq = 1; seq <= 3; seq += 1) {
    assert.equal(ledger.next().seq, seq);
    assert.deepEqual(ledger.ack(ledger.next().id), { line: LINE, frontier: seq });
  }
});

test("out-of-order acks keep the frontier behind the gap", () => {
  const ledger = createLedger({ checkpoints: { [LINE]: 0 }, runId: "run4" });
  ledger.offer(LINE, text(2));
  ledger.offer(LINE, text(1));
  const first = ledger.next();
  assert.equal(first.seq, 2);
  assert.deepEqual(ledger.ack(first.id), { line: LINE, frontier: 0 });
  assert.deepEqual(ledger.ack(ledger.next().id), { line: LINE, frontier: 2 });
});

test("an id from before a restart is unknown, so a stale ack cannot land on a new event", () => {
  const before = createLedger({ checkpoints: { [LINE]: 0 }, runId: "aaaa" });
  before.offer(LINE, text(1));
  const staleId = before.next().id;
  const after = createLedger({ checkpoints: { [LINE]: 0 }, runId: "bbbb" });
  after.offer(LINE, text(1));
  assert.equal(after.ack(staleId), null);
  assert.notEqual(after.next().id, staleId);
});

test("an event for a line with no frontier is an error, not a silent queue", () => {
  const ledger = createLedger({ runId: "run5" });
  assert.throws(() => ledger.offer(LINE, text(5)), /frontier not initialized/);
  ledger.initialize(LINE, 4);
  assert.equal(ledger.offer(LINE, text(5)), "queued");
});

test("wait resolves with a queued event, or null after the timeout", async () => {
  const ledger = createLedger({ checkpoints: { [LINE]: 0 }, runId: "run6" });
  assert.equal(await ledger.wait(5), null);
  setTimeout(() => ledger.offer(LINE, text(1)), 5);
  const item = await ledger.wait(1000);
  assert.equal(item.seq, 1);
});

test("the snapshot names lines and depth, not event content", () => {
  const ledger = createLedger({ checkpoints: { [LINE]: 7 }, runId: "run7" });
  ledger.offer(LINE, text(8));
  const snapshot = JSON.stringify(ledger.snapshot());
  assert.equal(snapshot.includes("words"), false);
  assert.deepEqual(ledger.snapshot().lines, [{ line: LINE, frontier: 7, stuckMs: null }]);
});

test("the LRU keeps recent entries and evicts the least recently used", () => {
  const cache = createLru(2);
  cache.set("a", 1);
  cache.set("b", 2);
  cache.get("a");
  cache.set("c", 3);
  assert.equal(cache.get("b"), undefined);
  assert.equal(cache.get("a"), 1);
  assert.equal(cache.size, 2);
});

test("enrichment reads a reply target from the cache, or looks it up once", async () => {
  let lookups = 0;
  const enricher = createEnricher({
    cache: createLru(),
    lookup: async (guid) => {
      lookups += 1;
      return { text: `looked up ${guid}`, fromMe: true };
    },
  });
  const reply = { ...text(10, "msg-10"), message: { ...text(10).message, replyTargetGuid: "msg-old" } };
  assert.deepEqual(await enricher.enrich(reply), { replyToText: "looked up msg-old", replyToFromMe: true });
  assert.deepEqual(await enricher.enrich(reply), { replyToText: "looked up msg-old", replyToFromMe: true });
  assert.equal(lookups, 1, "the second reply found the target in the cache");
});

test("a failed or slow lookup leaves the field out and does not stall the event", async () => {
  const failing = createEnricher({ lookup: async () => { throw new Error("chatNotFound +15550100999"); } });
  const reaction = {
    type: "message.reactionAdded",
    sequence: 20,
    messageGuid: "msg-x",
    chatGuid: DM,
    isFromMe: false,
    occurredAt: WHEN,
    reaction: { kind: "like" },
  };
  assert.deepEqual(await failing.enrich(reaction), {});

  const slow = createEnricher({ timeoutMs: 5, lookup: () => new Promise((resolve) => setTimeout(() => resolve({ text: "late", fromMe: false }), 200)) });
  assert.deepEqual(await slow.enrich(reaction), {});
});

test("a group message carries its group's name, read from the chat because iMessage only names a rename", async () => {
  const GROUP = "iMessage;+;chat-fixture-1";
  let reads = 0;
  let clock = 0;
  let name = "Weekend Plans";
  const enricher = createEnricher({
    lookup: async () => undefined,
    chat: async (guid) => {
      reads += 1;
      assert.equal(guid, GROUP);
      return { guid, displayName: name, isGroup: true };
    },
    now: () => clock,
  });
  const inGroup = (seq, extra = {}) => ({ ...text(seq), chatGuid: GROUP, message: { ...text(seq).message, chatGuids: [GROUP], ...extra } });
  const first = await enricher.enrich(inGroup(40));
  assert.deepEqual(first, { chatName: "Weekend Plans" });
  assert.deepEqual(mapEvent(inGroup(40), LINE, first).chat, { guid: GROUP, kind: "group", name: "Weekend Plans" });
  await enricher.enrich(inGroup(41));
  assert.equal(reads, 1, "the name is kept a while per chat");

  // A rename keeps the new name without a read; the message that renames carries its own.
  await enricher.enrich({ type: "group.changed", sequence: 42, chatGuid: GROUP, occurredAt: WHEN, change: { type: "displayNameChanged", displayName: "Beach Week" } });
  assert.deepEqual(await enricher.enrich(inGroup(43)), { chatName: "Beach Week" });
  assert.deepEqual(await enricher.enrich(inGroup(44, { groupTitle: "Beach Week" })), {});
  assert.equal(reads, 1);

  // After the keep time it reads again; a 1:1 never asks, and an unnamed group or a failed read sends no name.
  clock += 11 * 60_000;
  name = "";
  assert.deepEqual(await enricher.enrich(inGroup(45)), {});
  assert.equal(reads, 2);
  assert.deepEqual(await enricher.enrich(text(46)), {});
  assert.equal(reads, 2);
  const failing = createEnricher({ lookup: async () => undefined, chat: async () => { throw new Error("chatNotFound"); } });
  assert.deepEqual(await failing.enrich(inGroup(47)), {});
  assert.deepEqual(mapEvent(inGroup(47), LINE, {}).chat, { guid: GROUP, kind: "group" });
});

test("an edit reports the words it replaced, from what the bridge saw before", async () => {
  const enricher = createEnricher({ lookup: async () => undefined });
  await enricher.enrich(text(30, "msg-30"));
  const edit = {
    type: "message.edited",
    sequence: 31,
    messageGuid: "msg-30",
    chatGuid: DM,
    isFromMe: false,
    occurredAt: WHEN,
    editedAt: WHEN,
    content: { text: "words 30 edited", attachments: [], formatting: [], mentions: [] },
  };
  assert.deepEqual(await enricher.enrich(edit), { previousText: "words 30" });
  assert.deepEqual(await enricher.enrich({ ...edit, sequence: 32 }), { previousText: "words 30 edited" });
});

test("log lines keep only allowlisted fields and reduce a line to its last four digits", () => {
  const out = JSON.parse(formatLog({
    event: "op",
    line: LINE,
    text: "secret message words",
    token: "tok-abc",
    message: "+15550100999 failed",
    ok: true,
    status: 200,
  }, new Date("2026-11-14T00:00:00.000Z")));
  assert.deepEqual(Object.keys(out).sort(), ["event", "line", "ok", "status", "ts"]);
  assert.equal(out.line, "0123");
  assert.equal(last4("+1 (555) 010-0999"), "0999");
});

test("basic auth and the cloud token response are parsed and checked", () => {
  assert.equal(basicAuth("proj-1", "sec-1"), `Basic ${Buffer.from("proj-1:sec-1").toString("base64")}`);
  const data = parseTokenData({
    succeed: true,
    data: {
      type: "dedicated",
      auth: { inst1: "tok-1", inst2: "tok-2" },
      numbers: { inst1: LINE },
      expiresIn: 3600,
    },
  });
  assert.deepEqual(linesOf(data), [{ instanceId: "inst1", line: LINE, address: "inst1.imsg.photon.codes:443" }]);
  assert.throws(() => parseTokenData({ succeed: false }), TokenError);
  assert.throws(() => parseTokenData({ succeed: true, data: { type: "shared", auth: {}, expiresIn: 60 } }), { code: "unsupported_line_type" });
  assert.throws(() => parseTokenData({ succeed: true, data: { type: "dedicated", auth: {}, expiresIn: 0 } }), { code: "malformed_response" });
});

test("tokens renew at 80 percent of their life, never sooner than five seconds", () => {
  assert.equal(renewalDelayMs(3600), 2_880_000);
  assert.equal(renewalDelayMs(1), 5000);
});

test("issueTokens posts with basic auth to the project's token route and refuses a bad status", async () => {
  const seen = [];
  const fetchImpl = async (url, init) => {
    seen.push({ url, init });
    return Response.json({ succeed: true, data: { type: "dedicated", auth: { i: "t" }, numbers: { i: LINE }, expiresIn: 60 } });
  };
  const data = await issueTokens({ projectId: "proj 1", projectSecret: "s", fetchImpl });
  assert.equal(seen[0].url, "https://spectrum.photon.codes/projects/proj%201/imessage/tokens");
  assert.equal(seen[0].init.method, "POST");
  assert.equal(seen[0].init.headers.authorization, basicAuth("proj 1", "s"));
  assert.equal(data.expiresIn, 60);

  const refused = async () => new Response("no", { status: 401 });
  await assert.rejects(issueTokens({ projectId: "p", projectSecret: "s", fetchImpl: refused }), { code: "cloud_refused", status: 401 });
});

test("a poll change is enriched with the poll's title and options, and a sticker with the words it was stuck on", async () => {
  const enricher = createEnricher({
    lookup: async () => ({ text: "stuck on these", fromMe: true }),
    poll: async () => ({ title: "Dinner", options: [{ optionIdentifier: "a", text: "Pizza" }], votes: [] }),
  });
  assert.deepEqual(await enricher.enrich({ type: "poll.changed", pollMessageGuid: "p" }), { poll: { title: "Dinner", options: [{ id: "a", text: "Pizza" }] } });
  assert.deepEqual(await enricher.enrich({ type: "message.stickerPlaced", messageGuid: "m" }), { targetText: "stuck on these", targetFromMe: true });
  const blind = createEnricher({ lookup: async () => ({ text: "", fromMe: false }), poll: async () => { throw new Error("down"); } });
  assert.deepEqual(await blind.enrich({ type: "poll.changed", pollMessageGuid: "p" }), {});
});

// Events dated by the test, so replay age can be set against an injected clock.
function textAt(seq, at) {
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

test("skipMissing passes a sequence Photon never sent, but not one still queued", () => {
  const ledger = createLedger({ checkpoints: { [LINE]: 100 }, runId: "skip1", now: () => 0 });
  ledger.offer(LINE, text(102));
  ledger.offer(LINE, text(103));
  assert.deepEqual(ledger.skipMissing(LINE, 103), { skipped: 1, first: 101, frontier: 101 }, "101 is passed; 102 is queued and stops the frontier");
  assert.equal(ledger.ack(ledger.next().id).frontier, 102);
  assert.equal(ledger.ack(ledger.next().id).frontier, 103);
  assert.equal(ledger.offer(LINE, text(101)), "seen", "the skipped sequence is not delivered later");
});

test("skipMissing is a no-op at or below the frontier, and refuses an absurd span", () => {
  const ledger = createLedger({ checkpoints: { [LINE]: 100 }, runId: "skip2", now: () => 0 });
  assert.deepEqual(ledger.skipMissing(LINE, 100), { skipped: 0, first: null, frontier: 100 });
  assert.deepEqual(ledger.skipMissing(LINE, 2_000_000), { skipped: 0, first: null, frontier: 100 });
  assert.deepEqual(ledger.skipMissing("+15550100000", 5), { skipped: 0, first: null, frontier: null });
});

test("sweep does nothing before GAP_TIMEOUT_MS, and skips the gap after it", () => {
  let clock = 0;
  const ledger = createLedger({ checkpoints: { [LINE]: 100 }, runId: "sweep1", now: () => clock });
  ledger.offer(LINE, text(102));
  clock = GAP_TIMEOUT_MS - 1;
  assert.deepEqual(ledger.sweep(LINE), { skipped: 0, first: null, frontier: 100 });
  clock = GAP_TIMEOUT_MS;
  assert.deepEqual(ledger.sweep(LINE), { skipped: 1, first: 101, frontier: 101 });
  assert.equal(ledger.next().seq, 102, "the queued event behind the gap is still delivered");
  assert.deepEqual(ledger.sweep(LINE), { skipped: 0, first: null, frontier: 101 }, "nothing left to skip");
});

test("a gap clock restarts when the frontier moves, and clears when the gap closes", () => {
  let clock = 0;
  const ledger = createLedger({ checkpoints: { [LINE]: 100 }, runId: "sweep2", now: () => clock });
  ledger.offer(LINE, text(102));
  ledger.offer(LINE, text(101));
  clock = GAP_TIMEOUT_MS + 5;
  assert.equal(ledger.sweep(LINE).skipped, 0, "101 arrived, so there is no gap to skip");
  ledger.ack(ledger.next().id);
  clock += GAP_TIMEOUT_MS - 1;
  assert.equal(ledger.sweep(LINE).skipped, 0);
});

test("a replay older than MAX_REPLAY_MS completes without being queued; a live event of that age is queued", () => {
  const now = Date.parse("2026-11-20T12:00:00.000Z");
  const old = new Date(now - MAX_REPLAY_MS - 60_000);
  const ledger = createLedger({ checkpoints: { [LINE]: 0 }, runId: "replay1", now: () => now });
  assert.equal(ledger.offer(LINE, textAt(1, old), {}, { replay: true }), "completed");
  assert.equal(ledger.frontier(LINE), 1, "the dropped replay still passes the frontier");
  assert.equal(ledger.next(), null);
  assert.equal(ledger.offer(LINE, textAt(2, old)), "queued", "a live event is never dropped for its age");
});

test("a catch-up event is marked replay; a live one is not, and a recent replay is delivered", () => {
  const now = Date.parse("2026-11-20T12:00:00.000Z");
  const recent = new Date(now - 60_000);
  const ledger = createLedger({ checkpoints: { [LINE]: 0 }, runId: "replay2", now: () => now });
  assert.equal(ledger.offer(LINE, textAt(1, recent), {}, { replay: true }), "queued");
  assert.equal(ledger.next().event.replay, true);
  assert.equal(ledger.offer(LINE, textAt(2, recent)), "queued");
  ledger.ack(ledger.next().id);
  assert.equal(ledger.next().event.replay, undefined, "a live event carries no replay mark");
});

test("a replay whose time Apple did not give is not old, so it is delivered", () => {
  const now = Date.parse("2026-11-20T12:00:00.000Z");
  const noTime = { ...textAt(1, undefined), message: { ...textAt(1, undefined).message, dateCreated: undefined } };
  delete noTime.occurredAt;
  const ledger = createLedger({ checkpoints: { [LINE]: 0 }, runId: "replay3", now: () => now });
  assert.equal(ledger.offer(LINE, noTime, {}, { replay: true }), "queued");
  assert.equal(ledger.next().event.atGuessed, true);
});

test("the snapshot reports how long a frontier has been stuck behind newer events, and the drop and skip counts", () => {
  let clock = 0;
  const ledger = createLedger({ checkpoints: { [LINE]: 0 }, runId: "stuck1", now: () => clock });
  ledger.offer(LINE, text(1));
  assert.equal(ledger.snapshot().lines[0].stuckMs, null, "nothing newer than the frontier's move yet");
  clock = 60_000;
  ledger.offer(LINE, text(2));
  clock = 120_000;
  const snap = ledger.snapshot();
  assert.equal(snap.lines[0].stuckMs, 120_000);
  assert.equal(snap.replayDropped, 0);
  assert.equal(snap.gapSkipped, 0);
  ledger.ack(ledger.next().id);
  assert.equal(ledger.snapshot().lines[0].stuckMs, null, "the frontier moved, so nothing is stuck");
});

test("checkpoints names each line that has a frontier, for the object to store", () => {
  const ledger = createLedger({ checkpoints: { [LINE]: 5 }, runId: "cp1", now: () => 0 });
  ledger.initialize("+15550100999", 9);
  assert.deepEqual(ledger.checkpoints(), { [LINE]: 5, "+15550100999": 9 });
  assert.deepEqual(createLedger({ runId: "cp2" }).checkpoints(), {});
});

function groupText(seq, chat) {
  const t = text(seq);
  return { ...t, chatGuid: chat, message: { ...t.message, chatGuids: [chat] } };
}

test("next skips the chats the object is still retrying, so one chat's failure holds only that chat (2026-11-25)", async () => {
  const A = "any;+;group-a";
  const B = "any;+;group-b";
  const ledger = createLedger({ checkpoints: { [LINE]: 0 }, runId: "skip1" });
  ledger.offer(LINE, groupText(1, A));
  ledger.offer(LINE, groupText(2, A));
  ledger.offer(LINE, groupText(3, B));
  const skipA = new Set([A]);
  assert.equal(ledger.next(skipA).seq, 3, "b's text is handed out while a's head is retried");
  assert.deepEqual(ledger.ack(ledger.next(skipA).id), { line: LINE, frontier: 0 }, "the frontier waits behind a's head");
  assert.equal(ledger.next(skipA), null, "a's second text never jumps its head");
  assert.equal(await ledger.wait(5, skipA), null);
  assert.equal(ledger.next().seq, 1, "without skip, a's head comes first again");
  ledger.ack(ledger.next().id);
  assert.deepEqual(ledger.ack(ledger.next().id), { line: LINE, frontier: 3 });
});

test("a waiter whose chats are all skipped keeps waiting, and wakes for another chat's text", async () => {
  const A = "any;+;group-a";
  const B = "any;+;group-b";
  const ledger = createLedger({ checkpoints: { [LINE]: 0 }, runId: "skip2" });
  const waiting = ledger.wait(2000, new Set([A]));
  ledger.offer(LINE, groupText(1, A));
  ledger.offer(LINE, groupText(2, B));
  assert.equal((await waiting).seq, 2);
});
