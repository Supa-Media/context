/**
 * A keyed rename (`docs/decisions/storage-and-credentials/notes-by-id.md`):
 * the control plane has moved the note's row, the bytes stay at their id key,
 * and the collaboration heads and state follow the name without touching a byte.
 *
 * Sabotage, each confirmed to fail a case here:
 *  - rewrite the Markdown at the new name (a copy) and the "no note bytes" case fails;
 *  - skip the old head's `moved` fence and the old-identity commit is not forwarded;
 *  - drop the destination-owner check and the occupied-name case renames over another document;
 *  - leave the journal out and the interrupted-rename case cannot resume from the next read.
 */
import assert from "node:assert/strict";
import test from "node:test";
import * as Y from "yjs";
import {
  CollaborationError,
  commitUpdate,
  readDocument,
  renameDocument,
} from "../src/index.js";

/** A path-addressed store whose notes live at id keys, as a keyed workspace's do. */
class KeyedStore {
  constructor() {
    this.capabilities = { conditionalWrite: true, conditionalCreate: true, conditionalDelete: true };
    this.objects = new Map();
    this.rows = new Map();
    this.sequence = 0;
    this.putCount = 0;
    this.failAt = new Set();
    this.noteTouches = [];
    this.noteIds = new Map();
  }

  /** The note id of the live row at `path`, as the gateway's keyed store answers it. */
  async noteIdAt(path) {
    return this.noteIds.get(path) ?? null;
  }

  async get(key) {
    const physical = this.physical(key);
    if (physical === null) return null;
    const object = this.objects.get(physical);
    if (!object) return null;
    if (!key.startsWith(".context/")) this.noteTouches.push(["get", physical]);
    return { etag: object.etag, text: async () => object.text };
  }

  physical(key) {
    if (key.startsWith(".context/")) return key;
    return this.rows.get(key) ?? null;
  }

  async put(key, value, options = {}) {
    if (this.beforePut) this.beforePut(key, value);
    this.putCount += 1;
    if (this.failAt.has(this.putCount)) throw new Error(`injected put failure ${this.putCount}`);
    let physical = this.physical(key);
    if (physical === null && !key.startsWith(".context/")) {
      physical = `notes/${++this.sequence}.md`;
      this.rows.set(key, physical);
    }
    if (!key.startsWith(".context/")) this.noteTouches.push(["put", physical]);
    const expected = options.onlyIf?.etagMatches;
    const absent = options.onlyIf?.absent;
    const current = this.objects.get(physical);
    if (expected !== undefined && (!current || current.etag !== expected)) return null;
    if (absent && current) return null;
    const text = typeof value === "string" ? value : new TextDecoder().decode(value);
    const etag = `e${++this.sequence}`;
    this.objects.set(physical, { etag, text });
    return { etag };
  }

  async delete(key, options = {}) {
    const physical = this.physical(key);
    const current = physical === null ? undefined : this.objects.get(physical);
    if (!current) return;
    if (options.onlyIf?.etagMatches !== undefined && current.etag !== options.onlyIf.etagMatches) return null;
    this.putCount += 1;
    this.objects.delete(physical);
  }

  async list({ prefix = "" } = {}) {
    return {
      objects: [...this.objects.entries()]
        .filter(([key]) => key.startsWith(prefix))
        .map(([key, object]) => ({ key, etag: object.etag })),
      truncated: false,
    };
  }

  /** A note the person already has, at `path`, with its bytes at an id key. */
  seedNote(path, text) {
    const physical = `notes/${++this.sequence}.md`;
    this.rows.set(path, physical);
    this.objects.set(physical, { etag: `e${++this.sequence}`, text });
  }

  /** The control plane moves the row; the bytes do not move. */
  moveRow(from, to) {
    this.rows.set(to, this.rows.get(from));
    this.rows.delete(from);
  }

