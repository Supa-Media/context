// A person's chat from before its ledger began, copied in once (Dev2, 2026-11-02: "cobble together everything"):
// the bucket's event log and the history record, oldest first, before what the ledger already holds, with old answers
// proven clean only by the gateway's own record.
import { test } from "node:test";
import assert from "node:assert/strict";

import { BACKFILLED, backfillEntries, backfillLedger, GROUP_BACKFILLED } from "../src/agent/ledgerBackfill.js";
import { earlierFromLedger, readLedger } from "../src/agent/ledgerHistory.js";
import { eventEntry, ledgerFor, ONE_TO_ONE_CHAT } from "../src/agent/ledger.js";
import { HISTORY_KEY } from "../src/agent/history.js";
import { LOG_PREFIX, logPrefix } from "../src/agent/log.js";
import { withTexRouting } from "../src/store/texRouting.js";
import { gatewayTexStore } from "../src/texStore/wire.js";
import { texStoreNamespace } from "./texStoreFixture.mjs";

const DAY = 86_400_000;
const T0 = Date.UTC(2026, 9, 20, 15);
const ev = (n, from, text, extra = {}) => ({ id: `${T0 + n * DAY}-${String(n).padStart(6, "0")}`, at: T0 + n * DAY, chat: "sendblue:line:+15555550100", from: { kind: from }, kind: "text", text, ...extra });

/** A workspace bucket with an event log, a history record in the person's object, and a ledger begun on day 9. */
async function world({ logDays = 6 } = {}) {
  const objects = new Map();
  for (let n = 1; n <= logDays; n += 1) {
    const asked = ev(n * 2, "person", `question ${n}`);
    const answered = ev(n * 2 + 1, "tex", n === 2 ? "Here's what the bank email said" : `answer ${n}`, { turn: `turn${String(n).padStart(6, "0")}`, covers: [asked.id] });
    for (const event of [asked, answered]) objects.set(`${LOG_PREFIX}abc/${event.id}.json`, JSON.stringify(event));
  }
  const bucket = {
    get: async (key) => (objects.has(key) ? { text: async () => objects.get(key) } : null),
    head: async () => null,
    list: async ({ prefix }) => ({ objects: [...objects.keys()].filter((key) => key.startsWith(prefix)).map((key) => ({ key })), delimitedPrefixes: [], truncated: false }),
    put: async () => {
      throw new Error("the bucket is never written");
    },
  };
  const tex = texStoreNamespace();
  const env = { TEX_STORE: tex.namespace };
  const store = withTexRouting(bucket, { workspaceId: "ws1", texStore: gatewayTexStore(env) });
  // The record: an exchange from before the log began, and the logged answers it holds, one tainted.
  const turns = [
    { role: "user", text: "my dentist is Dr Lee", at: T0 - 5 * DAY },
    { role: "assistant", text: "Saved Dr Lee.", tools: ["write_note"] },
    { role: "user", text: "question 1", at: T0 + 2 * DAY },
    { role: "assistant", text: "answer 1", tools: ["search_notes"] },
    { role: "user", text: "question 2", at: T0 + 4 * DAY },
    { role: "assistant", text: "Here's what the bank email said", tainted: true },
  ];
  await store.put(HISTORY_KEY, JSON.stringify({ v: 1, turns }));
  const ledger = ledgerFor(env, { person: "ws1" });
  await ledger.append(ONE_TO_ONE_CHAT, [eventEntry(ev(30, "person", "today's text"))]);
  return { store, ledger };
}

test("the old chat goes in before the ledger, oldest first, once, ending with the mark", async () => {
  const { store, ledger } = await world();
  const first = await backfillLedger(store);
  assert.equal(first.state, "finished");
  const all = (await ledger.read(ONE_TO_ONE_CHAT)).entries;
  assert.equal(all[0].id, BACKFILLED);
  const texts = all.filter((entry) => entry.kind === "text").map((entry) => entry.text);
  assert.equal(texts[0], "my dentist is Dr Lee", "the record's exchange from before the log began comes first");
  assert.equal(texts.at(-1), "today's text", "what the ledger held stays last");
  assert.deepEqual(all.map((entry) => entry.at), [...all.map((entry) => entry.at)].sort((a, b) => a - b), "in time order");
  const count = all.length;
  assert.equal((await backfillLedger(store)).state, "done");
  assert.equal((await ledger.read(ONE_TO_ONE_CHAT)).entries.length, count, "running it again copies nothing");
});

