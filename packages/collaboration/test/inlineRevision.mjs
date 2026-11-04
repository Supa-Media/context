// A document's state keeps its current revision's snapshot beside it (`current`, `records.js` `inlineRevision`), so a
// load reads one record and not two. It is trusted only for the revision the state names: a writer from before it
// moves the revision on and carries the old copy along, and that copy must never be served as the new revision.
//
// Sabotage record (applied, test run, named test observed failing, reverted; 2026-11-04):
//  1. `inlineRevision` skipping its `current.revision !== state.revision` check.
//     → "a stale copy carried by an older writer is ignored" fails (the older text is served).
//  2. `finalizePending` reading the revision's file again instead of the state's copy.
//     → "a load after a save reads no revision file" fails.
import assert from "node:assert/strict";
import test from "node:test";
import { readDocument, replaceText } from "../src/index.js";

/** A plain conditional store. */
class MemoryStore {
  constructor() {
    this.capabilities = { conditionalWrite: true, conditionalCreate: true, conditionalDelete: true };
    this.objects = new Map();
    this.sequence = 0;
  }
  async get(key) {
    const object = this.objects.get(key);
    return object ? { etag: object.etag, text: async () => object.text } : null;
  }
  async put(key, value, options = {}) {
    const current = this.objects.get(key);
    if (options.onlyIf?.etagMatches !== undefined && (!current || current.etag !== options.onlyIf.etagMatches)) return null;
    if (options.onlyIf?.absent && current) return null;
    const etag = `e${++this.sequence}`;
    this.objects.set(key, { etag, text: typeof value === "string" ? value : new TextDecoder().decode(value) });
    return { etag };
  }
  async delete(key) {
    for (const one of Array.isArray(key) ? key : [key]) this.objects.delete(one);
  }
  async list({ prefix = "" } = {}) {
    return { objects: [...this.objects.keys()].filter((key) => key.startsWith(prefix)).map((key) => ({ key, etag: this.objects.get(key).etag })), truncated: false };
  }
}

const PATH = "1-projects/note.md";
/** The revision file a writer from before this kept for every save, for the state's current revision. */
async function legacyRevisionFile(store, state) {
  const value = { schemaVersion: 1, kind: "revision", documentId: state.documentId, generation: state.generation, revision: state.revision, snapshot: state.current.snapshot, text: state.text, rawMarkdownEtag: state.current.rawMarkdownEtag };
  await store.put(`.context/collaboration/v1/revisions/${state.documentId}/${state.revision}.json`, JSON.stringify(value));
}
const stateKeyOf = (store) => [...store.objects.keys()].find((key) => key.includes("/documents/") && !key.includes("/operations/"));

async function saved() {
  const store = new MemoryStore();
  await store.put(PATH, "# Note\n\nFirst words.\n");
  const first = await readDocument(store, PATH);
  const second = await replaceText(store, PATH, { expectedEtag: first.etag, onlyCurrent: true, text: "# Note\n\nSecond words.\n" });
  return { store, first, second };
}

test("a save keeps its snapshot beside the document, for the revision it names", async () => {
  const { store, second } = await saved();
  const state = JSON.parse(await (await store.get(stateKeyOf(store))).text());
  assert.equal(`c2.${state.documentId}.${state.current.revision}`, second.etag);
  assert.equal(state.current.snapshot, second.update);
});

test("a load after a save reads no revision file", async () => {
  const { store, second } = await saved();
  const asked = [];
  const get = store.get.bind(store);
  store.get = async (key, ...rest) => {
    asked.push(key);
    return get(key, ...rest);
  };
  const read = await readDocument(store, PATH);
  assert.equal(read.etag, second.etag);
  assert.equal(read.text, "# Note\n\nSecond words.\n");
  assert.deepEqual(asked.filter((key) => key.includes("/revisions/")), []);
});

test("a stale copy carried by an older writer is ignored, and the revision's file is read", async () => {
  const { store, first } = await saved();
  const key = stateKeyOf(store);
  const state = JSON.parse(await (await store.get(key)).text());
  // An older writer moved the revision on to a third save and carried the second save's copy along unchanged.
  const third = await replaceText(store, PATH, { expectedEtag: `c2.${state.documentId}.${state.revision}`, onlyCurrent: true, text: "# Note\n\nThird words.\n" });
  const now = JSON.parse(await (await store.get(key)).text());
  await legacyRevisionFile(store, now);
  await store.put(key, JSON.stringify({ ...now, current: state.current }));
  const read = await readDocument(store, PATH);
  assert.equal(read.etag, third.etag);
  assert.equal(read.text, "# Note\n\nThird words.\n");
  assert.equal(read.update, third.update);
  assert.notEqual(first.etag, read.etag);
});

test("a document saved before states kept a copy still loads and saves", async () => {
  const { store, second } = await saved();
  const key = stateKeyOf(store);
  const stored = JSON.parse(await (await store.get(key)).text());
  await legacyRevisionFile(store, stored);
  const { current: _current, bases: _bases, editedAt: _editedAt, ...legacy } = stored;
  await store.put(key, JSON.stringify(legacy));
  const read = await readDocument(store, PATH);
  assert.equal(read.etag, second.etag);
  const third = await replaceText(store, PATH, { expectedEtag: read.etag, onlyCurrent: true, text: "# Note\n\nThird words.\n" });
  assert.equal((await readDocument(store, PATH)).etag, third.etag);
});