  /** The collaboration head recorded at `path`, read from the bucket's own objects. */
  headAt(path) {
    for (const [key, object] of this.objects) {
      if (!key.startsWith(".context/collaboration/v1/heads/")) continue;
      const head = JSON.parse(object.text);
      if (head.path === path) return head;
    }
    return null;
  }
}

/**
 * One Yjs update that replaces the note's text, computed against `snapshot`
 * (the state the editor holds), as the editor's own document would send it.
 */
function editOf(snapshot, text) {
  const base = new Y.Doc({ gc: false });
  Y.applyUpdate(base, Buffer.from(snapshot, "base64"));
  const since = Y.encodeStateVector(base);
  const doc = new Y.Doc({ gc: false });
  Y.applyUpdate(doc, Y.encodeStateAsUpdate(base));
  const note = doc.getText("note");
  note.delete(0, note.length);
  note.insert(0, text);
  return Buffer.from(Y.encodeStateAsUpdate(doc, since)).toString("base64");
}

/** A note with real history: a document opened and then edited once. */
async function editedNote(store, path, text) {
  store.seedNote(path, "# Plan\n\nBody.\n");
  const opened = await readDocument(store, path);
  const next = await commitUpdate(store, path, {
    documentId: opened.documentId,
    update: editOf(opened.update, text),
  });
  return { documentId: opened.documentId, text: next.text };
}

test("a keyed rename carries the document's identity and touches no note bytes", async () => {
  const store = new KeyedStore();
  const { documentId, text } = await editedNote(store, "from.md", "# Plan\n\nRevised.\n");
  store.moveRow("from.md", "to.md");
  store.noteTouches.length = 0;

  const renamed = await renameDocument(store, "from.md", "to.md");

  assert.equal(renamed.renamed, true);
  assert.equal(renamed.documentId, documentId);
  assert.deepEqual(store.noteTouches, [], "a rename must not read or write any note's Markdown");
  const after = await readDocument(store, "to.md");
  assert.equal(after.documentId, documentId);
  assert.equal(after.text, text);
});

test("the old path's identity is fenced: an offline commit under it is forwarded to the new name", async () => {
  const store = new KeyedStore();
  const { documentId } = await editedNote(store, "from.md", "# Plan\n\nOne.\n");
  const stale = await readDocument(store, "from.md");
  store.moveRow("from.md", "to.md");
  await renameDocument(store, "from.md", "to.md");

  await assert.rejects(
    () => commitUpdate(store, "from.md", { documentId, update: stale.update }),
    (error) => error instanceof CollaborationError && error.code === "MOVED" && error.destination === "to.md",
  );
  await assert.rejects(() => readDocument(store, "from.md"), (error) => error.code === "MOVED" && error.destination === "to.md");
});

test("an edit at the new name extends the same history", async () => {
  const store = new KeyedStore();
  const { documentId } = await editedNote(store, "from.md", "# Plan\n\nOne.\n");
  store.moveRow("from.md", "to.md");
  await renameDocument(store, "from.md", "to.md");

  const current = await readDocument(store, "to.md");
  const next = await commitUpdate(store, "to.md", {
    documentId,
    update: editOf(current.update, "# Plan\n\nTwo.\n"),
  });

  assert.equal(next.documentId, documentId);
  assert.equal(next.text, "# Plan\n\nTwo.\n");
});

test("a state write that lands while the rename freezes it is not overwritten, and the rename still completes", async () => {
  const store = new KeyedStore();
  const { documentId } = await editedNote(store, "from.md", "# Plan\n\nRace.\n");
  store.moveRow("from.md", "to.md");
  const stateKey = `.context/collaboration/v1/documents/${documentId}.json`;
  let raced = false;
  store.beforePut = (key, value) => {
    // A concurrent commit bumps the state's version just before the rename's freeze lands.
    if (raced || key !== stateKey || !String(value).includes('"kind":"rename"')) return;
    raced = true;
    const current = store.objects.get(stateKey);
    store.objects.set(stateKey, { etag: `race-${current.etag}`, text: current.text });
  };

  const renamed = await renameDocument(store, "from.md", "to.md");

  assert.equal(raced, true, "the race was exercised");
  assert.equal(renamed.renamed, true);
  const state = JSON.parse(store.objects.get(stateKey).text);
  assert.equal(state.structural, null);
  assert.equal(state.path, "to.md");
  assert.equal((await readDocument(store, "to.md")).documentId, documentId);
});

