/**
 * Editing history filed by note id (decided by the owner, 2026-10-25: moving
 * a folder "should be one row change"; `notes-by-id.md`). In a keyed store a
 * note's head lives under its id, so a move of the note or of any folder above
 * it carries nothing, and the history is found at whatever name the note has.
 *
 * Sabotage, each confirmed to fail a case here:
 *  - file heads by path again (`headAddress` ignores the id) and the move cases lose the document;
 *  - drop `adoptPathHead` from `readHead` and the path-head case starts a new document after a move;
 *  - take a path head made for another id and the "another note's head" case opens the wrong document;
 *  - drop the same-head guard in `renameDocument` and the stale-name case fences the note's own head;
 *  - skip the id head in `eraseDocument` and the erase case leaves the state behind;
 *  - stop fencing a filed path head and the backfill reruns file it twice.
 */
import assert from "node:assert/strict";
import test from "node:test";
import {
  commitUpdate,
  eraseDocument,
  fileHeadsByNote,
  noteOfDocument,
  readDocument,
  renameDocument,
} from "../src/index.js";
import { KeyedStore, editOf, editedNote } from "./keyedStore.helpers.mjs";

const ID_A = "0190a000-0000-7000-8000-0000000000a1";
const ID_B = "0190a000-0000-7000-8000-0000000000b2";

function moveRow(store, from, to) {
  const noteId = store.noteIds.get(from);
  store.moveRow(from, to);
  store.noteIds.delete(from);
  if (noteId !== undefined) store.noteIds.set(to, noteId);
}

test("a keyed note's head is filed under its id, and the document records its note", async () => {
  const store = new KeyedStore();
  store.noteIds.set("a.md", ID_A);
  const { documentId } = await editedNote(store, "a.md", "# Plan\n\nOne.\n");

  assert.equal(store.noteHead(ID_A).documentId, documentId);
  assert.equal(
    [...store.objects.keys()].filter((key) => key.startsWith(".context/collaboration/v1/heads/") && !key.includes("/heads/notes/")).length,
    0,
    "no head is filed by path",
  );
  assert.equal(await noteOfDocument(store, documentId), ID_A);
});

test("moving a folder of collaborative notes writes no collaboration record, and every history follows", async () => {
  const store = new KeyedStore();
  const notes = [];
  for (let index = 0; index < 5; index += 1) {
    const path = `project/n${index}.md`;
    store.noteIds.set(path, `0190a000-0000-7000-8000-00000000010${index}`);
    notes.push({ path, ...(await editedNote(store, path, `# N${index}\n\nEdited.\n`)) });
  }
  const before = store.putCount;
  for (const note of notes) moveRow(store, note.path, note.path.replace("project/", "archive/project/"));
  assert.equal(store.putCount, before, "a move is the rows' change alone");

  for (const note of notes) {
    const moved = note.path.replace("project/", "archive/project/");
    const current = await readDocument(store, moved);
    assert.equal(current.documentId, note.documentId);
    assert.equal(current.text, note.text);
    const next = await commitUpdate(store, moved, { documentId: note.documentId, update: editOf(current.update, `${note.text}More.\n`) });
    assert.equal(next.documentId, note.documentId, "an edit at the new name extends the same history");
  }
});

test("a path head is filed under the note's id on its first read, and then survives a move with no rename", async () => {
  const store = new KeyedStore();
  const { documentId, text } = await editedNote(store, "old.md", "# Plan\n\nLegacy.\n");
  store.noteIds.set("old.md", ID_A);
  assert.equal(store.noteHead(ID_A), null);

  assert.equal((await readDocument(store, "old.md")).documentId, documentId);
  assert.equal(store.noteHead(ID_A).documentId, documentId, "filed by id");
  assert.equal(await noteOfDocument(store, documentId), ID_A);

  moveRow(store, "old.md", "new/place.md");
  const after = await readDocument(store, "new/place.md");
  assert.equal(after.documentId, documentId);
  assert.equal(after.text, text);
});

test("a path head made for another note is not filed under this note's id", async () => {
  const store = new KeyedStore();
  store.noteIds.set("x.md", ID_A);
  const first = await editedNote(store, "x.md", "# A\n\nMine.\n");
  // Rewrite A's head as if it had been filed at the path before the change, then a new note B takes the name.
  const filed = store.objects.get(`.context/collaboration/v1/heads/notes/${ID_A}.json`);
  store.objects.delete(`.context/collaboration/v1/heads/notes/${ID_A}.json`);
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode("x.md"));
  const hash = [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
  store.objects.set(`.context/collaboration/v1/heads/${hash}.json`, filed);
  store.moveRow("x.md", ".context/trash/t/x.md");
  store.noteIds.delete("x.md");
  store.seedNote("x.md", "# B\n");
  store.noteIds.set("x.md", ID_B);

  const opened = await readDocument(store, "x.md");
  assert.notEqual(opened.documentId, first.documentId);
  assert.equal(opened.text, "# B\n");
  assert.equal(store.noteHead(ID_B).documentId, opened.documentId);
});

