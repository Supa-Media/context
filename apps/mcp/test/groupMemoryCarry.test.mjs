/**
 * A GROUP CHAT'S HISTORY HAS ONE COPY (the owner, 2026-11-01: "one copy in the durable object", no group chat data in
 * a workspace folder, and then: the page in the chat's home is the one copy; `src/agent/groupMemoryCarry.js`).
 *
 * On 2026-11-01 a group chat forgot every reply since its memory note stopped taking writes: each turn rebuilt the
 * history from that stale note (its version was not the one Tex last wrote, so it read as "edited"), and wrote the
 * record back with it. These pin the fix:
 *
 *  - in a home, the page is the history: Tex goes by it, a change somebody makes there is what it goes by, and the
 *    record keeps no turns once they are on the page;
 *  - the page is written at the version just read, a write that lost is read again, and a page Tex cannot read is
 *    never written over; a failed write is logged;
 *  - a chat with no home keeps its turns in the record, and they move onto the page once it has one, the page first;
 *  - nothing is written in a workspace folder; the old notes' words are carried in once and never read again;
 *  - a stale note never replaces turns the record holds, and a turn only the note held is kept too;
 *  - a place that could not be read waits for a later turn, at most CARRY_TRIES of them;
 *  - two turns that overlap both keep their exchange.
 *
 * ## Sabotage record
 *
 *   readGroupMemory reading the record's turns once ON_PAGE → "a change somebody makes there is what Tex goes by" fails
 *   updateGroupPage writing without expected_etag → "a write another turn won is read again" fails
 *   updateGroupPage writing over a page with no heading → "a page Tex cannot read is never written over" fails
 *   keepGroupExchange writing the record's turns when the home is unopened → "keeps nothing in a second place" fails
 *   moveOntoPage marking the record onPage before the page took its turns → "a page that will not take the move" fails
 *   keepGroupExchange writing over `history` instead of the record read just before → "two turns that overlap" fails
 *   carryOldNotes marking carried while a place is unreadable → "an unreadable place waits" fails
 *   keepGroupExchange writing when the record could not be read → "a record that cannot be read is never written over" fails
 *   mergeTurns keeping only the longer of the two → "a turn only the note held is kept" fails
 */
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { test } from "node:test";

import { groupMemoryPath, keepGroupExchange, readGroupMemory } from "../src/agent/groupTurn.js";
import { renderGroupNote, updateGroupPage } from "../src/agent/groupMemoryNote.js";
import { CARRY_TRIES, ON_PAGE, mergeTurns } from "../src/agent/groupMemoryCarry.js";
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

/**
 * A folder of notes answering `read_note` and `write_note` as the tools do: each note has a version, a write that
 * names an older one is refused as a conflict, and `broken` paths answer an error that is not "not found".
 */