test("every old answer is shown in its words, a tainted one too (the owner, 2026-11-05)", async () => {
  const { store, ledger } = await world();
  await backfillLedger(store);
  const entries = await readLedger(ledger, ONE_TO_ONE_CHAT);
  const shown = earlierFromLedger(entries, "c", { before: T0 + 30 * DAY }).events.map((event) => event.text);
  assert.ok(shown.includes("answer 1"), "the record holds it, clean");
  assert.ok(shown.includes("Saved Dr Lee."), "the record's own exchange, clean");
  assert.ok(shown.includes("Here's what the bank email said"), "the record marked it tainted, and it is shown");
  assert.ok(shown.includes("answer 3"), "one the record does not hold is shown too");
  assert.ok(!shown.some((text) => /not shown/.test(text)), "nothing is held back");
  const tools = earlierFromLedger(entries, "c").tools;
  assert.deepEqual(tools.get("turn000001"), ["search_notes"]);
});

test("a long log goes in a part at a time, newest first, and the mark only once all of it is in", async () => {
  const { store, ledger } = await world({ logDays: 6 });
  const part = await backfillLedger(store, { most: 4 });
  assert.equal(part.state, "copied");
  assert.notEqual((await ledger.oldest(ONE_TO_ONE_CHAT)).id, BACKFILLED);
  let state = part.state;
  for (let i = 0; i < 5 && state !== "finished"; i += 1) state = (await backfillLedger(store, { most: 4 })).state;
  assert.equal(state, "finished");
  const texts = (await ledger.read(ONE_TO_ONE_CHAT)).entries.filter((entry) => entry.kind === "text").map((entry) => entry.text);
  assert.deepEqual(texts, ["my dentist is Dr Lee", "Saved Dr Lee.", ...Array.from({ length: 6 }, (_, i) => [`question ${i + 1}`, i === 1 ? "Here's what the bank email said" : `answer ${i + 1}`]).flat(), "today's text"]);
});

test("a dry run writes nothing", async () => {
  const { store, ledger } = await world();
  assert.equal((await backfillLedger(store, { dryRun: true })).state, "would");
  assert.equal((await ledger.read(ONE_TO_ONE_CHAT)).entries.length, 1);
});

test("backfillEntries: the record's exchanges only from before the log began", () => {
  const events = [ev(2, "person", "question 1")];
  const turns = [{ role: "user", text: "later, also in the log", at: T0 + 3 * DAY }, { role: "assistant", text: "x" }];
  assert.deepEqual(backfillEntries(events, turns).filter((entry) => entry.backfill === "record"), []);
});

test("the Worker's event post starts a part after its answer, and a finished workspace is not asked again", async () => {
  const { startBackfill } = await import("../src/agent/ledgerBackfill.js");
  const { store, ledger } = await world();
  const later = [];
  store.defer = (work) => later.push(work);
  startBackfill(store, { workspaceId: "ws_backfill_start", workspaceKind: "personal" });
  assert.equal(later.length, 1, "deferred, never run on the request's own way");
  assert.equal((await ledger.read(ONE_TO_ONE_CHAT)).entries.length, 1);
  const logged = [];
  const log = console.log;
  console.log = (line) => logged.push(line);
  try {
    await later[0]();
  } finally {
    console.log = log;
  }
  assert.equal((await ledger.oldest(ONE_TO_ONE_CHAT)).id, BACKFILLED);
  assert.ok(!logged.join("\n").includes("question 1"), "counts only, never a word");
  startBackfill(store, { workspaceId: "ws_backfill_start", workspaceKind: "personal" });
  assert.equal(later.length, 1);
});

