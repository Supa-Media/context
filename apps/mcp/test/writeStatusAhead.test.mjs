/**
 * A save's status advice (`src/tools/notes/statusList.js` `statusListAhead`, `src/tools/notes/write.js`): the folder's
 * status list is asked while the note is being stored, not after, and the advice is the line it was.
 *
 * Until 2026-11-28 the list was read once the note was stored, one more trip to the workspace object in line behind
 * the save (obj:ws.facts p50 94 ms, 1.8 calls each, on 197 of 498 writes in a day). It reads only the governing
 * folder's front notes, never the note being written, so asking it first answers what asking after did.
 *
 * Sabotage record (temporary local edits, reverted; each one fails the named test):
 *   `statusListAhead` no longer called from write.js         -> "the folder's list is asked before the save ..." fails
 *   the list asked ahead but not handed to `statusAdvice`     -> the same test fails (the list is asked twice)
 *   `statusListAhead` asking whatever the text says           -> "a save naming no status asks for no list" fails
 */
import assert from "node:assert/strict";
import { test } from "node:test";

import { toolWriteNote } from "../src/tools/notes/write.js";
import { statusAdvice } from "../src/tools/notes/statusList.js";
import { withPrivacyAuthority } from "../src/store/privacyAuthority.js";
import { PrivacyOverrides } from "../src/privacy/engine.js";
import { createMemoryStore } from "./gmailSync/fixtures.mjs";
import { withServedTree } from "./servedTree.mjs";

const FOLDER = { prefix: "projects", visibility: "team" };
const FOLDER_RULE = { prefix: "projects", vis: "team" };
const FRONT = "projects/overview.md";

/** A store whose puts of `slowPath` take a while, recording when the status list is asked and when that put ends. */
async function harness(slowPath) {
  const store = withPrivacyAuthority(withServedTree(createMemoryStore()), {
    rules: { etag: "rows-v1", accessVersion: 1, folders: [FOLDER], notes: [] },
    async setAccess(change) {
      return { ok: true, version: (change.expectedVersion ?? 1) + 1 };
    },
  });
  await store.put(FRONT, "---\nstatuses-not-started: [exploration]\nstatuses-done: [won, lost]\n---\n# Projects\n");
  const events = [];
  const facts = store.treeFacts;
  store.treeFacts = async (ask) => {
    if (ask?.ask === "props") events.push("list asked");
    return facts(ask);
  };
  const put = store.put.bind(store);
  store.put = async (key, ...rest) => {
    if (key !== slowPath) return put(key, ...rest);
    await new Promise((resolve) => setTimeout(resolve, 20));
    const stored = await put(key, ...rest);
    events.push("note stored");
    return stored;
  };
  return { store, events, overrides: new PrivacyOverrides() };
}

const write = (store, overrides, path, content) => toolWriteNote(store, "private", [FOLDER_RULE], overrides, { path, content });
const textOf = (result) => result.content.map((part) => part.text).join("\n");
const adviceLine = (text) => text.split("\n").find((line) => line.startsWith("status: ")) ?? null;

test("the folder's list is asked before the save has finished, and the advice is the line it was", async () => {
  const path = "projects/web.md";
  const content = "---\nstatus: someday\n---\n# Web\n";
  const { store, events, overrides } = await harness(path);
  const result = await write(store, overrides, path, content);
  assert.equal(result.isError, undefined, textOf(result));
  assert.deepEqual(events.filter((event) => event === "list asked" || event === "note stored"), ["list asked", "note stored"], "asked once, ahead of the stored note");
  const said = adviceLine(textOf(result));
  assert.match(said ?? "", /"someday" is not one of the statuses for projects\//);
  // The line the advice gives on its own, after the save, as the write gave it before.
  assert.equal(said, await statusAdvice(store, "private", [FOLDER_RULE], overrides, path, content));
});

test("a save naming no status asks for no list and says nothing", async () => {
  const path = "projects/plain.md";
  const { store, events, overrides } = await harness(path);
  const result = await write(store, overrides, path, "# Plain\n\nno status here\n");
  assert.equal(result.isError, undefined, textOf(result));
  assert.equal(events.includes("list asked"), false);
  assert.equal(adviceLine(textOf(result)), null);
});

test("a declared status says nothing, and a front note is read against its parent's list", async () => {
  const { store, overrides } = await harness("projects/won.md");
  assert.equal(adviceLine(textOf(await write(store, overrides, "projects/won.md", "---\nstatus: won\n---\n# Won\n"))), null);
  const front = textOf(await write(store, overrides, "projects/web/overview.md", "---\nstatus: won\n---\n# Web\n"));
  assert.equal(adviceLine(front), null, "projects/ declares won");
});
