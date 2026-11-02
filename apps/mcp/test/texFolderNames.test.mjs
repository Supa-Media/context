/**
 * A PERSON'S TEX FOLDER AND A CHAT'S HOME USE THE SAME NAMES (the owner, 2026-11-01: "i would like them to mirror";
 * `docs/decisions/texting-assistant/tex-folders.md`).
 *
 * `tex/about.md`, and in a home `about.md`, `voice.md` and `history.md`. Until the rename has run everywhere
 * (`apps/convex/functions/texFolderNames.ts`), a note found only under its old name is read there and written
 * there, so no turn starts a second copy beside it.
 *
 * Sabotage record (2026-11-01), each fails a test here:
 *  - `readAboutMe` without its fallback: "a person's note still under its old name is read";
 *  - `learnDirect` ignoring old names: "a page still under its old name keeps its key, and is written there";
 *  - `keepGroupExchange` writing the page under the new name regardless: "the next exchange goes onto the old page".
 */
import assert from "node:assert/strict";
import { test } from "node:test";

import { OLD_ABOUT_ME_PATH, ABOUT_ME_PATH, readAboutMe } from "../src/agent/aboutMe.js";
import { HOME_NOTES, homeNamesOf, homeNotePaths, oldHomeNotePaths, readEitherName } from "../src/agent/homeNames.js";
import { learnDirect } from "../src/agent/groupDirectNotes.js";
import { groupMemoryPath, keepGroupExchange, readGroupMemory } from "../src/agent/groupTurn.js";
import { ON_PAGE } from "../src/agent/groupMemoryCarry.js";
import { renderGroupNote } from "../src/agent/groupMemoryNote.js";
import { createMemoryStore } from "./gmailSync/fixtures.mjs";

const KEY = "a".repeat(64);
const HOME = "tex/groups/orbit-lamp-river";
const PAGE_ID = "01900000-0000-7000-8000-000000000001";
const OWN = `tex/chat:${KEY}/notes/${PAGE_ID}.md`;

const quiet = async (run) => {
  const original = console.log;
  console.log = () => {};
  try {
    return await run();
  } finally {
    console.log = original;
  }
};

/** A note tool over `notes` (path to text), counting writes by path. */
function notesTool(notes) {
  const writes = [];
  const dispatch = async (name, args) => {
    if (name === "read_note" && notes.has(args.path)) return { content: [{ type: "text", text: `etag: v1\n\n${notes.get(args.path)}` }] };
    if (name === "write_note") {
      writes.push(args.path);
      notes.set(args.path, args.content);
      return { content: [{ type: "text", text: `Wrote ${args.path}` }] };
    }
    return { isError: true, content: [{ type: "text", text: "not found" }] };
  };
  return { dispatch, writes };
}

test("both homes say the same names", () => {
  assert.equal(ABOUT_ME_PATH, "tex/about.md");
  assert.deepEqual(HOME_NOTES, { memory: "history.md", voice: "voice.md", about: "about.md" });
  assert.deepEqual(homeNotePaths(HOME), { memory: `${HOME}/history.md`, voice: `${HOME}/voice.md`, about: `${HOME}/about.md` });
  assert.deepEqual(oldHomeNotePaths(HOME, "0123456789abcdef"), { memory: `${HOME}/chat-0123456789ab.md`, voice: `${HOME}/voice-0123456789ab.md`, about: `${HOME}/about-us.md` });
});

test("a person's note still under its old name is read, and the new name wins once it holds one", async () => {
  const notes = new Map([[OLD_ABOUT_ME_PATH, "- Has a dog called Pip."]]);
  assert.equal(await readAboutMe(notesTool(notes).dispatch), "- Has a dog called Pip.");
  notes.set(ABOUT_ME_PATH, "- Moved to Lisbon.");
  assert.equal(await readAboutMe(notesTool(notes).dispatch), "- Moved to Lisbon.");
});

test("an unreadable new name is never read past to the old one", async () => {
  const read = async (path) => (path === "new.md" ? null : { body: "old words" });
  assert.deepEqual(await readEitherName(read, "new.md", "old.md"), { seen: null, path: "new.md" });
  const missing = async (path) => (path === "new.md" ? { missing: true } : { body: "old words" });
  assert.deepEqual(await readEitherName(missing, "new.md", "old.md"), { seen: { body: "old words" }, path: "old.md" });
});

