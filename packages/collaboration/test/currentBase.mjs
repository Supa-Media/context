/**
 * A writer that may only replace the version it read (`onlyCurrent`).
 *
 * Reported 2026-10-28 on a website note: the owner saved an edit at 01:39, an
 * agent then wrote the whole note with an etag it had read before that, and
 * the exact-base merge accepted it. Where the agent had rewritten the same
 * lines, the owner's words were gone, and the write said it had succeeded. An
 * agent's whole-note write names the version it read; when that is no longer
 * the note's version the write is a conflict, as `expected_etag` promises.
 * The console's own replays still merge, so this is a flag, not the default.
 */

import assert from "node:assert/strict";
import test from "node:test";
import { readDocument, replaceText } from "../src/index.js";

class MemoryStore {
  constructor() {
    this.capabilities = { conditionalWrite: true, conditionalCreate: true, conditionalDelete: true };
    this.objects = new Map();
    this.sequence = 0;
  }

  async get(key) {
    const object = this.objects.get(key);
    if (!object) return null;
    return { etag: object.etag, text: async () => object.text };
  }

  async put(key, value, options = {}) {
    const expected = options.onlyIf?.etagMatches;
    const current = this.objects.get(key);
    if (expected !== undefined && (!current || current.etag !== expected)) return null;
    if (options.onlyIf?.absent && current) return null;
    const text = typeof value === "string" ? value : new TextDecoder().decode(value);
    const etag = `e${++this.sequence}`;
    this.objects.set(key, { etag, text });
    return { etag };
  }

  async delete(key) {
    this.objects.delete(key);
  }

  async list({ prefix = "" } = {}) {
    return {
      objects: [...this.objects.entries()].filter(([key]) => key.startsWith(prefix)).map(([key, object]) => ({ key, etag: object.etag })),
      truncated: false,
    };
  }

  seed(key, text) {
    const etag = `e${++this.sequence}`;
    this.objects.set(key, { etag, text });
    return etag;
  }
}

const PATH = "website/notes/beneath-the-chaos.md";
const FRONT = "---\ntitle: beneath the chaos\ndate: 2026-01-05\n---\n\n";
const POEM = `${FRONT}beneath the chaos\nthere is a quiet\nthat waits for me\n`;
const OWNER = `${FRONT}beneath the chaos\nthere is a quiet place\nthat waits for me, still\n`;
const AGENT = `${FRONT}below the noise\nthere is a quiet\nthat holds me\n`;

async function ownerEditedAfterAgentRead() {
  const store = new MemoryStore();
  const rawEtag = store.seed(PATH, POEM);
  const read = await readDocument(store, PATH);
  const owner = await replaceText(store, PATH, { documentId: read.documentId, expectedEtag: read.etag, text: OWNER });
  return { store, read, owner, rawEtag };
}

test("a whole-note write from a version the note has moved past is a conflict", async () => {
  const { store, read } = await ownerEditedAfterAgentRead();
  await assert.rejects(
    replaceText(store, PATH, { documentId: read.documentId, expectedEtag: read.etag, onlyCurrent: true, text: AGENT }),
    (error) => error.code === "CONFLICT",
  );
  assert.equal((await readDocument(store, PATH)).text, OWNER);
  assert.equal(await (await store.get(PATH)).text(), OWNER);
});

test("the same write against the version the owner left lands as written", async () => {
  const { store, owner } = await ownerEditedAfterAgentRead();
  const written = await replaceText(store, PATH, { documentId: owner.documentId, expectedEtag: owner.etag, onlyCurrent: true, text: AGENT });
  assert.equal(written.text, AGENT);
  assert.notEqual(written.etag, owner.etag);
});

test("a note's Markdown etag still writes while nothing has changed it", async () => {
  const store = new MemoryStore();
  const rawEtag = store.seed(PATH, POEM);
  const written = await replaceText(store, PATH, { expectedEtag: rawEtag, onlyCurrent: true, text: AGENT });
  assert.equal(written.text, AGENT);
});

test("a Markdown etag from before the owner's edit is a conflict too", async () => {
  const { store, rawEtag } = await ownerEditedAfterAgentRead();
  await assert.rejects(
    replaceText(store, PATH, { expectedEtag: rawEtag, onlyCurrent: true, text: AGENT }),
    (error) => error.code === "CONFLICT" || error.code === "BASE_MISSING",
  );
  assert.equal((await readDocument(store, PATH)).text, OWNER);
});

test("without the flag an older base still merges, as the console's replays need", async () => {
  const { store, read } = await ownerEditedAfterAgentRead();
  const merged = await replaceText(store, PATH, { documentId: read.documentId, expectedEtag: read.etag, text: AGENT });
  assert.notEqual(merged.text, AGENT);
});
