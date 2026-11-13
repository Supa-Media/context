/**
 * A GROUP CHAT'S MEMORY PAGE RETIRED INTO ITS LEDGER (Dev, 2026-11-02, on a
 * decision card: "Retire it, one copy"; `src/agent/groupPageCopy.js`).
 *
 * ## Sabotage record
 *
 * Applied, suite run, named check observed failing, reverted (2026-11-02):
 *  1. `keepGroupExchange` writing the page whatever `pageCopied` says → "once
 *     copied in, the ledger is the history" fails (the page grows).
 *  2. `pageEntries` ignoring what the ledger holds (`held`) → "only what the
 *     ledger lacks is copied" fails.
 *  3. `copyGroupPageIn` copying before the old log is in → "a page waits for
 *     the old log" fails.
 *  4. `groupQuestion` leaving the chatter out of the block → "a group's texts
 *     read back as the page kept them" fails.
 *
 * Applied, suite run, named check observed failing, reverted (2026-11-12):
 *  5. `readGroupMemory` without the new-chat start (`startOnLedger` never
 *     called) → "a new chat starts on its ledger" fails (its first exchange
 *     makes `history.md`, the second history file Nov Babies showed).
 *  6. `keepGroupExchange` keeping a ledger-first chat's turns in its record →
 *     the same check fails (a second copy in the record).
 */

import assert from "node:assert/strict";
import { test } from "node:test";

import { keepGroupExchange, readGroupMemory, checkerHistory, groupMemoryPath } from "../src/agent/groupTurn.js";
import { readChatMemoryRecord, writeChatMemoryRecord } from "../src/agent/chatMemoryRecord.js";
import { GROUP_PAGE_COPIED, copyGroupPageIn, pageEntries } from "../src/agent/groupPageCopy.js";
import { groupQuestion } from "../src/agent/groupLedgerHistory.js";
import { GROUP_BACKFILLED } from "../src/agent/ledgerBackfill.js";
import { texLedger } from "../src/texStore/ledger.js";
import { durableSql } from "./texStoreFixture.mjs";
import { createMemoryStore } from "./gmailSync/fixtures.mjs";

const HOME = "tex/groups/orbit-lamp-river";
const KEY = "a".repeat(64);
const GROUP = { key: KEY, members: "b".repeat(64), from: "ada", people: ["ada"], chat: [] };
const PAGE = `${HOME}/history.md`;

function folder() {
  const notes = new Map();
  const versions = new Map();
  const dispatch = async (name, args) => {
    if (name === "read_note" && notes.has(args.path)) return { content: [{ type: "text", text: `etag: v${versions.get(args.path)}\n\n${notes.get(args.path)}` }] };
    if (name === "write_note") {
      if (notes.has(args.path) && args.expected_etag !== `v${versions.get(args.path)}`) return { isError: true, content: [{ type: "text", text: "conflict" }] };
      notes.set(args.path, args.content);
      versions.set(args.path, (versions.get(args.path) ?? 0) + 1);
      return { content: [{ type: "text", text: "ok" }] };
    }
    return { isError: true, content: [{ type: "text", text: "not found" }] };
  };
  return { notes, dispatch, edit: (path, text) => (notes.set(path, text), versions.set(path, versions.get(path) + 1)) };
}

function world({ older = true } = {}) {
  const ledger = texLedger(durableSql());
  const store = Object.assign(createMemoryStore(), { texLedger: (chat) => (chat === KEY ? ledger : null) });
  const home = folder();
  const bound = folder();
  const group = () => ({ ...GROUP, home: { folder: HOME, dispatch: home.dispatch } });
  // A chat Tex answered before the ledger: it has a record, so its first turn here keeps a page as it did then.
  const ready = older ? groupMemoryPath(group()).then((path) => writeChatMemoryRecord(store, group(), path, JSON.stringify({ version: 1, turns: [] }))) : Promise.resolve();
  return { ledger, store, home, bound, group, ready };
}

const quiet = async (run) => {
  const original = console.log;
  console.log = () => {};
  try {
    return await run();
  } finally {
    console.log = original;
  }
};

