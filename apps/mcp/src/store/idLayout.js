/**
 * The id layer: where a note's bytes are read from and written to. Every
 * workspace keeps its notes under their ids
 * (`docs/decisions/storage-and-credentials/notes-by-id.md`): a note's bytes
 * live only at its id key (`notes/<noteId>.md`, `files/<noteId><ext>`), and its
 * name, folder and access live on its tree row in the control plane.
 *
 * Every path a person can name is looked up in the tree, and the row decides:
 *
 *  - **Keyed** (`state: "keyed"`): reads and writes go to its key, and its etag
 *    is the key's. Every write is reported back (`wrote`), since the row, not a
 *    bucket listing, says which version a note is at.
 *  - **No row** (or a gone one): there is no note. A read finds nothing, and a
 *    write creates one: the id is minted here, the bytes go to the new id key,
 *    and the row is asked for afterwards (`adopt`). If the name was taken
 *    meanwhile, the bytes just written are removed.
 *  - **A folder**: a write there is refused (`NoteNameTaken`).
 *  - **Anything else** (a workspace or row the control plane says is not keyed)
 *    is refused (`NotKeyed`). There is no path layout to fall back to: a path
 *    object in the bucket is never a note.
 *
 * A lookup that fails fails the request. Plumbing (`.context/`, `privacy.md`,
 * any dot segment, id keys themselves) is never looked up and goes to the
 * store as it is.
 *
 * Built only from the Web APIs, no Node modules, as the rest of the gateway is.
 */

import { isIdKey, isPlumbing } from "../privacy/engine.js";
import { idKeyFor, newNoteId } from "./noteIdKeys.js";
import { texKeyFor } from "./texRouting.js";

/** Options that make a read or write about one particular version or byte range. */
const CONDITIONAL_OPTIONS = ["onlyIf", "range", "ifMatch", "ifNoneMatch", "ifModifiedSince", "ifUnmodifiedSince"];

/**
 * What an operation that only knew paths says. Shared by every caller that
 * refuses one.
 */
export const KEYED_PATH_REFUSAL =
  "this workspace keeps its notes under their ids, and this operation works on paths, so it is not available. Nothing was changed.";

/** The path a keyed question is asked with. The answer is the workspace's, whatever the path. */
const KEYED_PROBE = ".context/keyed-probe";

/**
 * Whether the store's workspace is keyed. `false` for any store with no id
 * layer. A layer that cannot answer throws, and the caller refuses.
 *
 * @param {object} store
 * @returns {Promise<boolean>}
 */
export async function isKeyedWorkspace(store) {
  if (typeof store?.keyedWorkspace !== "function") return false;
  return (await store.keyedWorkspace()) === true;
}

/** A path the id layer answers for: a note or file a person can name. */
function mirroredPath(path) {
  return typeof path === "string" && path !== "" && !isPlumbing(path);
}

/** The write options with no precondition: the same metadata. */
function unconditional(options) {
  const kept = {};
  if (!options || typeof options !== "object") return kept;
  for (const [name, value] of Object.entries(options)) {
    if (!CONDITIONAL_OPTIONS.includes(name)) kept[name] = value;
  }
  return kept;
}

/** Bodies that can be sent twice. A stream is read once. */
function replayable(body) {
  if (typeof body === "string" || body instanceof ArrayBuffer || ArrayBuffer.isView(body)) return true;
  return typeof Blob !== "undefined" && body instanceof Blob;
}

/** A body's size in bytes, or `undefined` for a stream, whose size is not known before it is read. */
function sizeOf(body) {
  if (typeof body === "string") return new TextEncoder().encode(body).byteLength;
  if (body instanceof ArrayBuffer || ArrayBuffer.isView(body)) return body.byteLength;
  if (typeof Blob !== "undefined" && body instanceof Blob) return body.size;
  return undefined;
}

/** A write's result is a version: the store's `{etag}`, or `null` when a precondition failed. */
function written(result) {
  return result !== null && typeof result === "object" && typeof result.etag === "string" && result.etag !== "";
}

/** What the control plane says about `path`, or `null` when it names no row. */
function entryFor(answer, path) {
  const notes = answer?.notes;
  if (!notes || typeof notes !== "object" || !Object.prototype.hasOwnProperty.call(notes, path)) return null;
  const entry = notes[path];
  return entry && typeof entry === "object" ? entry : null;
}

