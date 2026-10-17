/**
 * Emptying a keyed workspace's trash erases a trashed note's collaboration
 * history (`src/erase.js`, `notes-by-id.md`, "Emptying the trash").
 *
 * Sabotage, each confirmed to fail a case here:
 *  - skip `purgeDocumentState` and the revisions and document state stay;
 *  - skip the head's own delete and the trash name keeps a head;
 *  - drop the CORRUPT_STATE catch and an unreadable head stops the erase.
 */
import assert from "node:assert/strict";
import test from "node:test";
import { eraseDocument, readDocument, renameDocument } from "../src/index.js";
import { KeyedStore, editedNote } from "./keyedStore.helpers.mjs";

const TRASH = ".context/trash/2026-09-01T00-00-00-000Z/plan.md";

/** Every collaboration key in the bucket. */
const historyKeys = (store) => [...store.objects.keys()].filter((key) => key.startsWith(".context/collaboration/"));

/** A note edited, then trashed as a keyed trash moves it: the row, then its history. */
async function trashedNote(store) {
  const { documentId } = await editedNote(store, "plan.md", "# Plan\n\nSecret draft.\n");
  store.moveRow("plan.md", TRASH);
  await renameDocument(store, "plan.md", TRASH, { internalTrash: true });
  return documentId;
}

test("erasing a trashed note removes its document state, its revisions and the head at its trash name", async () => {
  const store = new KeyedStore();
  const documentId = await trashedNote(store);
  assert.ok(historyKeys(store).some((key) => key.includes(documentId) && !key.includes("/heads/")));

  const erased = await eraseDocument(store, TRASH);

  assert.deepEqual(erased, { erased: true, documentId });
  assert.equal(store.headAt(TRASH), null);
  assert.deepEqual(historyKeys(store).filter((key) => key.includes(documentId)), []);
  // No object anywhere in the history still carries the note's text.
  for (const key of historyKeys(store)) assert.doesNotMatch(store.objects.get(key).text, /Secret draft/);
});

test("the old name keeps only its fence, and a note made there later starts its own document", async () => {
  const store = new KeyedStore();
  const documentId = await trashedNote(store);
  await eraseDocument(store, TRASH);

  const fence = store.headAt("plan.md");
  assert.equal(fence.status, "moved");
  assert.equal(fence.initialSnapshot, undefined);
  store.seedNote("plan.md", "# New\n");
  const fresh = await readDocument(store, "plan.md");
  assert.notEqual(fresh.documentId, documentId);
  assert.equal(fresh.text, "# New\n");
});

test("a name with no history is nothing to erase, and erasing twice is safe", async () => {
  const store = new KeyedStore();
  assert.deepEqual(await eraseDocument(store, TRASH), { erased: false });
  await trashedNote(store);
  await eraseDocument(store, TRASH);
  assert.deepEqual(await eraseDocument(store, TRASH), { erased: false });
});

test("a head the engine cannot read is removed, so the erase still finishes", async () => {
  const store = new KeyedStore();
  await trashedNote(store);
  const [key] = [...store.objects.entries()].find(
    ([name, object]) => name.startsWith(".context/collaboration/v1/heads/") && JSON.parse(object.text).path === TRASH,
  );
  store.objects.set(key, { etag: "broken", text: "{not json" });

  assert.deepEqual(await eraseDocument(store, TRASH), { erased: true });
  assert.equal(store.objects.has(key), false);
});
