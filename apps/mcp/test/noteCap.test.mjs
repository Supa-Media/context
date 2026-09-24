/**
 * The free managed tier's note cap, as a store wrapper.
 *
 * What it must do: refuse a write that would *add* a note once the store holds
 * `cap` of them, and refuse nothing else — not an edit, not an attachment, not
 * the context's own structure, not a move, not a delete. A limit on how much
 * somebody may add is a different thing from a limit on leaving with it.
 *
 * ## Sabotage record (temporary local edits, reverted; failures measured)
 *
 *   `wouldCreate` treating every note write as a create                    1
 *   `admit` ignoring the relocation window                                 1 (+3 worker)
 *   the count walking plumbing (`.context/`) as notes                      7
 *   `delete` keeping the stale count                                       1
 *   `copy` delegated without the check                                     1
 *   `activity.md` no longer exempt                                         1
 *
 * And in the worker suite (`noteCapGateway.test.mjs`): the factory no longer
 * applying the cap fails 4 checks; the move tools running outside the
 * relocation window fails 3.
 */

import test from "node:test";
import assert from "node:assert/strict";
import {
  NOTE_CAP_REACHED,
  NoteCapReached,
  asRelocation,
  countNotesUpTo,
  isCountedNoteKey,
  withNoteCap,
} from "../src/store/noteCap.js";
import { withLogicalDelete } from "../src/store/logicalDelete.js";

/** A small in-memory bucket with real conditional writes and paged listings. */
class MemoryStore {
  constructor() {
    this.objects = new Map();
    this.counter = 0;
    this.lists = 0;
    this.capabilities = { conditionalWrite: true, conditionalCreate: true, conditionalDelete: false };
  }

  seed(key, text = "x") {
    this.objects.set(key, { body: new TextEncoder().encode(text), etag: `e${++this.counter}` });
  }

  async get(key) {
    const item = this.objects.get(key);
    if (!item) return null;
    const body = item.body.slice();
    return {
      etag: item.etag,
      contentType: "text/markdown; charset=utf-8",
      arrayBuffer: async () => body.slice().buffer,
      text: async () => new TextDecoder().decode(body),
    };
  }

  async head(key) {
    const item = this.objects.get(key);
    return item ? { etag: item.etag, size: item.body.byteLength } : null;
  }

  async exists(key) {
    return this.objects.has(key);
  }

  async put(key, value, options = {}) {
    const current = this.objects.get(key);
    if (options.onlyIf?.absent === true && current) return null;
    if (options.onlyIf?.etagMatches !== undefined && current?.etag !== options.onlyIf.etagMatches) return null;
    const bytes = typeof value === "string" ? new TextEncoder().encode(value) : new Uint8Array(value);
    this.objects.set(key, { body: bytes.slice(), etag: `e${++this.counter}` });
    return { etag: `e${this.counter}` };
  }

  async copy(source, destination, options = {}) {
    const item = this.objects.get(source);
    if (!item) return null;
    return this.put(destination, item.body, options);
  }

  async delete(key) {
    if (!this.objects.has(key)) return null;
    this.objects.delete(key);
  }

  async list({ prefix = "", delimiter, cursor, limit } = {}) {
    this.lists += 1;
    const keys = [...this.objects.keys()].filter((key) => key.startsWith(prefix)).sort();
    if (delimiter) {
      const objects = [];
      const prefixes = new Set();
      for (const key of keys) {
        const rest = key.slice(prefix.length);
        const slash = rest.indexOf(delimiter);
        if (slash < 0) objects.push({ key, size: this.objects.get(key).body.byteLength });
        else prefixes.add(`${prefix}${rest.slice(0, slash + 1)}`);
      }
      return { objects, delimitedPrefixes: [...prefixes], truncated: false };
    }
    const start = cursor === undefined ? 0 : Number(cursor);
    const pageKeys = keys.slice(start, start + (limit || 1000));
    const truncated = start + pageKeys.length < keys.length;
    return {
      objects: pageKeys.map((key) => ({ key, size: this.objects.get(key).body.byteLength })),
      truncated,
      ...(truncated ? { cursor: String(start + pageKeys.length) } : {}),
    };
  }
}

/** A store holding `n` notes in a folder, plus plumbing that must not count. */
function storeWithNotes(n) {
  const store = new MemoryStore();
  store.seed("index.md");
  store.seed("privacy.md");
  for (let i = 2; i < n; i += 1) store.seed(`1-projects/note-${i}.md`);
  store.seed(".context/collaboration/doc.md");
  store.seed("1-projects/diagram.png");
  return store;
}

async function refusal(promise) {
  try {
    await promise;
  } catch (error) {
    return error;
  }
  return null;
}

test("a note is Markdown outside every dot-prefixed segment", () => {
  assert.equal(isCountedNoteKey("1-projects/foo.md"), true);
  assert.equal(isCountedNoteKey("README.MD"), true);
  assert.equal(isCountedNoteKey("index.md"), true);
  assert.equal(isCountedNoteKey("1-projects/diagram.png"), false);
  assert.equal(isCountedNoteKey(".context/collaboration/doc.md"), false);
  assert.equal(isCountedNoteKey("1-projects/.trash/foo.md"), false);
  assert.equal(isCountedNoteKey(""), false);
  assert.equal(isCountedNoteKey(undefined), false);
});