test("a page still under its old name keeps its key, and is written there", async () => {
  const old = oldHomeNotePaths(HOME, KEY);
  const paths = homeNotePaths(HOME);
  const keys = { [paths.memory]: false, [old.memory]: OWN, [paths.voice]: false, [old.voice]: false, [paths.about]: false, [old.about]: false };
  const group = { key: KEY, home: { folder: HOME, store: { keysAt: async () => keys } } };
  const direct = await learnDirect(group, paths, old);
  assert.deepEqual(direct, { memory: OWN, voice: false, about: false, old: ["memory"] });
  assert.equal(homeNamesOf(group, KEY, { direct }).live.memory, old.memory, "the next turn names the page by its old name");
  // Renamed: the same key under the new name, nothing named old.
  const renamed = { ...keys, [paths.memory]: OWN, [old.memory]: false };
  assert.deepEqual(await learnDirect(group, paths, old), { memory: OWN, voice: false, about: false, old: ["memory"] });
  group.home.store.keysAt = async () => renamed;
  assert.deepEqual(await learnDirect(group, paths, old), { memory: OWN, voice: false, about: false, old: [] });
});

test("the next exchange goes onto the old page, never a second one beside it", async () => {
  const old = oldHomeNotePaths(HOME, await sha256(KEY));
  const notes = new Map([[old.memory, renderGroupNote([{ role: "user", text: "@ada: the gig is friday" }, { role: "assistant", text: "Noted." }])]]);
  const tool = notesTool(notes);
  const store = createMemoryStore();
  // The chat's object, answering keys for the paths the tool holds, as `store.keysAt` does (`idLayout.js`).
  const ids = new Map();
  const keyOf = (path) => {
    if (!ids.has(path)) ids.set(path, `tex/chat:${KEY}/notes/01900000-0000-7000-8000-00000000000${ids.size + 1}.md`);
    return ids.get(path);
  };
  const object = {
    keysAt: async (paths) => Object.fromEntries(paths.map((path) => [path, notes.has(path) ? keyOf(path) : false])),
    get: async (key) => {
      const path = [...ids].find(([, id]) => id === key)?.[0];
      return path && notes.has(path) ? { etag: "v1", text: async () => notes.get(path) } : null;
    },
  };
  const home = () => ({ folder: HOME, dispatch: tool.dispatch, store: object });
  await quiet(async () => {
    const group = { key: KEY, members: "b".repeat(64), from: "ada", chat: [], people: [], home: home() };
    // A chat whose page is its one copy, under the page's old name, with no keys kept yet.
    await store.put(await groupMemoryPath(group), JSON.stringify({ version: 1, onPage: ON_PAGE, carried: 1 }));
    const history = await readGroupMemory(store, group, null);
    assert.match(JSON.stringify(history), /the gig is friday/, "read under its old name");
    await keepGroupExchange(store, group, history, "and saturday?", "Free.");
    const again = { key: KEY, members: "b".repeat(64), from: "ada", chat: [], people: [], home: home() };
    assert.match(JSON.stringify(await readGroupMemory(store, again, null)), /the gig is friday[\s\S]*and saturday/);
  });
  assert.equal(notes.has(`${HOME}/history.md`), false, "no second page");
  assert.deepEqual(tool.writes, [old.memory], "the exchange was written, onto the old page");
});

async function sha256(text) {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text));
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

test("a page write the home refuses leaves its code on the record, and the history in it", async () => {
  const store = createMemoryStore();
  const refusing = async (name) =>
    name === "write_note" ? { isError: true, content: [{ type: "text", text: "permission denied: not yours" }] } : { isError: true, content: [{ type: "text", text: "not found" }] };
  const group = { key: KEY, members: "b".repeat(64), from: "ada", chat: [], people: [], home: { folder: HOME, dispatch: refusing } };
  const path = await groupMemoryPath(group);
  await store.put(path, JSON.stringify({ version: 1, carried: 1, turns: [{ role: "user", text: "@ada: hi" }, { role: "assistant", text: "Hello." }] }));
  await quiet(() => readGroupMemory(store, group, refusing));
  const record = JSON.parse(await (await store.get(path)).text());
  assert.equal(record.pageRefused, "permission_denied");
  assert.equal(record.turns.length, 2, "the history stays where it was");
  assert.equal(record.onPage, undefined);
  // Once the page takes it, the mark goes.
  const notes = new Map();
  const tool = notesTool(notes);
  await quiet(() => readGroupMemory(store, { ...group, home: { folder: HOME, dispatch: tool.dispatch } }, tool.dispatch));
  const moved = JSON.parse(await (await store.get(path)).text());
  assert.equal(moved.onPage, ON_PAGE);
  assert.equal(moved.pageRefused, undefined);
});
