/**
 * A person's history file read straight from their ledger by a connected AI (`src/tools/notes/historyRead.js`), so a
 * chat whose history row was never made is still readable, on the owner's own connection when the path is visible to it, and nowhere else.
 *
 * Sabotage record (2026-11-03), each fails a test here:
 *  - `ownHistoryRead` without `deskEligible` → "a team-tier or non-owner connection reads it as any note";
 *  - `toolReadNote` without the ledger branch → "the owner reads the chat from the ledger with no row";
 *  - (2026-11-04) `ownHistoryRead` without its `canSee` check → "the owner's team connection reads the chat when the
 *    path is Team, and not otherwise";
 *  - the `trust: untrusted` line dropped → "the answer marks the turn as having read other people's words".
 *  - (2026-11-06) `before` ignored in `readOwnHistory` → "an older stretch is read by paging back with before";
 *    `job` not passed to the ledger read → "a job's own entries are read alone".
 */

import assert from "node:assert/strict";
import { test } from "node:test";

import { texLedger } from "../src/texStore/ledger.js";
import { durableSql } from "./texStoreFixture.mjs";
import { HISTORY_READ_CHARS, ownHistoryRead, readOwnHistory } from "../src/tools/notes/historyRead.js";
import { toolReadNote } from "../src/tools/notes/read.js";
import { newLedger, recordRead } from "../src/privacy/egress.js";

const PRIVATE_OWNER = [{ current: true, kind: "personal", role: "owner", tier: "private" }];

function storeWith(contexts, entries = []) {
  const ledger = texLedger(durableSql());
  for (let at = 0; at < entries.length; at += 100) ledger.append("texts", entries.slice(at, at + 100));
  // The gateway's ledger is reached over the wire and answers asynchronously.
  const remote = { read: async (chat, options) => ledger.read(chat, options) };
  return { contexts, texLedger: (chat) => (chat === null ? remote : null), head: async () => null, get: async () => null };
}

const entry = (n, text) => ({ id: `e${n}`, kind: "text", at: 1_700_000_000_000 + n, text });

test("the owner reads the chat from the ledger with no row, newest entries oldest first", async () => {
  const store = storeWith(PRIVATE_OWNER, [entry(1, "book my haircut"), entry(2, "On it")]);
  const answer = await toolReadNote(store, "private", [], new Map(), "tex/history.ledger.json");
  assert.equal(answer.isError, undefined);
  const text = answer.content[0].text;
  assert.match(text, /^path: tex\/history\.ledger\.json/);
  const body = JSON.parse(text.slice(text.indexOf("{")));
  assert.deepEqual(body.entries.map((e) => e.text), ["book my haircut", "On it"]);
  assert.equal(body.manifest.chat, "texts");
  assert.equal(body.view.older, false);
});

test("a team-tier or non-owner connection reads it as any note", () => {
  assert.equal(ownHistoryRead(storeWith(PRIVATE_OWNER), "tex/history.ledger.json"), true);
  // Without the rules nobody but the private tier qualifies.
  assert.equal(ownHistoryRead(storeWith([{ ...PRIVATE_OWNER[0], tier: "team" }]), "tex/history.ledger.json"), false);
  assert.equal(ownHistoryRead(storeWith([{ ...PRIVATE_OWNER[0], role: "member" }]), "tex/history.ledger.json"), false);
  assert.equal(ownHistoryRead(storeWith([{ ...PRIVATE_OWNER[0], kind: "shared" }]), "tex/history.ledger.json"), false);
  assert.equal(ownHistoryRead(storeWith(PRIVATE_OWNER), "tex/groups/orbit-lamp-river/history.ledger.json"), false, "a group's is read through its row");
  assert.equal(ownHistoryRead(storeWith(PRIVATE_OWNER), "tex/about.md"), false);
});

const TEAM_OWNER = [{ ...PRIVATE_OWNER[0], tier: "team" }];
const TEX_TEAM = [{ prefix: "tex", vis: "team" }];