test("the count skips plumbing and stops once it reaches the limit", async () => {
  const store = storeWithNotes(5);
  assert.equal(await countNotesUpTo(store, 100), 5);
  const big = new MemoryStore();
  for (let i = 0; i < 2500; i += 1) big.seed(`a/n-${String(i).padStart(4, "0")}.md`);
  assert.equal(await countNotesUpTo(big, 1000), 1000);
  assert.ok(big.lists <= 2, "a count that has its answer stops listing");
});

test("under the cap a new note is written", async () => {
  const store = withNoteCap(storeWithNotes(4), 5);
  assert.ok(await store.put("1-projects/new.md", "hello", { onlyIf: { absent: true } }));
});

test("at the cap a new note is refused, and nothing is written", async () => {
  const raw = storeWithNotes(5);
  const store = withNoteCap(raw, 5);
  const error = await refusal(store.put("1-projects/new.md", "hello", { onlyIf: { absent: true } }));
  assert.ok(error instanceof NoteCapReached);
  assert.equal(error.code, NOTE_CAP_REACHED);
  assert.equal(error.cap, 5);
  assert.match(error.message, /read, edited, moved and exported/);
  assert.equal(raw.objects.has("1-projects/new.md"), false);

  const unconditional = await refusal(store.put("1-projects/other.md", "hello"));
  assert.ok(unconditional instanceof NoteCapReached, "an unconditional put of a new note is a create too");
});

test("the cap counts across writes in one store without re-listing", async () => {
  const raw = storeWithNotes(3);
  const store = withNoteCap(raw, 5);
  await store.put("a.md", "1", { onlyIf: { absent: true } });
  const listsAfterFirst = raw.lists;
  await store.put("b.md", "2", { onlyIf: { absent: true } });
  assert.equal(raw.lists, listsAfterFirst);
  assert.ok((await refusal(store.put("c.md", "3", { onlyIf: { absent: true } }))) instanceof NoteCapReached);
});

test("at the cap everything that is not a new note still works", async () => {
  const raw = storeWithNotes(5);
  const store = withNoteCap(raw, 5);
  const current = await raw.get("1-projects/note-2.md");
  assert.ok(await store.put("1-projects/note-2.md", "edited", { onlyIf: { etagMatches: current.etag } }), "an edit");
  assert.ok(await store.put("1-projects/note-3.md", "overwritten"), "an unconditional write over a note that exists");
  assert.ok(await store.put("1-projects/photo.jpg", "bytes"), "an attachment");
  assert.ok(await store.put(".context/collaboration/next.md", "state"), "plumbing");
  raw.objects.delete("privacy.md");
  assert.ok(await store.put("privacy.md", "rules", { onlyIf: { absent: true } }), "the context's own structure");
  assert.ok(
    await store.put("activity.md", "# Activity", { onlyIf: { absent: true } }),
    "Context's own activity log, written after somebody else's allowed change",
  );
  assert.equal(await store.delete("1-projects/note-4.md"), undefined, "a delete");
});

test("deleting a note makes room for the next one", async () => {
  const store = withNoteCap(storeWithNotes(5), 5);
  assert.ok((await refusal(store.put("n.md", "x", { onlyIf: { absent: true } }))) instanceof NoteCapReached);
  await store.delete("1-projects/note-2.md");
  assert.ok(await store.put("n.md", "x", { onlyIf: { absent: true } }));
});

test("a move inside the context is never refused, and a create outside it still is", async () => {
  const raw = storeWithNotes(5);
  const store = withNoteCap(raw, 5);
  await asRelocation(store, async () => {
    const body = await (await raw.get("1-projects/note-2.md")).text();
    assert.ok(await store.put("2-areas/note-2.md", body, { onlyIf: { absent: true } }));
    await store.delete("1-projects/note-2.md");
  });
  assert.ok(raw.objects.has("2-areas/note-2.md"));
  assert.ok((await refusal(store.put("new.md", "x", { onlyIf: { absent: true } }))) instanceof NoteCapReached);
});

test("copying to a new note is a create", async () => {
  const store = withNoteCap(storeWithNotes(5), 5);
  const error = await refusal(store.copy("1-projects/note-2.md", "1-projects/copy.md", { onlyIf: { absent: true } }));
  assert.ok(error instanceof NoteCapReached);
});

test("no cap, or a cap that is not a positive integer, is the store itself", () => {
  const raw = new MemoryStore();
  for (const cap of [null, undefined, 0, -1, 1.5, "1000", Number.NaN]) {
    assert.equal(withNoteCap(raw, cap), raw, String(cap));
  }
  assert.equal(asRelocation(raw, () => "ran"), "ran");
});

test("over the logical-delete view, a deleted note neither counts nor escapes the cap", async () => {
  const raw = storeWithNotes(5);
  const logical = withLogicalDelete(raw);
  const store = withNoteCap(logical, 5);
  const current = await logical.get("1-projects/note-2.md");
  await store.delete("1-projects/note-2.md", { onlyIf: { etagMatches: current.etag } });
  assert.equal(await logical.get("1-projects/note-2.md"), null, "logically deleted");
  assert.ok(raw.objects.has("1-projects/note-2.md"), "…as a marker the raw bucket still holds");
  assert.ok(await store.put("fresh.md", "x", { onlyIf: { absent: true } }), "the marker is not a note");
  const again = await refusal(store.put("1-projects/note-2.md", "back", { onlyIf: { absent: true } }));
  assert.ok(again instanceof NoteCapReached, "recreating a deleted note is a create");
});
