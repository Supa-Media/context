/**
 * A GROUP CHAT'S HISTORY HAS ONE COPY: ITS RECORD (the owner, 2026-11-01: "one copy in the durable object", and no
 * group chat data in a workspace folder; `src/agent/groupMemoryCarry.js`).
 *
 * On 2026-11-01 a group chat forgot every reply since its memory note stopped taking writes: each turn rebuilt the
 * history from that stale note (its version was not the one Tex last wrote, so it read as "edited"), and wrote the
 * record back with it. These pin the fix:
 *
 *  - no memory note is written, in the home or the bound workspace; the record is the history;
 *  - the old notes' words are carried into the record once, and a note is never read as the history again;
 *  - a stale note never replaces turns the record holds, and a turn only the note held is kept too;
 *  - a place that could not be read waits for a later turn, at most CARRY_TRIES of them;
 *  - two turns that overlap both keep their exchange (the record is read again just before the write).
 *
 * ## Sabotage record
 *
 *   readGroupMemory reading the home's note as the history when its etag moved → "a stale note never replaces" fails
 *   keepGroupExchange writing over `history` instead of the record read just before → "two turns that overlap" fails
 *   carryOldNotes marking carried while a place is unreadable → "an unreadable place waits" fails
 *   keepGroupExchange writing when the record could not be read → "a record that cannot be read is never written over" fails
 *   mergeTurns keeping only the longer of the two → "a turn only the note held is kept" fails
 */
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { test } from "node:test";

import { groupMemoryPath, keepGroupExchange, readGroupMemory } from "../src/agent/groupTurn.js";
import { renderGroupNote } from "../src/agent/groupMemoryNote.js";
import { CARRY_TRIES, mergeTurns } from "../src/agent/groupMemoryCarry.js";
import { createMemoryStore } from "./gmailSync/fixtures.mjs";

const HOME = "tex/groups/orbit-lamp-river";
const KEY = "a".repeat(64);
const MEMBERS = "b".repeat(64);
const GROUP = { key: KEY, members: MEMBERS, from: "ada", people: ["ada"], chat: [] };
const hashOf = (text) => createHash("sha256").update(text).digest("hex").slice(0, 12);
const homeNote = (hash = hashOf(KEY)) => `${HOME}/chat-${hash}.md`;
const boundNote = (hash = hashOf(`${KEY}:${MEMBERS}`)) => `tex/groups/chat-${hash}.md`;

const OLD = [
  { role: "user", text: "@ada: the gig is friday" },
  { role: "assistant", text: "Noted: Friday." },
];

/** A folder of notes answering `read_note` as the tool does; `broken` paths answer an error that is not "not found". */
function folder(seed = {}, { broken = [] } = {}) {
  const calls = [];
  const notes = new Map(Object.entries(seed));
  const dispatch = async (name, args) => {
    calls.push({ name, args });
    if (name === "read_note" && broken.includes(args.path)) return { isError: true, content: [{ type: "text", text: "This note cannot be opened safely right now." }] };
    if (name === "read_note" && notes.has(args.path)) return { content: [{ type: "text", text: `etag: v1\n\n${notes.get(args.path)}` }] };
    if (name === "write_note") {
      notes.set(args.path, args.content);
      return { content: [{ type: "text", text: `Wrote ${args.path} (etag v2)` }] };
    }
    return { isError: true, content: [{ type: "text", text: "not found" }] };
  };
  return { calls, notes, dispatch };
}

const withHome = (home, extra = {}) => ({ ...GROUP, ...extra, home: { folder: HOME, dispatch: home.dispatch } });
const said = (history) => JSON.stringify(history);
const recordOf = async (store, group = GROUP) => JSON.parse(await (await store.get(await groupMemoryPath(group))).text());
const quiet = async (run) => {
  const original = console.log;
  console.log = () => {};
  try {
    return await run();
  } finally {
    console.log = original;
  }
};

