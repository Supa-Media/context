/**
 * A writer replaying text the document already holds, against an older base.
 *
 * Reported 2026-09-30: a note typed in the browser came back as the clean text
 * followed by two or three interleaved copies of itself. Every keystroke had
 * already reached the document as a Yjs update; the same typing then arrived
 * again as a whole-text replacement against a base from before it was typed.
 * The exact-base merge treats everything typed since that base as a peer's
 * unseen insertion and keeps it, then inserts the replacement's copy beside it.
 *
 * The rule these tests hold the engine to: text the document already contains
 * is never inserted a second time by a replacement that contains it too. What
 * a genuine peer typed, that the replacement never saw, is still kept.
 */

import assert from "node:assert/strict";
import test from "node:test";
import * as Y from "yjs";
import { commitUpdate, readDocument, replaceText } from "../src/index.js";

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

const SUMMARY = "So Jehoahaz succeeds his father Jehu as king of Samaria/Israel, and Jehoash after him. they both did evil in the eyes of the Lord 😭";

/**
 * A browser typing one character at a time, committing every `every`
 * characters the way the durable controller flushes. Returns every etag the
 * server answered with, oldest first, so a test can replay against any of
 * them.
 */
async function typeInto(store, path, text, at, every = 17) {
  const first = await readDocument(store, path);
  const doc = new Y.Doc();
  Y.applyUpdate(doc, Buffer.from(first.update, "base64"));
  const note = doc.getText("note");
  const etags = [first.etag];
  let vector = Y.encodeStateVector(doc);
  const commit = async () => {
    const update = Y.encodeStateAsUpdate(doc, vector);
    vector = Y.encodeStateVector(doc);
    const result = await commitUpdate(store, path, { documentId: first.documentId, update: Buffer.from(update).toString("base64") });
    etags.push(result.etag);
    return result;
  };
  const characters = Array.from(text);
  let offset = at;
  let result = first;
  for (let index = 0; index < characters.length; index += 1) {
    note.insert(offset, characters[index]);
    offset += characters[index].length;
    if (index % every === every - 1) result = await commit();
  }
  result = await commit();
  doc.destroy();
  return { documentId: first.documentId, etags, result };
}

function occurrences(text, needle) {
  return text.split(needle).length - 1;
}

test("replaying text the document already holds, from an older base, changes nothing", async () => {
  const store = new MemoryStore();
  store.seed("kings.md", "## Summary\n\n## Revelations\n");
  const typed = await typeInto(store, "kings.md", SUMMARY, "## Summary\n".length);
  const current = typed.result.text;
  assert.equal(occurrences(current, "Jehoahaz"), 1);

  for (const stale of typed.etags.slice(0, -1)) {
    const replayed = await replaceText(store, "kings.md", { documentId: typed.documentId, expectedEtag: stale, text: current });
    assert.equal(replayed.text, current, `a replay against ${stale} duplicated the typing`);
  }
  assert.equal(await (await store.get("kings.md")).text(), current);
});

test("a replay that carries more typing than the document lands that typing once", async () => {
  const store = new MemoryStore();
  store.seed("kings.md", "## Summary\n\n## Revelations\n");
  const typed = await typeInto(store, "kings.md", SUMMARY, "## Summary\n".length);
  const desired = typed.result.text.replace("😭", "😭, but God had compassion");
  const replayed = await replaceText(store, "kings.md", { documentId: typed.documentId, expectedEtag: typed.etags[1], text: desired });
  assert.equal(replayed.text, desired);
});

test("a replay from before later typing does not undo or repeat it", async () => {
  const store = new MemoryStore();
  store.seed("kings.md", "## Summary\n\n## Revelations\n");
  const typed = await typeInto(store, "kings.md", SUMMARY, "## Summary\n".length);
  // What the replaying writer held: less than has since been typed.
  const prefix = SUMMARY.slice(0, 40);
  const desired = `## Summary\n${prefix}\n## Revelations\n`;
  const replayed = await replaceText(store, "kings.md", { documentId: typed.documentId, expectedEtag: typed.etags[1], text: desired });
  assert.equal(replayed.text, typed.result.text);
});

test("several replays at different points of one session leave one copy", async () => {
  const store = new MemoryStore();
  store.seed("kings.md", "## Summary\n\n## Questions\n");
  const typed = await typeInto(store, "kings.md", SUMMARY, "## Summary\n".length, 9);
  const current = typed.result.text;
  const characters = Array.from(SUMMARY);
  // Each replay holds the text as it stood at some keystroke, against the
  // base from a commit before it: the draft a restarted editor would carry.
  for (const [base, upTo] of [[1, 30], [2, 60], [3, characters.length]]) {
    const partial = characters.slice(0, upTo).join("");
    const desired = `## Summary\n${partial}\n## Questions\n`;
    await replaceText(store, "kings.md", { documentId: typed.documentId, expectedEtag: typed.etags[base], text: desired });
  }
  const final = await readDocument(store, "kings.md");
  assert.equal(final.text, current);
});

