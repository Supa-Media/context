/**
 * The id layer: where a note's bytes are read from and written to, once the
 * control plane has given notes their own keys
 * (`docs/decisions/storage-and-credentials/notes-by-id.md`).
 *
 * Every path a person can name is looked up in the tree, and the row decides:
 *
 *  - **Keyed** (`state: "keyed"`): the note's bytes live only at its id key
 *    (`notes/<noteId>.md`, `files/<noteId><ext>`). Reads and writes go there,
 *    and its etag is the key's. The object still at the path is a frozen old
 *    copy that nothing reads again. Every write is reported back
 *    (`wrote`), since the row, not a bucket listing, is now what says which
 *    version a note is at.
 *  - **Path** (`state: "path"`): the path is still the note's home, as before
 *    the switch. A read prefers the id copy while the control plane says it is
 *    fresh and the path has not moved on; a write lands on the path and is
 *    mirrored to the id copy.
 *  - **No row, in a keyed workspace**: there is no note. A read finds nothing,
 *    and a write creates one: the id is minted here, the bytes go to the new
 *    id key (never the path), and the row is asked for afterwards (`adopt`).
 *    If the name was taken meanwhile, the bytes just written are removed.
 *  - **No row, elsewhere**: the path, exactly as without this layer.
 *
 * Rules that hold the wrapper:
 *  - A path-state read answers under the **path's** etag, so a conditional
 *    write made against what was read still compares against the path. A
 *    keyed read answers under the key's own etag, which is the row's.
 *  - While the layout is "ids", the id layer never fails a request: a lookup,
 *    an id read or a mirrored write that throws is swallowed and the path
 *    answers. Once it is "keys", a lookup that fails fails the request: a
 *    path read could return a note's frozen old copy.
 *  - Plumbing (`.context/`, `privacy.md`, any dot segment, id keys themselves)
 *    is never looked up, and a read with a conditional or range option on a
 *    path-state note passes straight to the path.
 *
 * Built only from the Web APIs, no Node modules, as the rest of the gateway is.
 */

import { isIdKey, isPlumbing } from "../privacy/engine.js";
import { idKeyFor, newNoteId } from "./noteIdKeys.js";

/** Options that make a read or write about one particular version or byte range. */
const CONDITIONAL_OPTIONS = ["onlyIf", "range", "ifMatch", "ifNoneMatch", "ifModifiedSince", "ifUnmodifiedSince"];

/**
 * What a path-based operation says in a keyed workspace, where the path holds
 * a frozen copy and not the note. Shared by every caller that refuses.
 */
export const KEYED_PATH_REFUSAL =
  "this workspace keeps its notes under their ids, and this operation works on paths, so it is not available in a keyed workspace yet. Nothing was changed.";

/** The path a keyed question is asked with. The answer is the workspace's, whatever the path. */
const KEYED_PROBE = ".context/keyed-probe";

/**
 * Whether the store's workspace is keyed. `false` for any store with no id
 * layer, since nothing above it can be keyed without one. A layer that cannot
 * answer throws, and the caller refuses.
 *
 * @param {object} store
 * @returns {Promise<boolean>}
 */
export async function isKeyedWorkspace(store) {
  if (typeof store?.keyedWorkspace !== "function") return false;
  return (await store.keyedWorkspace()) === true;
}

/** A path the id layer may answer for: a note or file a person can name. */
function mirroredPath(path) {
  return typeof path === "string" && path !== "" && !isPlumbing(path);
}

function hasConditional(options) {
  if (!options || typeof options !== "object") return false;
  return CONDITIONAL_OPTIONS.some((name) => options[name] !== undefined);
}

/** The write options a mirrored copy carries: the same metadata, with no precondition. */
function unconditional(options) {
  const kept = {};
  if (!options || typeof options !== "object") return kept;
  for (const [name, value] of Object.entries(options)) {
    if (!CONDITIONAL_OPTIONS.includes(name)) kept[name] = value;
  }
  return kept;
}