test("a rename whose two names file to one head is a no-op, and never fences the note", async () => {
  const store = new KeyedStore();
  store.noteIds.set("from.md", ID_A);
  const { documentId } = await editedNote(store, "from.md", "# Plan\n\nStale.\n");
  // The note moved; a caller still holding the old name's id asks for the carry.
  store.moveRow("from.md", "to.md");
  store.noteIds.set("to.md", ID_A);
  const writes = store.putCount;

  assert.deepEqual(await renameDocument(store, "from.md", "to.md"), { renamed: false, reason: "already" });
  assert.equal(store.putCount, writes);
  assert.equal(store.noteHead(ID_A).status, "active");
  assert.equal((await readDocument(store, "to.md")).documentId, documentId);
});

test("erasing a trashed note by its id removes the head filed by id and the document's history", async () => {
  const store = new KeyedStore();
  store.noteIds.set("gone.md", ID_A);
  const { documentId } = await editedNote(store, "gone.md", "# Plan\n\nSecret.\n");
  store.moveRow("gone.md", ".context/trash/t/gone.md");
  store.noteIds.delete("gone.md");

  const erased = await eraseDocument(store, ".context/trash/t/gone.md", { noteId: ID_A });

  assert.equal(erased.erased, true);
  assert.equal(erased.documentId, documentId);
  assert.equal(store.noteHead(ID_A), null);
  const left = [...store.objects.keys()].filter((key) => key.includes(documentId));
  assert.deepEqual(left, [], "no state, revision or note record of the document is left");
});

test("the backfill files every path head by note id, once, and a later move carries nothing", async () => {
  const store = new KeyedStore();
  // One head that records its id, one made before heads did, one that moved away, one with no row.
  store.noteIds.set("stamped.md", ID_A);
  const stamped = await editedNote(store, "stamped.md", "# S\n\nStamped.\n");
  const stampedHead = store.objects.get(`.context/collaboration/v1/heads/notes/${ID_A}.json`);
  store.objects.delete(`.context/collaboration/v1/heads/notes/${ID_A}.json`);
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode("stamped.md"));
  const hash = [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
  store.objects.set(`.context/collaboration/v1/heads/${hash}.json`, stampedHead);
  const plain = await editedNote(store, "plain.md", "# P\n\nPlain.\n");
  await editedNote(store, "orphan.md", "# O\n\nNo row.\n");
  store.noteIds.set("plain.md", ID_B);

  const first = await fileHeadsByNote(store, { limit: 10 });
  assert.equal(first.done, true);
  assert.equal(first.filed, 2);
  assert.equal(first.left, 1, "a head whose name has no row is left");
  assert.equal(store.noteHead(ID_A).documentId, stamped.documentId);
  assert.equal(store.noteHead(ID_B).documentId, plain.documentId);

  const again = await fileHeadsByNote(store, { limit: 10 });
  assert.equal(again.filed, 0, "a second run files nothing");

  const writes = store.putCount;
  moveRow(store, "stamped.md", "moved/stamped.md");
  moveRow(store, "plain.md", "moved/plain.md");
  assert.equal(store.putCount, writes);
  assert.equal((await readDocument(store, "moved/stamped.md")).documentId, stamped.documentId);
  assert.equal((await readDocument(store, "moved/plain.md")).documentId, plain.documentId);
});

test("the backfill pages through a listing", async () => {
  const store = new KeyedStore();
  for (let index = 0; index < 3; index += 1) await editedNote(store, `p${index}.md`, `# P${index}\n\nX.\n`);
  for (let index = 0; index < 3; index += 1) store.noteIds.set(`p${index}.md`, `0190a000-0000-7000-8000-00000000020${index}`);
  const list = store.list.bind(store);
  store.list = async ({ prefix, cursor, limit }) => {
    const all = (await list({ prefix })).objects.sort((a, b) => a.key.localeCompare(b.key));
    const start = cursor ? Number(cursor) : 0;
    const objects = all.slice(start, start + limit);
    const next = start + limit;
    return { objects, truncated: next < all.length, cursor: next < all.length ? String(next) : undefined };
  };
  let cursor;
  let filed = 0;
  for (let pages = 0; pages < 10; pages += 1) {
    const page = await fileHeadsByNote(store, { cursor, limit: 1 });
    filed += page.filed;
    if (page.done) break;
    cursor = page.cursor;
  }
  assert.equal(filed, 3);
});