test("a group chat's old log goes into the group's own ledger, and no other group's", async () => {
  const { startBackfill } = await import("../src/agent/ledgerBackfill.js");
  // The ledger is kept under the group key (its line and group id, hashed: `textGroups.ts` `groupKeyOf`); the old log under
  // the chat the Worker named in its events, the line's group id. Reading the log by the key found nothing (2026-11-02).
  const group = "a".repeat(64);
  const ours = "sendblue-group-ours";
  const theirs = "sendblue-group-theirs";
  const gev = (n, chat, from, text) => ({ ...ev(n, from, text), chat });
  const objects = new Map();
  for (const [chat, words, from] of [[ours, "ours", 1], [theirs, "theirs", 11], [group, "keyed", 21]]) {
    const prefix = await logPrefix(chat);
    for (let n = from; n < from + 3; n += 1) {
      const event = gev(n, chat, "person", `${words} ${n - from + 1}`);
      objects.set(`${prefix}${event.id}.json`, JSON.stringify(event));
    }
  }
  const bucket = {
    get: async (key) => (objects.has(key) ? { text: async () => objects.get(key) } : null),
    head: async () => null,
    list: async ({ prefix }) => ({ objects: [...objects.keys()].filter((key) => key.startsWith(prefix)).map((key) => ({ key })), delimitedPrefixes: [], truncated: false }),
    put: async () => {
      throw new Error("the bucket is never written");
    },
  };
  const tex = texStoreNamespace();
  const env = { TEX_STORE: tex.namespace };
  const store = withTexRouting(bucket, { workspaceId: "ws_pin", chats: [group], texStore: gatewayTexStore(env) });
  const ledger = ledgerFor(env, { chat: group });
  await ledger.append(group, [eventEntry(gev(30, ours, "person", "today in the group"))]);
  const later = [];
  store.defer = (work) => later.push(work);
  startBackfill(store, { workspaceId: "ws_pin", texChatId: group });
  assert.equal(later.length, 0, "without the chat the Worker named, nothing is looked for");
  startBackfill(store, { workspaceId: "ws_pin", texChatId: group }, { logChat: ours });
  assert.equal(later.length, 1);
  await later[0]();
  const texts = (await ledger.read(group)).entries.filter((entry) => entry.kind === "text").map((entry) => entry.text);
  assert.deepEqual(texts, ["ours 1", "ours 2", "ours 3", "today in the group"]);
  assert.equal((await ledger.oldest(group)).id, GROUP_BACKFILLED);
  assert.equal((await ledgerFor(env, { person: "ws_pin" }).read(ONE_TO_ONE_CHAT)).entries.length, 0, "never into a person's chat");
  startBackfill(store, { workspaceId: "ws_pin", texChatId: group }, { logChat: ours });
  assert.equal(later.length, 1, "a finished group is not asked again");
});

test("a group marked done by the copy that looked under its key gets its old log after all, once", async () => {
  const group = "c".repeat(64);
  const chat = "sendblue-group-late";
  const objects = new Map();
  const prefix = await logPrefix(chat);
  for (let n = 1; n <= 3; n += 1) {
    const event = { ...ev(n, "person", `old ${n}`), chat };
    objects.set(`${prefix}${event.id}.json`, JSON.stringify(event));
  }
  const bucket = {
    get: async (key) => (objects.has(key) ? { text: async () => objects.get(key) } : null),
    head: async () => null,
    list: async ({ prefix: wanted }) => ({ objects: [...objects.keys()].filter((key) => key.startsWith(wanted)).map((key) => ({ key })), delimitedPrefixes: [], truncated: false }),
    put: async () => {
      throw new Error("the bucket is never written");
    },
  };
  const tex = texStoreNamespace();
  const env = { TEX_STORE: tex.namespace };
  const store = withTexRouting(bucket, { workspaceId: "ws_pin", chats: [group], texStore: gatewayTexStore(env) });
  const ledger = ledgerFor(env, { chat: group });
  // As the old copy left it: today's text, and before it the mark it wrote with nothing copied.
  await ledger.append(group, [eventEntry({ ...ev(30, "person", "today"), chat })]);
  await ledger.prepend(group, [{ v: 1, id: BACKFILLED, at: ev(30, "person", "x").at - 1, kind: "note", text: "(The chat before this ledger began was copied in here.)", backfill: "mark" }]);
  const run = await backfillLedger(store, { group, logChat: chat });
  assert.equal(run.state, "finished");
  const texts = (await ledger.read(group)).entries.filter((entry) => entry.kind === "text").map((entry) => entry.text);
  assert.deepEqual(texts, ["old 1", "old 2", "old 3", "today"]);
  assert.equal((await ledger.oldest(group)).id, GROUP_BACKFILLED);
  assert.equal((await backfillLedger(store, { group, logChat: chat })).state, "done", "and only once");
});
