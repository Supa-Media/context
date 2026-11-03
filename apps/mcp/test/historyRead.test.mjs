/**
 * A person's history file read straight from their ledger by a connected AI (`src/tools/notes/historyRead.js`), so a
 * chat whose history row was never made is still readable, on the owner's own private connection and nowhere else.
 *
 * Sabotage record (2026-11-03), each fails a test here:
 *  - `ownHistoryRead` without `deskEligible` → "a team-tier or non-owner connection reads it as any note";
 *  - `toolReadNote` without the ledger branch → "the owner reads the chat from the ledger with no row";
 *  - the `trust: untrusted` line dropped → "the answer marks the turn as having read other people's words".
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
  const answer = await toolReadNote(store, "private", {}, {}, "tex/history.ledger.json");
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
  assert.equal(ownHistoryRead(storeWith([{ ...PRIVATE_OWNER[0], tier: "team" }]), "tex/history.ledger.json"), false);
  assert.equal(ownHistoryRead(storeWith([{ ...PRIVATE_OWNER[0], role: "member" }]), "tex/history.ledger.json"), false);
  assert.equal(ownHistoryRead(storeWith([{ ...PRIVATE_OWNER[0], kind: "shared" }]), "tex/history.ledger.json"), false);
  assert.equal(ownHistoryRead(storeWith(PRIVATE_OWNER), "tex/groups/orbit-lamp-river/history.ledger.json"), false, "a group's is read through its row");
  assert.equal(ownHistoryRead(storeWith(PRIVATE_OWNER), "tex/about.md"), false);
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
  const result = await toolReadNote(store, "private", {}, {}, "tex/history.ledger.json");
  const ledger = newLedger();
  recordRead(ledger, { name: "read_note", args: { path: "tex/history.ledger.json" }, result });
  assert.equal(ledger.untrusted, true);
});