/** A keyed entry the layer can act on: a real id key and the version the row holds. */
function keyedEntry(entry) {
  return (
    entry?.state === "keyed" &&
    isIdKey(entry.key) &&
    typeof entry.etag === "string" &&
    entry.etag !== ""
  );
}

/**
 * The precondition a write against a keyed note compares: the etag given, or,
 * for a client still holding the path's etag from before the note was keyed,
 * the key's etag while the note has not changed since (`legacyEtag`).
 */
function keyedExpectation(entry, expected) {
  if (expected === undefined) return undefined;
  if (expected !== entry.etag && typeof entry.legacyEtag === "string" && expected === entry.legacyEtag) {
    return entry.etag;
  }
  return expected;
}

/**
 * Thrown when an ordinary delete reaches a keyed note. Retiring the row and its
 * key is what emptying the trash does; a delete of a keyed note is a trash
 * (`rowTrash.ts`, Convex), which this gateway cannot make. Nothing is removed.
 */
export class KeyedRetireRefused extends Error {
  constructor() {
    super("a keyed note is trashed, not deleted: nothing was removed");
    this.name = "KeyedRetireRefused";
  }
}

/** Thrown when a keyed write's name turned out to be taken by something this layer cannot write over. */
export class NoteNameTaken extends Error {
  constructor() {
    super("another file already has this name");
    this.name = "NoteNameTaken";
  }
}

/**
 * Thrown when a new note's id key already holds bytes nobody here wrote: the
 * create lost that key to someone else's object. The row is not written, so
 * the path has no version to report; `currentEtag` is the etag of what holds
 * the key, for the caller's conflict. Only ever an etag, never content.
 */
export class NoteCreateRaced extends Error {
  constructor(currentEtag) {
    super("the id this note was created under is already taken");
    this.name = "NoteCreateRaced";
    this.currentEtag = currentEtag;
  }
}

/**
 * Thrown when the control plane answers for a workspace, or a row, that is not
 * keyed. Every workspace is keyed (2026-10-22), so this is a fault to report,
 * never a layout to serve: the bucket's path objects are not notes.
 */
export class NotKeyed extends Error {
  constructor() {
    super("this note is not stored under its id, so it cannot be read or written; nothing was changed");
    this.name = "NotKeyed";
  }
}

/**
 * `lookup`, answering each path from the first answer given for it. The
 * promise is kept, so two reads of one path at the same moment share one
 * round trip. `prime(paths)` asks for many paths at once, in lookups of at
 * most `LOOKUP_MAX`; a path already asked is not asked again.
 */
function rememberingLookup(lookup) {
  const answers = new Map();
  const ask = async (paths) => {
    if (paths.length !== 1) return await lookup(paths);
    const [path] = paths;
    if (!answers.has(path)) answers.set(path, lookup([path]));
    return await answers.get(path);
  };
  ask.prime = async (paths) => {
    const fresh = [...new Set(paths)].filter((path) => !answers.has(path));
    const asked = [];
    for (let start = 0; start < fresh.length; start += LOOKUP_MAX) {
      const batch = fresh.slice(start, start + LOOKUP_MAX);
      const pending = lookup(batch);
      // Each path's own answer is read out of the shared one (`entryFor`), so one answer serves them all.
      for (const path of batch) answers.set(path, pending);
      asked.push(pending);
    }
    await Promise.all(asked);
  };
  return ask;
}

/** The most paths one lookup may name: the control plane's `NOTE_IDS_LOOKUP_PATHS`. */
const LOOKUP_MAX = 200;

/**
 * The store with its reads and writes routed through the id layer.
 *
 * `lookup(paths)` answers `{keyed, notes, texHomes?}` as `noteIdLookup` does:
 * a new note at a path `texHomes` names is kept in that owner's Tex object. `wrote(record)`
 * reports a write, `adopt(note)` asks for a new keyed row and `removed(note)`
 * retires one; each is bound by the caller to one request's session, so this
 * module holds no credential. All four are required. `resolve(noteIds)`, as
 * `noteIdResolve` answers it, is optional: without it no note is found by id.
 *
 * Everything else delegates: the wrapper is the store's own object with the
 * same prototype and descriptors, so non-enumerable properties are carried
 * across as they are.
 *
 * @param {object} store
 * @param {{
 *   lookup: (paths: string[]) => Promise<{keyed?: boolean, notes?: object}>,
 *   wrote: (record: {path: string, key: string, etag: string, keyed?: boolean, size?: number, at?: number}) => Promise<unknown>,
 *   adopt: (note: {path: string, noteId: string, key: string, etag: string, size?: number, at: number}) => Promise<{adopted: boolean, taken?: object|null}>,
 *   removed: (note: {path: string, key: string, at: number}) => Promise<unknown>,
 *   resolve?: (noteIds: string[]) => Promise<{paths?: Record<string, string|null>}>,
 *   now?: () => number,
 * }} hooks
 */