test("a note with no collaboration state renames as a no-op, writing nothing", async () => {
  const store = new KeyedStore();
  store.seedNote("never.md", "# Never edited\n");
  store.moveRow("never.md", "moved.md");
  const writesBefore = store.putCount;

  const answer = await renameDocument(store, "never.md", "moved.md");

  assert.deepEqual(answer, { renamed: false, reason: "no_document" });
  assert.equal(store.putCount, writesBefore);
});

test("a sealed or deleted note is not a live document, so its rename is a no-op that names why", async () => {
  for (const status of ["sealed", "deleted"]) {
    const store = new KeyedStore();
    await editedNote(store, "from.md", "# Plan\n\nSealed.\n");
    const key = [...store.objects.keys()].find((name) =>
      name.startsWith(".context/collaboration/v1/heads/") && JSON.parse(store.objects.get(name).text).path === "from.md");
    const head = JSON.parse(store.objects.get(key).text);
    store.objects.set(key, { etag: `${status}-head`, text: JSON.stringify({ ...head, status }) });
    store.moveRow("from.md", "to.md");
    const writesBefore = store.putCount;

    const answer = await renameDocument(store, "from.md", "to.md");

    assert.deepEqual(answer, { renamed: false, reason: "not_active" }, status);
    assert.equal(store.putCount, writesBefore, `${status} heads are not rewritten`);
  }
});

test("renaming twice is idempotent and says so", async () => {
  const store = new KeyedStore();
  await editedNote(store, "from.md", "# Plan\n\nOne.\n");
  store.moveRow("from.md", "to.md");
  await renameDocument(store, "from.md", "to.md");
  const writesBefore = store.putCount;

  const again = await renameDocument(store, "from.md", "to.md");

  assert.deepEqual(again, { renamed: false, reason: "already" });
  assert.equal(store.putCount, writesBefore);
});

test("a name held by another active document refuses the rename and leaves the old document as it was", async () => {
  const store = new KeyedStore();
  const mine = await editedNote(store, "from.md", "# Mine\n\nOne.\n");
  const theirs = await editedNote(store, "to.md", "# Theirs\n\nTwo.\n");
  const headBefore = store.headAt("from.md");

  await assert.rejects(
    () => renameDocument(store, "from.md", "to.md"),
    (error) => error instanceof CollaborationError && error.code === "DESTINATION_EXISTS",
  );

  assert.deepEqual(store.headAt("from.md"), headBefore);
  assert.equal(store.headAt("to.md").documentId, theirs.documentId);
  assert.notEqual(theirs.documentId, mine.documentId);
  const state = JSON.parse(store.objects.get(`.context/collaboration/v1/documents/${mine.documentId}.json`).text);
  assert.equal(state.path, "from.md");
  assert.equal(state.structural, null);
});

