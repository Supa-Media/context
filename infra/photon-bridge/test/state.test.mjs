import assert from "node:assert/strict";
import test from "node:test";

import { createEnricher, createLru } from "../container/enrich.mjs";
import { createLedger } from "../container/ledger.mjs";
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
  assert.deepEqual(ledger.snapshot().lines, [{ line: LINE, frontier: 7 }]);
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
