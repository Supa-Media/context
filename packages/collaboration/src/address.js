/**
 * Where a note's collaboration head lives (decided by the owner, 2026-10-25:
 * "moving a folder ... should be one row change"; `notes-by-id.md`, "Editing
 * history is filed by note id").
 *
 * In a keyed workspace the store knows the note id of the row at a path
 * (`noteIdAt`), and the head is filed under that id
 * (`heads/notes/<noteId>.json`), so a move or rename of the note, or of any
 * folder above it, leaves its history where it is: nothing is carried. Where
 * the store cannot name an id (no row there, plumbing, a store with no id
 * layer) the head is the path's, as it always was (`heads/<sha256(path)>.json`).
 *
 * A head made before this filed by path is moved to the id the first time the
 * note's head is read (`adoptPathHead`), and by the backfill (`backfill.js`):
 * copied to the id key, then the path head is fenced `moved` with
 * `migrated: true`, so neither a later read nor a move's carry treats it as
 * live. A path head made for another note (its `noteId` differs) is never
 * taken; an id-less one is, and `load.js` then proves it is this note's before
 * using it (`adoptUnstampedHead`), as it did at the path.
 */

import { HEAD_PREFIX, ROOT, SCHEMA_VERSION, headKey, isObject, put, readObject } from "./storage.js";

export const NOTE_HEAD_PREFIX = `${HEAD_PREFIX}notes/`;
const NOTE_ID = /^[A-Za-z0-9-]{1,128}$/;

/** The head key of note `noteId`. */
export function noteHeadKey(noteId) {
  if (typeof noteId !== "string" || !NOTE_ID.test(noteId)) throw new TypeError("a note id is letters, digits and dashes");
  return `${NOTE_HEAD_PREFIX}${noteId}.json`;
}

/** Whether `key` is a head filed by note id. */
export function isNoteHeadKey(key) {
  return typeof key === "string" && key.startsWith(NOTE_HEAD_PREFIX);
}

/**
 * Which note a document belongs to, written beside the document's records
 * (`documents/<documentId>/note.json`), so a client holding only a document id
 * after a move is found its note's current name (`noteOfDocument`). Under the
 * document's own prefix, so a permanent purge removes it with the rest.
 */
export function documentNoteKey(documentId) {
  return `${ROOT}/documents/${documentId}/note.json`;
}

/*
  The note id the store gave for each path, for one engine operation: the
  engine asks the same path several times in one (load, then each head write),
  and each ask is a round trip to the control plane. Every public entry runs on
  its own scope (`scoped`), so an id is never kept past the operation that
  asked: a note trashed and another created at its name between two calls is
  seen as the other note. Only ids are kept, never "no row".
*/
const known = new WeakMap();

/**
 * `store` for one engine operation: the same store, seen through a proxy that
 * calls each method on the store itself, with its own note id cache. A scope
 * passed in again is kept, so an entry that calls another shares one.
 */
export function scoped(store) {
  if (!store || typeof store !== "object" || known.has(store)) return store;
  const scope = new Proxy(store, {
    get(target, name) {
      const value = Reflect.get(target, name, target);
      return typeof value === "function" ? value.bind(target) : value;
    },
  });
  known.set(scope, new Map());
  return scope;
}

/** The note id of the live row at `path`, or `null` when the store cannot say. */
export async function noteIdOf(store, path) {
  if (typeof store?.noteIdAt !== "function") return null;
  const cache = known.get(store);
  const cached = cache?.get(path);
  if (cached !== undefined) return cached;
  const noteId = await store.noteIdAt(path);
  if (typeof noteId !== "string" || !NOTE_ID.test(noteId)) return null;
  cache?.set(path, noteId);
  return noteId;
}

/** The head key for the note at `path`: `{key, noteId}`, with `noteId` null for a path-filed head. */
export async function headAddress(store, path) {
  const noteId = await noteIdOf(store, path);
  return noteId === null ? { key: await headKey(path), noteId: null } : { key: noteHeadKey(noteId), noteId };
}