test("a rename interrupted at any storage write resumes: a retry or the next read of the new name finishes it", async () => {
  // Count the writes a clean rename makes, then fail each one in turn.
  const probe = new KeyedStore();
  await editedNote(probe, "from.md", "# Plan\n\nResumed.\n");
  probe.moveRow("from.md", "to.md");
  const before = probe.putCount;
  await renameDocument(probe, "from.md", "to.md");
  const writes = probe.putCount - before;
  assert.ok(writes >= 4, "the rename makes several durable writes, each a point of failure");

  for (let offset = 1; offset <= writes; offset += 1) {
    const store = new KeyedStore();
    const opened = await editedNote(store, "from.md", "# Plan\n\nResumed.\n");
    store.moveRow("from.md", "to.md");
    store.failAt = new Set([store.putCount + offset]);
    // A failure in the final cleanup (the journal's scrub) lands after the rename is complete,
    // so the call may finish. Either way the outcome below must hold.
    await renameDocument(store, "from.md", "to.md").catch(() => {});
    store.failAt = new Set();

    const claimed = store.headAt("to.md");
    if (claimed?.status === "prepared") {
      // Past the claim, the new name's next read finishes the rename without any retry.
      const read = await readDocument(store, "to.md");
      assert.equal(read.documentId, opened.documentId, `identity after failure at write ${offset}`);
    } else {
      // Before the claim nothing was fenced. The next rename attempt finishes the move.
      const retried = await renameDocument(store, "from.md", "to.md");
      assert.ok(retried.renamed === true || retried.reason === "already", `retry after failure at write ${offset}`);
      assert.equal(store.headAt("from.md").status, "moved", `old path fenced after retry at write ${offset}`);
      const read = await readDocument(store, "to.md");
      assert.equal(read.documentId, opened.documentId, `identity after retry for failure at write ${offset}`);
    }
    await assert.rejects(() => readDocument(store, "from.md"), (error) => error.code === "MOVED", `old path fenced after failure at write ${offset}`);
  }
});

/*
 * A trashed note's history (`notes-by-id.md`, "Trash and Restore"). The row
 * moves with the trash and its key stays put; the collaboration heads go with
 * it through `renameDocument(..., {internalTrash: true})`, and a head records
 * the note id of the row it was made for, so a note created later at the
 * name does not take it over, even when the carry did not happen.
 *
 * Sabotage, each confirmed to fail a case here:
 *  - drop the `head.noteId !== noteId` check in `load` and the new-note case opens the trashed note's document;
 *  - drop `internalTrash` from `renameDocument`'s path check and the trash cases throw INELIGIBLE_DOCUMENT;
 *  - drop the `noteId` from `identityHead` and the restored head loses its id, so the next open cannot tell notes apart.
 */
const ID_A = "0190a000-0000-7000-8000-00000000000a";
const ID_B = "0190a000-0000-7000-8000-00000000000b";
const TRASH = ".context/trash/2026-10-15T00-00-00-000Z/from.md";

/** The control plane moves a keyed row between names; its key, and so its bytes and id, travel with it. */
function moveKeyedRow(store, from, to, noteId) {
  const key = store.rows.get(from);
  store.rows.delete(from);
  store.noteIds.delete(from);
  store.rows.set(to, key);
  if (noteId !== undefined) store.noteIds.set(to, noteId);
}

test("a note created at a trashed note's name does not inherit that note's history, even if the trash carried nothing", async () => {
  const store = new KeyedStore();
  store.noteIds.set("from.md", ID_A);
  const trashed = await editedNote(store, "from.md", "# Plan\n\nOld.\n");
  assert.equal(store.headAt("from.md").noteId, ID_A, "the head records the row it was made for");
  moveKeyedRow(store, "from.md", TRASH);
  // The head at the name was not carried: it is still active there, and a new note now lives at that name.
  store.seedNote("from.md", "# New\n");
  store.noteIds.set("from.md", ID_B);

  const opened = await readDocument(store, "from.md");

  assert.notEqual(opened.documentId, trashed.documentId, "the new note starts its own document");
  assert.equal(opened.text, "# New\n");
  const oldState = JSON.parse(store.objects.get(`.context/collaboration/v1/documents/${trashed.documentId}.json`).text);
  assert.equal(oldState.text, trashed.text, "the trashed note's history is left untouched");
});

test("a trash that carried the heads fences the name, and a new note there starts fresh", async () => {
  const store = new KeyedStore();
  store.noteIds.set("from.md", ID_A);
  const trashed = await editedNote(store, "from.md", "# Plan\n\nCarried.\n");
  moveKeyedRow(store, "from.md", TRASH);
  assert.equal((await renameDocument(store, "from.md", TRASH, { internalTrash: true })).renamed, true);
  store.seedNote("from.md", "# New\n");
  store.noteIds.set("from.md", ID_B);

  const opened = await readDocument(store, "from.md");

  assert.notEqual(opened.documentId, trashed.documentId);
  assert.equal(store.headAt(TRASH).documentId, trashed.documentId, "the trashed note's head is at its trash location");
});