function folder(seed = {}, { broken = [], refuse = null } = {}) {
  const calls = [];
  const notes = new Map(Object.entries(seed));
  const versions = new Map([...notes.keys()].map((path) => [path, 1]));
  const dispatch = async (name, args) => {
    calls.push({ name, args });
    if (name === "read_note" && broken.includes(args.path)) return { isError: true, content: [{ type: "text", text: "This note cannot be opened safely right now." }] };
    if (name === "read_note" && notes.has(args.path)) return { content: [{ type: "text", text: `etag: v${versions.get(args.path)}\n\n${notes.get(args.path)}` }] };
    if (name === "write_note") {
      if (refuse !== null) return { isError: true, content: [{ type: "text", text: refuse }] };
      if (notes.has(args.path) && args.expected_etag !== `v${versions.get(args.path)}`) return { isError: true, content: [{ type: "text", text: "conflict: note changed since it was read; re-read and retry" }] };
      notes.set(args.path, args.content);
      versions.set(args.path, (versions.get(args.path) ?? 0) + 1);
      return { content: [{ type: "text", text: `Wrote ${args.path} (etag v${versions.get(args.path)})` }] };
    }
    return { isError: true, content: [{ type: "text", text: "not found" }] };
  };
  /** Somebody edits the note in the app: a new version. */
  const edit = (path, content) => {
    notes.set(path, content);
    versions.set(path, (versions.get(path) ?? 0) + 1);
  };
  return { calls, notes, dispatch, edit };
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

test("in a home the page is the one copy: a change somebody makes there is what Tex goes by, and the record keeps no turns", async () => {
  const store = createMemoryStore();
  const bound = folder();
  const home = folder();
  await quiet(async () => {
    const group = withHome(home);
    await keepGroupExchange(store, group, await readGroupMemory(store, group, bound.dispatch), "what's for dinner?", "Pasta.");
    assert.deepEqual([...home.notes.keys()], [homeNote()]);
    assert.match(home.notes.get(homeNote()), /what's for dinner\?\n\n\*\*Tex:\*\* Pasta\./);
    assert.match(home.notes.get(homeNote()), /Tex reads this page before it answers/);
    const record = await recordOf(store);
    assert.equal(record.onPage, ON_PAGE);
    assert.equal(record.turns, undefined, "the record holds no second copy");
    // Somebody changes the page in the app: that is what Tex goes by.
    home.edit(homeNote(), home.notes.get(homeNote()).replace("Pasta.", "Sushi."));
    const next = await readGroupMemory(store, withHome(home), bound.dispatch);
    assert.match(said(next), /Sushi\./);
    assert.doesNotMatch(said(next), /Pasta/);
    // A review reads the same page, with no dispatcher.
    assert.match(said(await readGroupMemory(store, withHome(home), null)), /Sushi\./);
    // Somebody added reads what the chat kept: one page per chat, by its key alone.
    assert.match(said(await readGroupMemory(store, withHome(home, { members: "c".repeat(64) }), bound.dispatch)), /Sushi\./);
    await keepGroupExchange(store, withHome(home), next, "and dessert?", "Tiramisu.");
    assert.match(home.notes.get(homeNote()), /Sushi\.[\s\S]*and dessert\?\n\n\*\*Tex:\*\* Tiramisu\./, "the next exchange is added to the changed page");
  });
  assert.ok(!bound.calls.some((call) => call.name === "write_note"), "nothing is written in the bound workspace");
  assert.equal(bound.notes.size, 0);
});

test("the page is written at the version just read: a write another turn won is read again and both kept", async () => {
  const home = folder({ [homeNote()]: renderGroupNote(OLD) });
  let raced = false;
  const racing = async (name, args) => {
    // Another turn's write lands between this one's read and its write.
    if (name === "write_note" && !raced) {
      raced = true;
      home.edit(homeNote(), renderGroupNote([...OLD, { role: "user", text: "@bo: load-in is at 6" }, { role: "assistant", text: "Load-in at 6." }]));
    }
    return home.dispatch(name, args);
  };
  const added = [{ role: "user", text: "@ada: bring the cables" }, { role: "assistant", text: "Cables, got it." }];
  assert.equal(await updateGroupPage(racing, homeNote(), (turns) => [...turns, ...added], { log: () => {} }), true);
  assert.match(home.notes.get(homeNote()), /load-in is at 6[\s\S]*bring the cables/);
  const writes = home.calls.filter((call) => call.name === "write_note").map((call) => call.args.expected_etag);
  assert.deepEqual(writes, ["v1", "v2"], "each write names the version it read");
  const lines = [];
  const refusing = folder({}, { refuse: "permission denied: the gig is friday" });
  assert.equal(await updateGroupPage(refusing.dispatch, homeNote(), () => OLD, { log: (line) => lines.push(line) }), false);
  assert.deepEqual(lines.map((line) => JSON.parse(line)), [{ event: "group_memory_page_not_written", reason: "permission denied" }], "said once, with no words of the page");
});

test("a page Tex cannot read is never written over", async () => {
  const mine = "My own list:\n- cables\n- the setlist";
  const home = folder({ [homeNote()]: mine });
  const lines = [];
  assert.equal(await updateGroupPage(home.dispatch, homeNote(), (turns) => [...turns, ...OLD], { log: (line) => lines.push(line) }), false);
  assert.equal(home.notes.get(homeNote()), mine);
  assert.deepEqual(lines.map((line) => JSON.parse(line)), [{ event: "group_memory_page_not_written", reason: "not_a_memory_page" }]);
});

test("a chat with no home keeps its turns in the record, and they move onto the page once it has one", async () => {
  const store = createMemoryStore();
  const bound = folder();
  await quiet(async () => {
    await keepGroupExchange(store, { ...GROUP }, await readGroupMemory(store, { ...GROUP }, bound.dispatch), "the gig is friday", "Noted: Friday.");
    assert.equal((await recordOf(store)).turns.length, 2, "with no home, the record is the copy");
    // The chat gets a home; its page has a printout from before (#2567), one exchange behind the record.
    await keepGroupExchange(store, { ...GROUP }, [], "load-in is at 6", "Load-in at 6.");
    const home = folder({ [homeNote()]: renderGroupNote(OLD) });
    const history = await readGroupMemory(store, withHome(home), bound.dispatch);
    assert.match(said(history), /the gig is friday[\s\S]*load-in is at 6/);
    assert.match(home.notes.get(homeNote()), /the gig is friday[\s\S]*load-in is at 6/, "every turn is on the page");
    const record = await recordOf(store);
    assert.equal(record.onPage, ON_PAGE);
    assert.equal(record.turns, undefined, "and the record keeps none");
  });
});

test("once the page is the copy, a turn whose home could not be opened keeps nothing in a second place", async () => {
  const store = createMemoryStore();
  const home = folder();
  await quiet(async () => {
    await keepGroupExchange(store, withHome(home), await readGroupMemory(store, withHome(home), folder().dispatch), "the gig is friday", "Noted: Friday.");
    assert.equal((await recordOf(store)).onPage, ON_PAGE);
    const homeless = { ...GROUP, home: null };
    assert.deepEqual(await readGroupMemory(store, homeless, folder().dispatch), []);
    await keepGroupExchange(store, homeless, [], "load-in is at 6", "Load-in at 6.");
    assert.equal((await recordOf(store)).turns, undefined, "the record never takes turns again");
    assert.doesNotMatch(said(await readGroupMemory(store, withHome(home), folder().dispatch)), /load-in/);
  });
});

test("a page that will not take the move leaves the record holding the turns for the next turn", async () => {
  const store = createMemoryStore();
  await quiet(async () => {
    await keepGroupExchange(store, { ...GROUP }, [], "the gig is friday", "Noted: Friday.");
    const refusing = folder({}, { refuse: "permission denied" });
    assert.match(said(await readGroupMemory(store, withHome(refusing), folder().dispatch)), /the gig is friday/);
    const record = await recordOf(store);
    assert.notEqual(record.onPage, ON_PAGE);
    assert.equal(record.turns.length, 2, "nothing dropped");
    const home = folder();
    await readGroupMemory(store, withHome(home), folder().dispatch);
    assert.match(home.notes.get(homeNote()), /the gig is friday/, "the next turn moves them");
    assert.equal((await recordOf(store)).turns, undefined);
  });
});

test("an old note's words are carried in once, onto the page, and the old note is never read again", async () => {
  const store = createMemoryStore();
  const bound = folder({ [boundNote()]: renderGroupNote(OLD) });
  const home = folder();
  await quiet(async () => {
    assert.match(said(await readGroupMemory(store, withHome(home), bound.dispatch)), /the gig is friday/, "carried on the first turn");
    assert.match(home.notes.get(homeNote()), /the gig is friday/, "onto the page");
    const record = await recordOf(store);
    assert.equal(record.carried, 1);
    assert.deepEqual(record.carriedFrom, [{ where: "default", path: boundNote() }], "where it came from, for the sweep that trashes it");
    // Somebody edits the old note afterwards: it is no longer the chat's memory, and is not read again.
    bound.edit(boundNote(), renderGroupNote([{ role: "user", text: "@bo: the gig is sunday" }, { role: "assistant", text: "Sunday." }]));
    const reads = bound.calls.length;
    const later = await readGroupMemory(store, withHome(home), bound.dispatch);
    assert.match(said(later), /the gig is friday/);
    assert.doesNotMatch(said(later), /sunday/);
    const memoryReads = bound.calls.slice(reads).filter((call) => /\/chat-[0-9a-f]{12}\.md$/.test(call.args.path ?? ""));
    assert.deepEqual(memoryReads, [], "no old note in a workspace folder is read once carried");
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