/** The head key for the note at `path`. */
export async function headKeyAt(store, path) {
  return (await headAddress(store, path)).key;
}

/** Fields a head object must have to be moved at all; anything else is left where it is. */
function movableHead(head) {
  return isObject(head) && head.schemaVersion === SCHEMA_VERSION && typeof head.documentId === "string" && typeof head.stateKey === "string";
}

/**
 * Move the path-filed head at `path` to note `noteId`'s key, when it is this
 * note's (its id is `noteId`, or it has none: `load.js` proves an id-less head
 * before using it). Answers the id key's object after, or `null` when there was
 * nothing to move. A head that moved away or was deleted from the name is not a
 * live document, and stays where it is.
 */
export async function adoptPathHead(store, path, noteId, pathHeadRead = null) {
  const idKey = noteHeadKey(noteId);
  const pathKey = await headKey(path);
  // A caller that already asked for the path's head (`readHead`, `pathHeadTogether`) hands the read in.
  const legacy = pathHeadRead === null ? await readObject(store, pathKey) : await pathHeadRead;
  if (!legacy) return null;
  let head;
  try {
    head = JSON.parse(legacy.text);
  } catch {
    return null;
  }
  if (!movableHead(head) || head.path !== path) return null;
  if (head.noteId !== undefined && head.noteId !== noteId) return null;
  const status = head.status || "active";
  if (status === "moved" || status === "deleted") return null;
  const copied = await put(store, idKey, legacy.text, { absent: true });
  if (copied) await recordDocumentNote(store, head.documentId, noteId);
  await fenceMigrated(store, pathKey, head, legacy.etag);
  return await readObject(store, idKey);
}

/** Fence a path head whose document is now filed by its note id: no reader or carry takes it again. */
async function fenceMigrated(store, pathKey, head, etag) {
  const fence = {
    schemaVersion: SCHEMA_VERSION,
    path: head.path,
    documentId: head.documentId,
    generation: head.generation,
    stateKey: head.stateKey,
    status: "moved",
    destination: head.path,
    migrated: true,
    ...(head.noteId === undefined ? {} : { noteId: head.noteId }),
  };
  try {
    await put(store, pathKey, JSON.stringify(fence), { etagMatches: etag });
  } catch {
    // The copy is the head now; a path head left live is fenced by the next read or the backfill.
  }
}

/** Record which note `documentId` belongs to. Written once; a document never changes note. */
export async function recordDocumentNote(store, documentId, noteId) {
  if (typeof documentId !== "string" || !/^[A-Za-z0-9-]+$/.test(documentId)) return;
  try {
    await put(store, documentNoteKey(documentId), JSON.stringify({ schemaVersion: SCHEMA_VERSION, documentId, noteId }), { absent: true });
  } catch {
    // Only a moved client's forwarding reads it; the document itself is whole without it.
  }
}

/** The note id `documentId` was made for, or `null` when nothing says. */
export async function noteOfDocument(store, documentId) {
  if (typeof documentId !== "string" || !/^[A-Za-z0-9-]{1,256}$/.test(documentId)) return null;
  const object = await readObject(store, documentNoteKey(documentId));
  if (!object) return null;
  try {
    const value = JSON.parse(object.text);
    return value?.documentId === documentId && typeof value.noteId === "string" && NOTE_ID.test(value.noteId) ? value.noteId : null;
  } catch {
    return null;
  }
}

/**
 * Whether `path` still holds a live head filed at the name itself, as heads
 * were before they were filed by note id. One read by the name's hash and no
 * id lookup, so a folder move may ask it of every note it moved; only a live
 * one needs `renameDocument`. Moved, deleted and `migrated` heads are not
 * live; one that does not parse is, so the engine, which can tell, decides.
 */
export async function pathHeadLive(store, path) {
  const object = await readObject(store, await headKey(path));
  if (!object) return false;
  try {
    const status = JSON.parse(object.text)?.status || "active";
    return !(status === "moved" || status === "deleted");
  } catch {
    return true;
  }
}