test("a peer's words the replacement never saw are still kept", async () => {
  const store = new MemoryStore();
  store.seed("shared.md", "Heading\nBody\n");
  const agent = await readDocument(store, "shared.md");
  const human = new Y.Doc();
  Y.applyUpdate(human, Buffer.from(agent.update, "base64"));
  human.getText("note").insert("Heading\nBody\n".length, "Human sentence\n");
  await commitUpdate(store, "shared.md", {
    documentId: agent.documentId,
    update: Buffer.from(Y.encodeStateAsUpdate(human)).toString("base64"),
  });
  human.destroy();
  const merged = await replaceText(store, "shared.md", {
    documentId: agent.documentId,
    expectedEtag: agent.etag,
    text: "Heading\nBody\nAgent sentence\n",
  });
  assert.equal(occurrences(merged.text, "Human sentence"), 1);
  assert.equal(occurrences(merged.text, "Agent sentence"), 1);
});

test("the same replacement retried is applied once", async () => {
  const store = new MemoryStore();
  store.seed("kings.md", "## Summary\n\n");
  const typed = await typeInto(store, "kings.md", SUMMARY, "## Summary\n".length);
  const desired = `${typed.result.text}- a learning\n`;
  const input = { documentId: typed.documentId, expectedEtag: typed.etags[1], text: desired };
  const first = await replaceText(store, "kings.md", input);
  const second = await replaceText(store, "kings.md", input);
  assert.equal(first.text, desired);
  assert.equal(second.text, desired);
});

async function peerEdit(store, path, edit) {
  const read = await readDocument(store, path);
  const peer = new Y.Doc();
  Y.applyUpdate(peer, Buffer.from(read.update, "base64"));
  const before = Y.encodeStateVector(peer);
  edit(peer.getText("note"));
  const result = await commitUpdate(store, path, {
    documentId: read.documentId,
    update: Buffer.from(Y.encodeStateAsUpdate(peer, before)).toString("base64"),
  });
  peer.destroy();
  return result;
}

test("a replay with a typo fixed inside typing that already landed keeps one copy", async () => {
  const store = new MemoryStore();
  store.seed("kings.md", "## Summary\n\n");
  const typed = await typeInto(store, "kings.md", SUMMARY.replace("Jehoahaz", "Jehoahz"), "## Summary\n".length);
  const desired = typed.result.text.replace("Jehoahz", "Jehoahaz");
  const replayed = await replaceText(store, "kings.md", { documentId: typed.documentId, expectedEtag: typed.etags[1], text: desired });
  assert.equal(replayed.text, desired);
});

test("a peer's short word is not absorbed into an agent's rewrite of the same sentence", async () => {
  const store = new MemoryStore();
  store.seed("shared.md", "Hello world\n");
  const agent = await readDocument(store, "shared.md");
  await peerEdit(store, "shared.md", (note) => note.insert("Hello ".length, "big "));
  const merged = await replaceText(store, "shared.md", {
    documentId: agent.documentId,
    expectedEtag: agent.etag,
    text: "Hello brave little golden world\n",
  });
  assert.ok(merged.text.includes("big "), `the peer's word was lost: ${JSON.stringify(merged.text)}`);
});

test("a peer's deletion is not undone by a replay that still has the deleted words", async () => {
  const store = new MemoryStore();
  store.seed("shared.md", "Keep this.\nRemove this line.\n");
  const writer = await readDocument(store, "shared.md");
  await peerEdit(store, "shared.md", (note) => note.delete("Keep this.\n".length, "Remove this line.\n".length));
  const merged = await replaceText(store, "shared.md", {
    documentId: writer.documentId,
    expectedEtag: writer.etag,
    text: "Keep this.\nRemove this line.\nAdded by the writer.\n",
  });
  assert.equal(merged.text, "Keep this.\nAdded by the writer.\n");
});

test("a replay that also carries the writer's own edit to older text applies both", async () => {
  const store = new MemoryStore();
  store.seed("kings.md", "# 2 Kings 13\n\n## Summary\n\n");
  const typed = await typeInto(store, "kings.md", SUMMARY, "# 2 Kings 13\n\n## Summary\n".length);
  const desired = typed.result.text.replace("# 2 Kings 13", "# 2 Kings, chapter 13");
  const replayed = await replaceText(store, "kings.md", { documentId: typed.documentId, expectedEtag: typed.etags[2], text: desired });
  assert.equal(replayed.text, desired);
});

test("a replay after the writer retitled the note keeps one copy", async () => {
  const store = new MemoryStore();
  store.seed("kings.md", "# untitled-2026-09-30\n\n");
  await peerEdit(store, "kings.md", (note) => {
    note.delete(2, "untitled-2026-09-30".length);
    note.insert(2, "2-kings-13");
  });
  const first = await readDocument(store, "kings.md");
  const typed = await typeInto(store, "kings.md", SUMMARY, "# 2-kings-13\n\n".length);
  // The editor's draft still names the note's first version, r0, as its base:
  // letters of the deleted placeholder title must not count as kept.
  const created = first.etag.replace(/\.[^.]+$/, ".r0");
  const desired = `${typed.result.text}\n## Revelations/Learnings\n`;
  const replayed = await replaceText(store, "kings.md", { documentId: typed.documentId, expectedEtag: created, text: desired });
  assert.equal(replayed.text, desired);
});