test("a trashed then restored note keeps its history and its id", async () => {
  const store = new KeyedStore();
  store.noteIds.set("from.md", ID_A);
  const note = await editedNote(store, "from.md", "# Plan\n\nKept.\n");
  moveKeyedRow(store, "from.md", TRASH);
  const trashed = await renameDocument(store, "from.md", TRASH, { internalTrash: true });
  assert.equal(trashed.renamed, true);
  assert.equal(trashed.documentId, note.documentId);

  moveKeyedRow(store, TRASH, "from.md", ID_A);
  const restored = await renameDocument(store, TRASH, "from.md", { internalTrash: true });
  assert.equal(restored.renamed, true);

  const after = await readDocument(store, "from.md");
  assert.equal(after.documentId, note.documentId);
  assert.equal(after.text, note.text);
  assert.equal(store.headAt("from.md").noteId, ID_A);
  assert.equal(store.headAt(TRASH).status, "moved", "the trash location is fenced once the note is back");
});

test("a rename that fails before it claims the name leaves the note's history where it was, for a restore to find", async () => {
  const store = new KeyedStore();
  store.noteIds.set("from.md", ID_A);
  const note = await editedNote(store, "from.md", "# Plan\n\nUnclaimed.\n");
  moveKeyedRow(store, "from.md", TRASH);
  let failed = false;
  store.beforePut = (key) => {
    if (failed || !key.startsWith(".context/collaboration/")) return;
    failed = true;
    throw new Error("injected storage failure");
  };

  await assert.rejects(() => renameDocument(store, "from.md", TRASH, { internalTrash: true }), CollaborationError);
  assert.equal(failed, true, "the failure was exercised");

  // The row is in the trash either way. The head never moved, so restoring the row finds the history.
  moveKeyedRow(store, TRASH, "from.md", ID_A);
  const restored = await readDocument(store, "from.md");
  assert.equal(restored.documentId, note.documentId);
  assert.equal(restored.text, note.text);
});

test("a rename that fails before the claim does not let a new note at the name take the history", async () => {
  const store = new KeyedStore();
  store.noteIds.set("from.md", ID_A);
  const note = await editedNote(store, "from.md", "# Plan\n\nStill mine.\n");
  moveKeyedRow(store, "from.md", TRASH);
  store.beforePut = (key) => {
    if (key.startsWith(".context/collaboration/")) throw new Error("injected storage failure");
  };
  await assert.rejects(() => renameDocument(store, "from.md", TRASH, { internalTrash: true }));
  store.beforePut = undefined;
  store.seedNote("from.md", "# New\n");
  store.noteIds.set("from.md", ID_B);

  const opened = await readDocument(store, "from.md");

  assert.notEqual(opened.documentId, note.documentId);
  assert.equal(opened.text, "# New\n");
});

test("a head made before the row had an id is not refused for lacking one: its history stays with the note", async () => {
  const store = new KeyedStore();
  const note = await editedNote(store, "from.md", "# Plan\n\nLegacy.\n");
  assert.equal(store.headAt("from.md").noteId, undefined);
  store.noteIds.set("from.md", ID_A);

  const after = await readDocument(store, "from.md");

  assert.equal(after.documentId, note.documentId);
});

test("a trash location is refused as a rename target unless the caller names the trash", async () => {
  const store = new KeyedStore();
  await editedNote(store, "from.md", "# Plan\n\nRefused.\n");
  await assert.rejects(
    () => renameDocument(store, "from.md", TRASH),
    (error) => error instanceof CollaborationError && error.code === "INELIGIBLE_DOCUMENT",
  );
});