/**
 * Bodies that can be sent twice. A stream is read once, so the path write
 * consumes it and nothing is left for the id key: those are written once.
 */
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

/**
 * What the control plane says about `path`: an entry from `notes` when it
 * answered them, else (an older control plane) a path-state entry built from
 * `copies`. `null` when it names no row.
 */
function entryFor(answer, path) {
  const notes = answer?.notes;
  if (notes && typeof notes === "object") {
    if (!Object.prototype.hasOwnProperty.call(notes, path)) return null;
    const entry = notes[path];
    return entry && typeof entry === "object" ? entry : null;
  }
  const copies = answer?.copies;
  if (!copies || typeof copies !== "object" || !Object.prototype.hasOwnProperty.call(copies, path)) return null;
  const copy = copies[path];
  return copy && typeof copy === "object" ? { state: "path", ...copy } : null;
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

/** A path-state entry's id copy, when its key is a real id key: the only copy ever read or written. */
function copyOf(entry) {
  if (entry?.state !== "path" || !isIdKey(entry.key)) return null;
  return entry;
}

/** The copy a read may answer from: fresh, and carrying the path version it holds. */
function freshCopyOf(entry) {
  const copy = copyOf(entry);
  if (copy === null || copy.fresh !== true) return null;
  if (typeof copy.etag !== "string" || copy.etag === "") return null;
  return copy;
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
 * The same object, answering `etag` for its version. A proxy rather than a
 * copy: a store's object carries methods that need its own state (a body
 * stream, a text decoder), and they are bound to the object they came from.
 */
function underPathEtag(object, etag) {
  return new Proxy(object, {
    get(target, property) {
      if (property === "etag") return etag;
      const value = Reflect.get(target, property, target);
      return typeof value === "function" ? value.bind(target) : value;
    },
  });
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
 * The store with its reads and writes routed through the id layer.
 *
 * `lookup(paths)` answers `{copies, keyed, notes}` as `noteIdLookup` does.
 * `wrote(record)` reports a write, `adopt(note)` asks for a new keyed row and
 * `removed(note)` retires one; each is bound by the caller to one request's
 * session, so this module holds no credential. `mode` is the layout the
 * control plane named: `"ids"` or `"keys"`.
 *
 * Everything else delegates: the wrapper is the store's own object with the
 * same prototype and descriptors, so non-enumerable properties are carried
 * across as they are.
 *
 * @param {object} store
 * @param {{
 *   lookup: (paths: string[]) => Promise<{copies?: object, keyed?: boolean, notes?: object}>,
 *   wrote: (record: {path: string, key: string, etag: string, keyEtag?: string, keyed?: boolean, size?: number, at?: number}) => Promise<unknown>,
 *   adopt?: (note: {path: string, noteId: string, key: string, etag: string, size?: number, at: number}) => Promise<{adopted: boolean, taken?: object|null}>,
 *   removed?: (note: {path: string, key: string, at: number}) => Promise<unknown>,
 *   mode?: "ids" | "keys",
 *   now?: () => number,
 * }} hooks
 */
export function withIdLayout(store, { lookup, wrote, adopt, removed, mode = "ids", now = Date.now } = {}) {
  if (!store || typeof lookup !== "function" || typeof wrote !== "function") return store;
  const strict = mode === "keys";
  // A keyed workspace creates and retires rows through these two; a "keys"
  // layer without them would read frozen path copies, so it is refused outright.
  if (strict && (typeof adopt !== "function" || typeof removed !== "function")) {
    throw new Error("the keys layout needs adopt and removed");
  }

  const wrapped = Object.create(Object.getPrototypeOf(store), Object.getOwnPropertyDescriptors(store));

  /** The object at an id key, or `null` when it is missing or cannot be read. */
  const idObject = async (read) => {
    try {
      return (await read()) ?? null;
    } catch {
      return null;
    }
  };

  /** The path's current etag, or `null` when it is missing or cannot be asked. */
  const pathEtag = async (path) => {
    try {
      return (await store.head(path))?.etag ?? null;
    } catch {
      return null;
    }
  };

  /** The fresh id copy's object under the path's etag, when `current` (the path's etag) still matches it; else `null`. */
  const fromFreshCopy = async (copy, current) => {
    if (copy === null || current !== copy.etag) return null;
    const object = await idObject(() => store.get(copy.key));
    // A copy written out of order (two saves racing) holds another version
    // than the one recorded: the key's own etag tells them apart. A record
    // that does not name the key's version cannot, and is never trusted.
    const same = typeof copy.keyEtag === "string" && copy.keyEtag !== "" && object?.etag === copy.keyEtag;
    return object !== null && same ? underPathEtag(object, copy.etag) : null;
  };

  /** Bytes this layer wrote and no row will ever name: removed, and left for the cleanup if that fails. */
  const discard = async (key) => {
    try {
      await store.delete(key);
    } catch {
      // An id key no row names is never read; the cleanup pass removes it.
    }
  };

  /**
   * A path-state write: the path first (its result is the answer), then the
   * same bytes to the id copy and the record of it. A failed mirror is
   * swallowed: the copy is stale until the copy pass catches it.
   */
  const pathPut = async (path, entry, body, rest) => {
    const result = await store.put(path, body, ...rest);
    if (!replayable(body) || !written(result)) return result;
    try {
      const copy = copyOf(entry ?? entryFor(await lookup([path]), path));
      if (copy === null) return result;
      const copied = await store.put(copy.key, body, unconditional(rest[0]));
      if (!copied) return result;
      const keyEtag = typeof copied.etag === "string" && copied.etag !== "" ? copied.etag : undefined;
      await wrote({ path, key: copy.key, etag: result.etag, ...(keyEtag === undefined ? {} : { keyEtag }) });
    } catch {
      // Stale until the copy pass. Nothing about the path's write changes.
    }
    return result;
  };

  /*
    Whether this workspace is keyed (`keyed` on the lookup answer). A keyed
    workspace's path objects are frozen copies, so a caller that lists or moves
    by path must refuse it. Asked of the tree with a probe path: the answer is
    the workspace's, not the path's. A failed lookup fails the question, as it
    fails every read in this layout.
  */
  wrapped.keyedWorkspace = async () => strict && (await lookup([KEYED_PROBE]))?.keyed === true;

  if (!strict) {
    /* ------------- "ids": the path is home; the copy is a mirror ------------- */

    /** The id copy a read of `path` may use, or `null`. A throwing lookup is no copy. */
    const readableCopy = async (path) => {
      try {
        return freshCopyOf(entryFor(await lookup([path]), path));
      } catch {
        return null;
      }
    };

    /**
     * A read: the id copy under the path's etag, else the path itself. The
     * HEAD that proves the path has not moved on is asked alongside the
     * lookup. A `head` needs no copy at all: the path's metadata is the answer.
     */
    if (typeof store.get === "function") {
      wrapped.get = async (path, ...rest) => {
        if (!mirroredPath(path) || hasConditional(rest[0]) || typeof store.head !== "function") {
          return await store.get(path, ...rest);
        }
        const [copy, current] = await Promise.all([readableCopy(path), pathEtag(path)]);
        return (await fromFreshCopy(copy, current)) ?? (await store.get(path, ...rest));
      };
    }

    if (typeof store.put === "function") {
      wrapped.put = async (path, body, ...rest) => {
        if (!mirroredPath(path) || !replayable(body)) return await store.put(path, body, ...rest);
        return await pathPut(path, null, body, rest);
      };
    }
    return wrapped;
  }

  /* --------------- "keys": the row says where a note lives --------------- */

  /** What the tree says about `path`: `{keyed, entry}`. A lookup that fails fails the request. */
  const resolve = async (path) => {
    const answer = await lookup([path]);
    return { keyed: answer?.keyed === true, entry: entryFor(answer, path) };
  };

  /** Whether the tree's answer means "no note here": a keyed workspace with no live row at the path. */
  const noNote = ({ keyed, entry }) => keyed && (entry === null || entry.state === "gone");

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

  /** A read routed by the tree: `method` is `get`, `head` or `exists`. */
  const routedRead = (method) => async (path, ...rest) => {
    if (!mirroredPath(path)) return await store[method](path, ...rest);
    const resolved = await resolve(path);
    const { entry } = resolved;
    if (keyedEntry(entry)) return await store[method](entry.key, ...rest);
    if (noNote(resolved)) return method === "exists" ? false : null;
    const copy = method === "get" && !hasConditional(rest[0]) && typeof store.head === "function" ? freshCopyOf(entry) : null;
    if (copy !== null) {
      const fromCopy = await fromFreshCopy(copy, await pathEtag(path));
      if (fromCopy !== null) return fromCopy;
    }
    return await store[method](path, ...rest);
  };

  if (typeof store.get === "function") wrapped.get = routedRead("get");
  if (typeof store.head === "function") wrapped.head = routedRead("head");
  if (typeof store.exists === "function") wrapped.exists = routedRead("exists");

  /**
   * The id of the live row at `path`, for the collaboration engine: a head is
   * made for one note, and a note at a name whose row now names another id
   * does not inherit that head (`packages/collaboration/src/load.js`). A path
   * with no keyed row answers `null`, and so does a row the lookup did not
   * name an id for.
   */
  wrapped.noteIdAt = async (path) => {
    if (!mirroredPath(path)) return null;
    const { entry } = await resolve(path);
    return keyedEntry(entry) && typeof entry.noteId === "string" ? entry.noteId : null;
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

  /**
   * A new note in a keyed workspace: a new id, its bytes at the new key, then
   * the row. A name taken meanwhile removes the bytes just written; an
   * unconditional write then lands on whoever holds the name, as a write to
   * an existing note would.
   */
  const keyedCreate = async (path, body, options) => {
    if (options?.onlyIf?.etagMatches !== undefined) return null;
    const noteId = newNoteId(now());
    const key = idKeyFor(noteId, path);
    const result = await store.put(key, body, { ...unconditional(options), onlyIf: { absent: true } });
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
    if (taken?.state === "path") return await pathPut(path, taken, body, [unconditional(options)]);
    throw new NoteNameTaken();
  };

  if (typeof store.put === "function") {
    wrapped.put = async (path, body, ...rest) => {
      if (!mirroredPath(path)) return await store.put(path, body, ...rest);
      const resolved = await resolve(path);
      const { entry } = resolved;
      if (keyedEntry(entry)) return await keyedPut(path, entry, body, rest[0]);
      if (noNote(resolved)) return await keyedCreate(path, body, rest[0]);
      if (resolved.keyed && entry?.state === "folder") throw new NoteNameTaken();
      if (entry?.state === "path") return await pathPut(path, entry, body, rest);
      return await store.put(path, body, ...rest);
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
      if (noNote(resolved)) return undefined;
      return await store.delete(path, ...rest);
    };
  }

  if (typeof store.copy === "function") {
    /**
     * A server-side copy names keys, so where either side is a keyed note or
     * in a keyed workspace it is a read and a write through this layer
     * instead: the destination gets a row of its own. Elsewhere it is the
     * store's own copy.
     */
    wrapped.copy = async (source, destination, ...rest) => {
      const none = { keyed: false, entry: null };
      const [from, to] = await Promise.all([
        mirroredPath(source) ? resolve(source) : none,
        mirroredPath(destination) ? resolve(destination) : none,
      ]);
      const keyedSide = from.keyed || to.keyed || keyedEntry(from.entry) || keyedEntry(to.entry);
      if (!keyedSide) return await store.copy(source, destination, ...rest);
      const object = await wrapped.get(source);
      if (object === null) return null;
      const contentType = object.contentType ?? object.httpMetadata?.contentType;
      const options = { ...(rest[0] ?? {}), ...(contentType ? { httpMetadata: { contentType } } : {}) };
      return await wrapped.put(destination, await object.arrayBuffer(), options);
    };
  }

  return wrapped;
}