test("once copied in, the ledger is the history: the page is neither read nor written again", async () => {
  const { ledger, store, home, bound, group, ready } = world();
  await ready;
  await quiet(async () => {
    // Before: an exchange kept on the page, the one copy then.
    await keepGroupExchange(store, group(), await readGroupMemory(store, group(), bound.dispatch), "what's for dinner?", "Pasta.");
    assert.match(home.notes.get(PAGE), /Pasta\./);
    // The next turn copies the page in, marks it, and reads its history from the ledger.
    const g = group();
    const history = await readGroupMemory(store, g, bound.dispatch);
    assert.equal(g.pageCopied, true);
    assert.match(JSON.stringify(history), /what's for dinner\?[\s\S]*Pasta\./);
    const kept = ledger.read(KEY).entries;
    assert.equal(kept[0].id, GROUP_PAGE_COPIED, "the mark goes first");
    assert.deepEqual(kept.slice(1).map((e) => e.kind), ["text", "text", "reply"]);
    // A change to the page is no longer what Tex goes by, and an exchange no longer writes it.
    const before = home.notes.get(PAGE);
    home.edit(PAGE, before.replace("Pasta.", "Sushi."));
    const g2 = group();
    const again = await readGroupMemory(store, g2, bound.dispatch);
    assert.doesNotMatch(JSON.stringify(again), /Sushi/);
    await keepGroupExchange(store, g2, again, "and dessert?", "Tiramisu.");
    assert.doesNotMatch(home.notes.get(PAGE), /Tiramisu/);
    // Copying again copies nothing.
    assert.equal((await copyGroupPageIn(ledger, KEY, [])).state, "done");
    assert.equal(ledger.read(KEY).entries.length, kept.length);
  });
});

test("only what the ledger lacks is copied, and a copy run twice keeps one of each", async () => {
  const turns = [
    { role: "user", text: "@ada: the gig is friday" },
    { role: "assistant", text: "Noted: Friday." },
    { role: "user", text: "@bo: and the van?" },
    { role: "assistant", text: "Bo has the van. I'll remind him Thursday." },
  ];
  const entries = await pageEntries(turns, { held: new Set(["Bo has the van. I'll remind him Thursday."]), before: 1_000 });
  assert.deepEqual(entries.filter((e) => e.kind === "text").map((e) => e.text), ["@ada: the gig is friday", "Noted: Friday."]);
  assert.ok(entries.every((e) => e.at < 1_000), "before everything the ledger holds");
  const ledger = texLedger(durableSql());
  assert.equal((await copyGroupPageIn(ledger, KEY, turns)).state, "copied");
  const count = ledger.read(KEY).entries.length;
  await ledger.prepend(KEY, (await pageEntries(turns, { before: 10 })).slice(0, 3));
  assert.equal(ledger.read(KEY).entries.length, count, "the same exchange has the same ids");
});

test("a page waits for the old log: copied only once the chat's old log is in", async () => {
  const ledger = texLedger(durableSql());
  ledger.append(KEY, [{ id: "e1", kind: "text", at: 5_000, from: { kind: "person" }, text: "hi" }]);
  const turns = [{ role: "user", text: "q" }, { role: "assistant", text: "a" }];
  assert.equal((await copyGroupPageIn(ledger, KEY, turns)).state, "waiting");
  await ledger.prepend(KEY, [{ v: 1, id: GROUP_BACKFILLED, at: 4_000, kind: "note", text: "x", backfill: "mark" }]);
  assert.equal((await copyGroupPageIn(ledger, KEY, turns)).state, "copied");
  assert.equal(ledger.oldest(KEY).id, GROUP_PAGE_COPIED);
});

test("a page whose chat's old log is nowhere goes in without it when asked", async () => {
  const ledger = texLedger(durableSql());
  ledger.append(KEY, [{ id: "e1", kind: "text", at: 5_000, from: { kind: "person" }, text: "hi" }]);
  const turns = [{ role: "user", text: "q" }, { role: "assistant", text: "a" }];
  assert.equal((await copyGroupPageIn(ledger, KEY, turns, { dryRun: true, withoutLog: true })).state, "would");
  assert.equal(ledger.oldest(KEY).id, "e1", "a dry run changes nothing");
  assert.equal((await copyGroupPageIn(ledger, KEY, turns, { withoutLog: true })).state, "copied");
  assert.equal(ledger.oldest(KEY).id, GROUP_PAGE_COPIED);
});

test("a group's texts read back as the page kept them: the chatter in its block, then the ask, each named", () => {
  const texts = [
    { from: { kind: "person", name: "bo" } },
    { from: { kind: "person", name: "@ada" } },
  ];
  const question = groupQuestion(texts, ["running late", "Tex can you push dinner to 8"]);
  assert.match(question, /^\(What the chat said since you last answered[^\n]*\n@bo: running late\n\n@ada: Tex can you push dinner to 8$/);
  // The Mail checker is shown the ask alone.
  assert.equal(checkerHistory([{ role: "user", text: question }])[0].text, "@ada: Tex can you push dinner to 8");
  assert.equal(groupQuestion([{ from: { kind: "person", name: "ada" } }], ["@tex hi"]), "@ada: @tex hi");
});

test("once copied in, the ledger's history is read beside the chat's notes, not after them", async () => {
  // Sabotage: reading the ledger's texts only after the notes (as before 2026-11-06) leaves no read of them while
  // the notes are held, and this fails.
  const { ledger, store, home, bound, group, ready } = world();
  await ready;
  await quiet(async () => {
    await keepGroupExchange(store, group(), await readGroupMemory(store, group(), bound.dispatch), "what's for dinner?", "Pasta.");
    await readGroupMemory(store, group(), bound.dispatch); // copies the page in
    let release;
    const held = new Promise((resolve) => (release = resolve));
    let notesHeld = 0;
    let released = false;
    let readWhileHeld = false;
    const read = ledger.read.bind(ledger);
    const watched = Object.assign(Object.create(ledger), {
      read: (chat, options = {}) => {
        if (options.kinds?.includes("text") && !released) readWhileHeld = true;
        return read(chat, options);
      },
    });
    const slow = (dispatch) => async (name, args) => {
      notesHeld += 1;
      await held;
      return dispatch(name, args);
    };
    const s = Object.assign(Object.create(store), { texLedger: (chat) => (chat === KEY ? watched : null) });
    const g = { ...GROUP, home: { folder: HOME, dispatch: slow(home.dispatch) } };
    const turn = readGroupMemory(s, g, slow(bound.dispatch));
    for (let i = 0; i < 50 && !readWhileHeld; i += 1) await new Promise((resolve) => setTimeout(resolve, 2));
    released = true;
    release();
    const history = await turn;
    assert.ok(notesHeld > 0, "some note was read through the held tools");
    assert.ok(readWhileHeld, "the ledger's texts were asked for while the notes were still out");
    assert.equal(g.pageCopied, true);
    assert.match(JSON.stringify(history), /what's for dinner\?[\s\S]*Pasta\./);
  });
});

test("a ledger that fails to read beside the notes leaves the page retired, as before", async () => {
  const { ledger, store, home, bound, group, ready } = world();
  await ready;
  await quiet(async () => {
    await keepGroupExchange(store, group(), await readGroupMemory(store, group(), bound.dispatch), "what's for dinner?", "Pasta.");
    await readGroupMemory(store, group(), bound.dispatch);
    const read = ledger.read.bind(ledger);
    const failing = Object.assign(Object.create(ledger), {
      read: (chat, options = {}) => {
        if (options.kinds?.includes("text")) throw new Error("ledger down");
        return read(chat, options);
      },
    });
    const s = Object.assign(Object.create(store), { texLedger: (chat) => (chat === KEY ? failing : null) });
    const g = group();
    const history = await readGroupMemory(s, g, bound.dispatch);
    assert.equal(g.pageCopied, true, "the page stays retired: a failed read never writes it again");
    assert.ok(Array.isArray(history));
    await keepGroupExchange(store, g, history, "and dessert?", "Tiramisu.");
    assert.doesNotMatch(home.notes.get(PAGE), /Tiramisu/);
  });
});

test("a new chat starts on its ledger: no memory page is made, and the record keeps no turns", async () => {
  const { ledger, store, home, bound, group } = world({ older: false });
  await quiet(async () => {
    const g = group();
    const history = await readGroupMemory(store, g, bound.dispatch);
    assert.deepEqual(history, []);
    assert.equal(g.pageCopied, true);
    assert.equal(ledger.oldest(KEY).id, GROUP_PAGE_COPIED, "marked from the start, so nothing waits for an old log");
    await keepGroupExchange(store, g, history, "what's for dinner?", "Pasta.");
    assert.equal(home.notes.has(PAGE), false, "no history.md beside the ledger's view");
    const record = await readChatMemoryRecord(store, g, await groupMemoryPath(g));
    assert.ok(record !== null, "the record is made, so the chat is never new again");
    assert.doesNotMatch(record, /Pasta/, "the exchange is the ledger's, not a second copy in the record");
    // The route writes the exchange to the ledger; the next turn reads it from there and still makes no page.
    ledger.append(KEY, await pageEntries([{ role: "user", text: "@ada: what's for dinner?" }, { role: "assistant", text: "Pasta." }], { before: Date.now() + 60_000 }));
    const g2 = group();
    const again = await readGroupMemory(store, g2, bound.dispatch);
    assert.equal(g2.pageCopied, true);
    assert.match(JSON.stringify(again), /dinner[\s\S]*Pasta\./);
    await keepGroupExchange(store, g2, again, "and dessert?", "Tiramisu.");
    assert.equal(home.notes.has(PAGE), false);
  });
});

test("a new chat whose home already holds a page copies that page in, as an older chat does", async () => {
  const { ledger, store, home, bound, group } = world({ older: false });
  await quiet(async () => {
    await home.dispatch("write_note", { path: PAGE, content: "# Tex's memory of this group chat\n\nintro\n\n---\n\n@ada: the gig is friday\n\n**Tex:** Noted: Friday.\n" });
    const g = group();
    await readGroupMemory(store, g, bound.dispatch);
    assert.notEqual(ledger.oldest(KEY)?.id, GROUP_PAGE_COPIED, "not marked empty over a page with words on it");
  });
});
