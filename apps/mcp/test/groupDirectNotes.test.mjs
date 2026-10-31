/**
 * A CHAT HOME'S OWN NOTES ARE READ STRAIGHT FROM THE CHAT'S DURABLE OBJECT (Dev2, 2026-10-31: "let's skip those
 * steps"; `src/agent/groupDirectNotes.js`).
 *
 * Once a kept exchange has noted the keys of the home's memory, voice and about-us notes, the next turn asks the
 * chat's object for them by key, never the note-reading tool, and the memory note only for its version. Anything that
 * does not match is read the old way.
 *
 * Sabotage record (2026-10-31), each fails a test here:
 *  - `memoryUnedited` answering true without comparing the version: "a memory note somebody edited is read";
 *  - `ownKey` accepting any key: "a key outside this chat's own object is never read directly";
 *  - `readGroupMemory` ignoring the kept keys: "with the keys kept, the turn reads no note through the tool".
 */
import assert from "node:assert/strict";
import { test } from "node:test";

import { readGroupMemory } from "../src/agent/groupTurn.js";
import { learnDirect } from "../src/agent/groupDirectNotes.js";
import { withIdLayout } from "../src/store/idLayout.js";

const KEY = "a".repeat(64);
const HOME = "tex/groups/orbit-lamp-river";
const ID = { m1: "01900000-0000-7000-8000-000000000001", v1: "01900000-0000-7000-8000-000000000002", a1: "01900000-0000-7000-8000-000000000003" };
const OWN = (id) => `tex/chat:${KEY}/notes/${ID[id]}.md`;
const TURNS = [
  { role: "user", text: "@seyi: what's for lunch" },
  { role: "assistant", text: "Tacos." },
];

/** A chat's object: keys to `{etag, text}`. */
function object(entries) {
  const gets = [];
  return {
    gets,
    async head(key) {
      gets.push(key);
      return entries[key] ? { etag: entries[key].etag } : null;
    },
    async get(key) {
      gets.push(key);
      const entry = entries[key];
      return entry ? { etag: entry.etag, text: async () => entry.text } : null;
    },
  };
}

function setup({ direct, objectEntries, noteEtag = "tool-etag-1" }) {
  const reads = [];
  const dispatch = async (name, args) => {
    reads.push(args?.path);
    return { isError: true, content: [{ type: "text", text: "not found" }] };
  };
  const record = JSON.stringify({ version: 1, turns: TURNS, noteEtag, direct });
  const store = { get: async () => ({ text: async () => record }) };
  const homeStore = object(objectEntries);
  const group = { key: KEY, members: "b".repeat(64), from: "seyi", chat: [], people: [], home: { folder: HOME, dispatch, store: homeStore } };
  return { group, store, reads, homeStore, dispatch };
}

const KEPT = { memory: { key: OWN("m1"), version: "v-memory" }, voice: OWN("v1"), about: OWN("a1") };
const ENTRIES = {
  [OWN("m1")]: { etag: "v-memory", text: "# Chat memory\n" },
  [OWN("v1")]: { etag: "v-voice", text: "- dry humor\n- lowercase" },
  [OWN("a1")]: { etag: "v-about", text: "We plan the studio's launches." },
};

test("with the keys kept, the turn reads no note through the tool, and the record's turns stand", async () => {
  const { group, store, reads, homeStore, dispatch } = setup({ direct: KEPT, objectEntries: ENTRIES });
  const history = await readGroupMemory(store, group, dispatch);
  assert.deepEqual(history.map((turn) => turn.text), TURNS.map((turn) => turn.text));
  assert.equal(group.voice, "- dry humor\n- lowercase");
  assert.equal(group.aboutUs, "We plan the studio's launches.");
  assert.deepEqual(reads.filter((path) => typeof path === "string" && path.startsWith(HOME)), [], "nothing in the home is read through the tool");
  assert.ok(homeStore.gets.includes(OWN("m1")), "the memory note's version is asked of the object");
});

test("a memory note somebody edited is read the old way", async () => {
  const { group, store, reads, dispatch } = setup({ direct: KEPT, objectEntries: { ...ENTRIES, [OWN("m1")]: { etag: "v-edited", text: "x" } } });
  await readGroupMemory(store, group, dispatch);
  assert.ok(reads.some((path) => typeof path === "string" && path.startsWith(`${HOME}/`) && !/voice-|about-us/.test(path)), "the memory note is read through the tool");
});

test("a key outside this chat's own object is never read directly", async () => {
  const other = `tex/chat:${"c".repeat(64)}/notes/${ID.v1}.md`;
  const { group, store, reads, homeStore, dispatch } = setup({ direct: { ...KEPT, voice: other }, objectEntries: { ...ENTRIES, [other]: { etag: "x", text: "- not ours" } } });
  await readGroupMemory(store, group, dispatch);
  assert.ok(!homeStore.gets.includes(other), "the other chat's key is not asked for");
  assert.notEqual(group.voice, "- not ours");
  assert.ok(reads.some((path) => /voice-/.test(path ?? "")), "the voice note is read the old way");
});

test("no kept keys: every note is read the old way", async () => {
  const { group, store, reads, homeStore, dispatch } = setup({ direct: undefined, objectEntries: ENTRIES });
  await readGroupMemory(store, group, dispatch);
  assert.deepEqual(homeStore.gets, []);
  assert.ok(reads.some((path) => /about-us/.test(path ?? "")));
});

test("after an exchange, the three keys are learned in one lookup, with the memory note's object version", async () => {
  const lookups = [];
  const homeStore = {
    ...object(ENTRIES),
    async keysAt(paths) {
      lookups.push(paths);
      return { [`${HOME}/memory.md`]: OWN("m1"), [`${HOME}/voice.md`]: OWN("v1"), [`${HOME}/about-us.md`]: `tex/chat:${"c".repeat(64)}/notes/${ID.a1}.md` };
    },
  };
  const group = { key: KEY, home: { folder: HOME, store: homeStore } };
  const direct = await learnDirect(group, { memory: `${HOME}/memory.md`, voice: `${HOME}/voice.md`, about: `${HOME}/about-us.md` });
  assert.equal(lookups.length, 1);
  assert.deepEqual(direct, { memory: { key: OWN("m1"), version: "v-memory" }, voice: OWN("v1") }, "another chat's key is not kept");
});

test("the id layer names the keys of keyed notes at several paths in one lookup", async () => {
  const asked = [];
  const lookup = async (paths) => {
    asked.push(paths);
    return { keyed: true, notes: { "a.md": { state: "keyed", key: "notes/01900000-0000-7000-8000-00000000000a.md", etag: "e1" }, "b.md": { state: "gone" } } };
  };
  const store = withIdLayout({ get: async () => null, put: async () => null, delete: async () => {}, list: async () => ({ objects: [] }) }, { lookup, wrote: async () => {}, adopt: async () => {}, removed: async () => {} });
  const keys = await store.keysAt(["a.md", "b.md", ".context/x.json"]);
  assert.deepEqual(asked, [["a.md", "b.md"]], "one lookup, plumbing never asked");
  assert.deepEqual(Object.keys(keys), ["a.md"]);
});
