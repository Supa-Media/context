/**
 * The keyed store and note helpers the keyed suites share (`rename.mjs`,
 * `erase.mjs`): a path-addressed store whose notes live at id keys, as a
 * keyed workspace's do, with the collaboration records at their own keys.
 */
import * as Y from "yjs";
import { commitUpdate, readDocument } from "../src/index.js";

/** A path-addressed store whose notes live at id keys, as a keyed workspace's do. */
export class KeyedStore {
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

  /**
   * The live collaboration head recorded for `path`, read from the bucket's own objects: the one filed by
   * the note id of the row there, when it has one, else the head filed at the name. A path head fenced as
   * `migrated` (its document is filed by note id now) is not the name's head.
   */
  headAt(path) {
    const noteId = this.noteIds.get(path);
    if (noteId !== undefined) {
      const filed = this.objects.get(`.context/collaboration/v1/heads/notes/${noteId}.json`);
      if (filed) return JSON.parse(filed.text);
    }
    for (const [key, object] of this.objects) {
      if (!key.startsWith(".context/collaboration/v1/heads/") || key.startsWith(".context/collaboration/v1/heads/notes/")) continue;
      const head = JSON.parse(object.text);
      if (head.path === path && head.migrated !== true) return head;
    }
    return null;
  }

  /** The head filed under note `noteId`, or `null`. */
  noteHead(noteId) {
    const object = this.objects.get(`.context/collaboration/v1/heads/notes/${noteId}.json`);
    return object ? JSON.parse(object.text) : null;
  }
}

/**
 * One Yjs update that replaces the note's text, computed against `snapshot`
 * (the state the editor holds), as the editor's own document would send it.
 */
export function editOf(snapshot, text) {
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
export async function editedNote(store, path, text) {
  store.seedNote(path, "# Plan\n\nBody.\n");
  const opened = await readDocument(store, path);
  const next = await commitUpdate(store, path, {
    documentId: opened.documentId,
    update: editOf(opened.update, text),
  });
  return { documentId: opened.documentId, text: next.text };
}