export function withIdLayout(store, { lookup, wrote, adopt, removed, resolve: resolveIds, now = Date.now } = {}) {
  if (!store) return store;
  if (typeof lookup !== "function" || typeof wrote !== "function" || typeof adopt !== "function" || typeof removed !== "function") {
    // Without all four a write could neither create nor retire a row: refused outright, never a path store.
    throw new Error("the id layer needs lookup, wrote, adopt and removed");
  }

  const wrapped = Object.create(Object.getPrototypeOf(store), Object.getOwnPropertyDescriptors(store));

  /** Bytes this layer wrote and no row will ever name: removed, and left for the cleanup if that fails. */
  const discard = async (key) => {
    try {
      await store.delete(key);
    } catch {
      // An id key no row names is never read; the cleanup pass removes it.
    }
  };

  /*
    Whether this workspace is keyed (`keyed` on the lookup answer), asked of
    the tree with a probe path: the answer is the workspace's, not the path's.
    A failed lookup fails the question, as it fails every read.
  */
  wrapped.keyedWorkspace = async () => (await lookup([KEYED_PROBE]))?.keyed === true;

  /** What the tree says about `path`: `{keyed, entry}`. A lookup that fails fails the request. */
  const resolveWith = async (ask, path) => {
    const answer = await ask([path]);
    if (answer?.keyed !== true) throw new NotKeyed();
    const entry = entryFor(answer, path);
    if (entry !== null && entry.state !== "gone" && entry.state !== "folder" && !keyedEntry(entry)) throw new NotKeyed();
    // A new note here is kept in Tex's Durable Object (`texRouting.js`): the owner whose, or null.
    const home = answer?.texHomes?.[path];
    return { entry, texHome: typeof home === "string" && Object.prototype.hasOwnProperty.call(answer.texHomes, path) ? home : null };
  };
  const resolve = (path) => resolveWith(lookup, path);

  /** Whether the tree's answer means "no note here": no live row at the path. */
  const noNote = ({ entry }) => entry === null || entry.state === "gone";

  /** Report a keyed write. Tried twice; a report that still fails leaves the row a version behind, which the diagnosis repairs. */
  const report = async (record) => {
    for (let attempt = 0; attempt < 2; attempt += 1) {
      try {
        await wrote(record);
        return;
      } catch {
        // Tried again once; the write itself has landed either way.
      }
    }
  };

  /** A read routed by the tree: `method` is `get`, `head`, `exists` or `existsMetadata`. */
  const routedRead = (method, ask = lookup) => async (path, ...rest) => {
    if (!mirroredPath(path)) return await store[method](path, ...rest);
    const resolved = await resolveWith(ask, path);
    const { entry } = resolved;
    if (keyedEntry(entry)) return await store[method](entry.key, ...rest);
    // No note here, or a folder: nothing to read.
    return method === "exists" || method === "existsMetadata" ? false : null;
  };

  if (typeof store.get === "function") wrapped.get = routedRead("get");
  if (typeof store.head === "function") wrapped.head = routedRead("head");
  if (typeof store.exists === "function") wrapped.exists = routedRead("exists");
  // The probe `read_note` asks before it reads (`objectExists`, metadata only).
  // Left to the store below, it asked the PATH: a keyed note created since the
  // flip has no object there, so it read as missing, and a trashed note's
  // frozen copy read as present.
  if (typeof store.existsMetadata === "function") wrapped.existsMetadata = routedRead("existsMetadata");

  /**
   * The id of the live row at `path`, for the collaboration engine: a head is
   * made for one note, and a note at a name whose row now names another id
   * does not inherit that head (`packages/collaboration/src/load.js`). A path
   * with no keyed row answers `null`, and so does a row the lookup did not
   * name an id for.
   */
  const noteIdAtWith = (ask) => async (path) => {
    if (!mirroredPath(path)) return null;
    const { entry } = await resolveWith(ask, path);
    return keyedEntry(entry) && typeof entry.noteId === "string" ? entry.noteId : null;
  };
  wrapped.noteIdAt = noteIdAtWith(lookup);

  /**
   * The store as one read sees it (`tools/notes/read.js`): every note path is
   * looked up in the tree once for the whole read, and that one answer
   * decides whether the note is there, where its bytes are, and which note id
   * its collaboration head is filed under. Before this, a read asked the
   * control plane the same question three times in a row (the probe, the get,
   * the engine's `noteIdAt`), each a round trip before the next could start.
   *
   * `outer` is the store the caller holds, with whatever sits above this layer
   * (`privacyAuthority.js`, the note cap, the session's properties): the view
   * inherits all of it, and only a note path's reads are routed here. Writes
   * are never remembered: a write made during the read crosses the layer as
   * any write does, with a lookup of its own.
   *
   * An answer is kept only as long as the view, which lives for one tool
   * call, so a note moved or trashed meanwhile is seen as the next call asks.
   * `prime(paths)` asks for many paths in one lookup (`read_notes`).
   */
  wrapped.oneRead = (outer = wrapped) => {
    const ask = rememberingLookup(lookup);
    const view = Object.create(outer);
    const define = (name, value) =>
      Object.defineProperty(view, name, { value, enumerable: false, writable: false, configurable: true });
    for (const method of ["get", "head", "exists", "existsMetadata"]) {
      if (typeof store[method] !== "function" || typeof outer[method] !== "function") continue;
      const routed = routedRead(method, ask);
      define(method, (path, ...rest) => (mirroredPath(path) ? routed(path, ...rest) : outer[method](path, ...rest)));
    }
    define("noteIdAt", noteIdAtWith(ask));
    /** The live keyed row at `path` as `{key, etag, noteId}`, or `null`: whether a note is there, from the row alone. */
    define("noteAt", async (path) => {
      if (!mirroredPath(path)) return null;
      const { entry } = await resolveWith(ask, path);
      if (!keyedEntry(entry)) return null;
      return { key: entry.key, etag: entry.etag, noteId: typeof entry.noteId === "string" ? entry.noteId : null };
    });
    define("prime", (paths) => ask.prime((Array.isArray(paths) ? paths : []).filter(mirroredPath)));
    // A read that hands its view on (`read_notes` to `read_note`) keeps the one it has.
    define("oneRead", () => view);
    return view;
  };

  /**
   * The keys of the live keyed notes at `paths`, in one lookup: `{path: key}`, a path with no live row `false`, any
   * other row left out, and `{}` when the tree cannot say. For a
   * group turn's direct reads of its chat's own notes (`agent/groupDirectNotes.js`).
   */
  wrapped.keysAt = async (paths) => {
    const named = (Array.isArray(paths) ? paths : []).filter(mirroredPath);
    if (named.length === 0) return {};
    const answer = await lookup(named);
    if (answer?.keyed !== true) return {};
    // A path with no live row is `false`, so a caller can tell "no note there" from "not asked" (`groupDirectNotes.js`).
    const keyOf = (entry) => (keyedEntry(entry) ? entry.key : noNote({ entry }) ? false : undefined);
    return Object.fromEntries(named.map((path) => [path, keyOf(entryFor(answer, path))]).filter(([, key]) => key !== undefined));
  };

  /**
   * The name note `noteId` has now, or `null` (no live row, or no `resolve` hook): how a collaborative
   * client that holds only a document id finds its note after a move (`collaborationRoute.js`). The
   * caller judges whether the asker may see that name.
   */
  wrapped.pathOfNoteId = async (noteId) => {
    if (typeof resolveIds !== "function" || typeof noteId !== "string" || noteId === "") return null;
    const answer = await resolveIds([noteId]);
    const path = answer?.paths?.[noteId];
    return typeof path === "string" && path !== "" ? path : null;
  };

  /** A write to a keyed note: its key, compared against the key's version, then reported. */
  const keyedPut = async (path, entry, body, options) => {
    if (options?.onlyIf?.absent === true) return null;
    const expected = keyedExpectation(entry, options?.onlyIf?.etagMatches);
    const keyOptions =
      expected === undefined ? options : { ...options, onlyIf: { ...options.onlyIf, etagMatches: expected } };
    const result = await store.put(entry.key, body, keyOptions);
    if (!written(result)) return result;
    const size = sizeOf(body);
    await report({ path, key: entry.key, etag: result.etag, ...(size === undefined ? {} : { size }), at: now(), keyed: true });
    return result;
  };

  /** The etag of whatever holds `key`, or `undefined` when nothing answers. */
  const etagAtKey = async (key) => {
    try {
      const head = typeof store.head === "function" ? await store.head(key) : await store.get(key);
      return typeof head?.etag === "string" ? head.etag : undefined;
    } catch {
      return undefined;
    }
  };

  /**
   * A new note in a keyed workspace: a new id, its bytes at the new key, then
   * the row. A name taken meanwhile removes the bytes just written; an
   * unconditional write then lands on whoever holds the name, as a write to
   * an existing note would.
   */
  const keyedCreate = async (path, body, options, texHome = null) => {
    if (options?.onlyIf?.etagMatches !== undefined) return null;
    const noteId = newNoteId(now());
    // In the Tex folder the note is kept in Tex's Durable Object, and its key says so.
    const key = texHome === null ? idKeyFor(noteId, path) : texKeyFor(texHome, idKeyFor(noteId, path));
    const result = await store.put(key, body, { ...unconditional(options), onlyIf: { absent: true } });
    // The key is a fresh id, so a refusal here means somebody else's object is already at it.
    if (result === null) throw new NoteCreateRaced(await etagAtKey(key));
    if (!written(result)) return result;
    const size = sizeOf(body);
    let answer;
    try {
      answer = await adopt({ path, noteId, key, etag: result.etag, ...(size === undefined ? {} : { size }), at: now() });
    } catch (error) {
      await discard(key);
      throw error;
    }
    if (answer?.adopted === true) return result;
    await discard(key);
    if (options?.onlyIf?.absent === true) return null;
    const taken = answer?.taken ?? null;
    if (!replayable(body)) throw new NoteNameTaken();
    if (keyedEntry(taken)) return await keyedPut(path, taken, body, unconditional(options));
    throw new NoteNameTaken();
  };

  if (typeof store.put === "function") {
    wrapped.put = async (path, body, ...rest) => {
      if (!mirroredPath(path)) return await store.put(path, body, ...rest);
      const resolved = await resolve(path);
      const { entry } = resolved;
      if (keyedEntry(entry)) return await keyedPut(path, entry, body, rest[0]);
      if (noNote(resolved)) return await keyedCreate(path, body, rest[0], resolved.texHome);
      throw new NoteNameTaken();
    };
  }

  if (typeof store.delete === "function") {
    wrapped.delete = async (path, ...rest) => {
      if (!mirroredPath(path)) return await store.delete(path, ...rest);
      const resolved = await resolve(path);
      const { entry } = resolved;
      if (keyedEntry(entry)) {
        // Only the trash's emptying retires a keyed row (`retire: true`). Any other delete must not
        // reach `removed`: the row would be tombstoned and its key discarded, which is not recoverable.
        const expected = keyedExpectation(entry, rest[0]?.onlyIf?.etagMatches);
        if (expected !== undefined && expected !== entry.etag) return null;
        if (rest[0]?.retire !== true) throw new KeyedRetireRefused();
        // The row first: once it is gone the note is gone, whatever happens to its bytes.
        await removed({ path, key: entry.key, at: now() });
        await discard(entry.key);
        return undefined;
      }
      // No note here, or a folder: a note delete removes nothing.
      return undefined;
    };
  }

  if (typeof store.copy === "function") {
    /**
     * A server-side copy names keys, so where either side is a note it is a
     * read and a write through this layer instead: the destination gets a row
     * of its own. Between plumbing keys it is the store's own copy.
     */
    wrapped.copy = async (source, destination, ...rest) => {
      if (!mirroredPath(source) && !mirroredPath(destination)) return await store.copy(source, destination, ...rest);
      const object = await wrapped.get(source);
      if (object === null) return null;
      const contentType = object.contentType ?? object.httpMetadata?.contentType;
      const options = { ...(rest[0] ?? {}), ...(contentType ? { httpMetadata: { contentType } } : {}) };
      return await wrapped.put(destination, await object.arrayBuffer(), options);
    };
  }

  return wrapped;
}