test("the owner's team connection reads the chat when the path is Team, and not otherwise", async () => {
  const path = "tex/history.ledger.json";
  assert.equal(ownHistoryRead(storeWith(TEAM_OWNER), path, "team", TEX_TEAM, new Map()), true, "the tex folder set to Team");
  assert.equal(ownHistoryRead(storeWith(TEAM_OWNER), path, "team", [], new Map([[path, "team"]])), true, "the file itself set to Team");
  assert.equal(ownHistoryRead(storeWith(TEAM_OWNER), path, "team", [], new Map()), false, "private by default");
  assert.equal(ownHistoryRead(storeWith(TEAM_OWNER), path, "team", TEX_TEAM, new Map([[path, "private"]])), false, "the file held back");
  assert.equal(ownHistoryRead(storeWith([{ ...TEAM_OWNER[0], role: "member" }]), path, "team", TEX_TEAM, new Map()), false, "not the owner");
  assert.equal(ownHistoryRead(storeWith([{ ...TEAM_OWNER[0], kind: "shared" }]), path, "team", TEX_TEAM, new Map()), false, "not their personal workspace");

  const store = storeWith(TEAM_OWNER, [entry(1, "what's on today"), entry(2, "Two things")]);
  const answer = await toolReadNote(store, "team", TEX_TEAM, new Map(), path);
  assert.equal(answer.isError, undefined);
  const text = answer.content[0].text;
  assert.match(text, /\nvisibility: team\n/, "the header says what the path really is");
  assert.deepEqual(JSON.parse(text.slice(text.indexOf("{"))).entries.map((e) => e.text), ["what's on today", "Two things"]);
  const refused = await toolReadNote(storeWith(TEAM_OWNER, [entry(1, "secret")]), "team", [], new Map(), path);
  assert.equal(refused.isError, true);
  assert.doesNotMatch(refused.content[0].text, /secret/);
});

test("a long chat is cut to fit one answer, and says older entries are kept", async () => {
  const many = Array.from({ length: 300 }, (_, n) => entry(n + 1, "x".repeat(800)));
  const text = await readOwnHistory(storeWith(PRIVATE_OWNER, many));
  assert.ok(text.length <= HISTORY_READ_CHARS);
  const body = JSON.parse(text);
  assert.equal(body.view.older, true);
  assert.equal(body.entries.at(-1).id, "e300", "the newest is kept");
});

test("the answer marks the turn as having read other people's words", async () => {
  const store = storeWith(PRIVATE_OWNER, [entry(1, "hi")]);
  const result = await toolReadNote(store, "private", [], new Map(), "tex/history.ledger.json");
  const ledger = newLedger();
  recordRead(ledger, { name: "read_note", args: { path: "tex/history.ledger.json" }, result });
  assert.equal(ledger.untrusted, true);
});

test("an older stretch is read by paging back with before", async () => {
  const many = Array.from({ length: 300 }, (_, n) => entry(n + 1, "x".repeat(800)));
  const store = storeWith(PRIVATE_OWNER, many);
  const first = JSON.parse(await readOwnHistory(store));
  assert.equal(Number.isSafeInteger(first.view.before), true, "the answer names where the next page starts");
  const second = JSON.parse(await readOwnHistory(store, { before: first.view.before }));
  assert.ok(second.entries.length > 0);
  assert.equal(second.entries.at(-1).seq, first.view.before - 1, "the page ends right before the first one began");
  assert.ok(second.entries.every((e) => e.seq < first.view.before));
  // Through the tool, as a connected AI asks.
  const answer = await toolReadNote(store, "private", [], new Map(), "tex/history.ledger.json", { before: 3 });
  const body = JSON.parse(answer.content[0].text.slice(answer.content[0].text.indexOf("{")));
  assert.deepEqual(body.entries.map((e) => e.id), ["e1", "e2"]);
  assert.equal(body.view.older, false);
  assert.equal(body.view.before, undefined, "nothing older: no next page named");
});

test("a job's own entries are read alone", async () => {
  const store = storeWith(PRIVATE_OWNER, [
    entry(1, "split the project"),
    { id: "j1", kind: "job", at: 1_700_000_000_002, job: "job-1", state: "started" },
    { id: "t1", kind: "tool", at: 1_700_000_000_003, name: "write", jobId: "job-1", ok: false, reason: "busy" },
    entry(4, "anything else?"),
    { id: "t2", kind: "tool", at: 1_700_000_000_005, name: "search_web", jobId: "job-2", ok: true },
  ]);
  const body = JSON.parse(await readOwnHistory(store, { job: "job-1" }));
  assert.deepEqual(body.entries.map((e) => e.id), ["j1", "t1"]);
  assert.equal(body.view.job, "job-1");
  // A malformed id is not a filter.
  assert.equal(JSON.parse(await readOwnHistory(store, { job: "x' OR 1=1" })).entries.length, 5);
});