test("the record is the history: the home gets a printout it never reads, and the bound workspace no note", async () => {
  const store = createMemoryStore();
  const bound = folder();
  const home = folder();
  await quiet(async () => {
    const group = withHome(home);
    await keepGroupExchange(store, group, await readGroupMemory(store, group, bound.dispatch), "what's for dinner?", "Pasta.", { dispatch: bound.dispatch });
    // The printout is there for the chat's people to read and download.
    assert.deepEqual([...home.notes.keys()], [homeNote()]);
    assert.match(home.notes.get(homeNote()), /what's for dinner\?\n\n\*\*Tex:\*\* Pasta\./);
    assert.match(home.notes.get(homeNote()), /Tex never reads this page/);
    // Somebody changes the printout: it is not what Tex goes by.
    home.notes.set(homeNote(), home.notes.get(homeNote()).replace("Pasta.", "Sushi."));
    const next = await readGroupMemory(store, withHome(home), bound.dispatch);
    assert.match(said(next), /Pasta\./);
    assert.doesNotMatch(said(next), /Sushi/);
    // Somebody added reads what the chat kept: one record per chat, by its key alone.
    assert.match(said(await readGroupMemory(store, withHome(home, { members: "c".repeat(64) }), bound.dispatch)), /Pasta\./);
  });
  assert.ok(!bound.calls.some((call) => call.name === "write_note"), "nothing is written in the bound workspace");
  assert.equal(bound.notes.size, 0);
});

test("a printout over an existing page is written at the version just read, and a lost race is tried once more", async () => {
  const { writeMemoryPrintout } = await import("../src/agent/groupMemoryNote.js");
  const writes = [];
  let version = 1;
  const dispatch = async (name, args) => {
    if (name === "read_note") return { content: [{ type: "text", text: `etag: v${version}\n\nold page` }] };
    writes.push(args.expected_etag);
    // Somebody else's write lands between the first read and its write.
    if (writes.length === 1) {
      version = 2;
      return { isError: true, content: [{ type: "text", text: "conflict: note changed" }] };
    }
    return { content: [{ type: "text", text: "Wrote it" }] };
  };
  assert.equal(await writeMemoryPrintout(dispatch, homeNote(), OLD, { log: () => {} }), true);
  assert.deepEqual(writes, ["v1", "v2"]);
  const lines = [];
  const refusing = async (name) => (name === "read_note" ? { isError: true, content: [{ type: "text", text: "not found" }] } : { isError: true, content: [{ type: "text", text: "permission denied: the gig is friday" }] });
  assert.equal(await writeMemoryPrintout(refusing, homeNote(), OLD, { log: (line) => lines.push(line) }), false);
  assert.deepEqual(lines.map((line) => JSON.parse(line)), [{ event: "group_memory_printout_not_written", reason: "permission denied" }], "said once, with no words of the page");
});

test("an old note's words are carried into the record once, and the note is never read as the history again", async () => {
  const store = createMemoryStore();
  const bound = folder({ [boundNote()]: renderGroupNote(OLD) });
  const home = folder();
  await quiet(async () => {
    assert.match(said(await readGroupMemory(store, withHome(home), bound.dispatch)), /the gig is friday/, "carried on the first turn");
    const record = await recordOf(store);
    assert.equal(record.carried, 1);
    assert.deepEqual(record.carriedFrom, [{ where: "default", path: boundNote() }], "where it came from, for the sweep that trashes it");
    // Somebody edits the old note afterwards: it is no longer the chat's memory, and is not read again.
    bound.notes.set(boundNote(), renderGroupNote([{ role: "user", text: "@bo: the gig is sunday" }, { role: "assistant", text: "Sunday." }]));
    const reads = bound.calls.length + home.calls.length;
    const later = await readGroupMemory(store, withHome(home), bound.dispatch);
    assert.match(said(later), /the gig is friday/);
    assert.doesNotMatch(said(later), /sunday/);
    const memoryReads = [...bound.calls, ...home.calls].slice(reads).filter((call) => /\/chat-[0-9a-f]{12}\.md$/.test(call.args.path ?? ""));
    assert.deepEqual(memoryReads, [], "no memory note is read once carried");
  });
});

test("a stale note never replaces turns the record holds (the chat that forgot, 2026-11-01)", async () => {
  const store = createMemoryStore();
  // The home's note stopped taking writes after the first exchange; the record kept on.
  const home = folder({ [homeNote()]: renderGroupNote(OLD) });
  const newer = [
    ...OLD,
    { role: "user", text: "@bo: load-in is at 6" },
    { role: "assistant", text: "Load-in at 6." },
  ];
  await store.put(await groupMemoryPath(GROUP), JSON.stringify({ version: 1, turns: newer, noteEtag: "an-etag-the-note-never-had" }));
  await quiet(async () => {
    const history = await readGroupMemory(store, withHome(home), folder().dispatch);
    assert.match(said(history), /load-in is at 6/, "the record's newer turns stand");
    assert.match(said(history), /the gig is friday/);
    await keepGroupExchange(store, withHome(home), history, "when's load-in?", "6.", {});
    const again = await readGroupMemory(store, withHome(home), folder().dispatch);
    assert.match(said(again), /load-in is at 6[\s\S]*when's load-in/, "and the next turn adds to them");
  });
});

test("a turn only the note held is kept beside the record's, in order", () => {
  const onlyNote = { role: "user", text: "@ada: bring the cables" };
  const noteTurns = [...OLD, onlyNote, { role: "assistant", text: "Cables, got it." }];
  const recordTurns = [...OLD, { role: "user", text: "@bo: load-in is at 6" }, { role: "assistant", text: "Load-in at 6." }];
  const merged = mergeTurns(recordTurns, noteTurns);
  assert.deepEqual(merged.map((turn) => turn.text), ["@ada: the gig is friday", "Noted: Friday.", "@ada: bring the cables", "Cables, got it.", "@bo: load-in is at 6", "Load-in at 6."]);
  assert.deepEqual(mergeTurns(recordTurns, OLD), recordTurns, "a note the record already holds changes nothing");
  assert.deepEqual(mergeTurns(recordTurns, []), recordTurns);
});

test("an unreadable place waits for a later turn, at most CARRY_TRIES of them", async () => {
  const store = createMemoryStore();
  const bound = folder({}, { broken: [boundNote()] });
  await quiet(async () => {
    for (let turn = 1; turn < CARRY_TRIES; turn += 1) {
      await readGroupMemory(store, { ...GROUP }, bound.dispatch);
      const record = await recordOf(store);
      assert.notEqual(record.carried, 1, `not carried on turn ${turn}`);
      assert.equal(record.carryTries, turn);
    }
    await readGroupMemory(store, { ...GROUP }, bound.dispatch);
    assert.equal((await recordOf(store)).carried, 1, "given up on after the last try, so no turn reads it forever");
  });
});

test("two turns that overlap both keep their exchange", async () => {
  const store = createMemoryStore();
  await quiet(async () => {
    // Both turns read the memory before either kept its exchange.
    const first = await readGroupMemory(store, { ...GROUP }, null);
    const second = await readGroupMemory(store, { ...GROUP }, null);
    await keepGroupExchange(store, { ...GROUP }, first, "the gig is friday", "Noted: Friday.");
    await keepGroupExchange(store, { ...GROUP }, second, "load-in is at 6", "Load-in at 6.");
    const history = await readGroupMemory(store, { ...GROUP }, null);
    assert.match(said(history), /the gig is friday[\s\S]*load-in is at 6/);
  });
});

test("a read with no dispatcher (a review's) never marks the old notes carried", async () => {
  const store = createMemoryStore();
  const bound = folder({ [boundNote()]: renderGroupNote(OLD) });
  await quiet(async () => {
    await keepGroupExchange(store, { ...GROUP }, await readGroupMemory(store, { ...GROUP }, null), "load-in is at 6", "Load-in at 6.");
    assert.notEqual((await recordOf(store)).carried, 1);
    const history = await readGroupMemory(store, { ...GROUP }, bound.dispatch);
    assert.match(said(history), /the gig is friday[\s\S]*load-in is at 6/, "the next turn still carries the old note in, before the newer exchange");
  });
});

test("a record that cannot be read is never written over with less", async () => {
  const store = createMemoryStore();
  await quiet(async () => {
    await keepGroupExchange(store, { ...GROUP }, [], "the gig is friday", "Noted: Friday.");
    const kept = await (await store.get(await groupMemoryPath(GROUP))).text();
    // The record is there, but this read of it fails.
    const failing = Object.create(store);
    failing.get = async () => {
      throw new Error("object storage hiccup");
    };
    assert.deepEqual(await readGroupMemory(failing, { ...GROUP }, folder().dispatch), [], "an empty memory this turn, not a failed answer");
    await keepGroupExchange(failing, { ...GROUP }, [], "load-in is at 6", "Load-in at 6.");
    assert.equal(await (await store.get(await groupMemoryPath(GROUP))).text(), kept, "the record is as it was");
  });
});
