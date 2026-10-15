/**
 * The id layer: a note's body read from, and written to, its id copy while
 * staff have switched the workspace's layout to "ids"
 * (`docs/decisions/storage-and-credentials/notes-by-id.md`, step 2 of the
 * migration).
 *
 * The bucket holds a note's bytes twice while the layout is switched: at its
 * path (`1-projects/foo.md`), where every version before the switch lives, and
 * at its id key (`notes/<noteId>.md`, or `files/<noteId>.<ext>`). Both are
 * written on every save, so switching back to paths loses nothing. A read
 * prefers the id copy, but only while the control plane says that copy is
 * fresh, meaning it holds the path's current version; otherwise it reads the
 * path, exactly as before.
 *
 * Three rules hold the wrapper to "a layer that can only add a copy":
 *  - A read answers under the **path's** etag, so a conditional write made
 *    against what was read still compares against the path.
 *  - The id layer never fails a request. A lookup, an id read or a mirrored
 *    write that throws is swallowed, and the copy stays stale until the copy
 *    pass catches it. The path's answer is the answer.
 *  - Plumbing (`.context/`, `privacy.md`, any dot segment) is never looked up
 *    and never mirrored, and a read with a conditional or range option passes
 *    through untouched.
 *
 * Built only from the Web APIs, no Node modules, as the rest of the gateway is.
 */

import { isPlumbing } from "../privacy/engine.js";

/** Options that make a read or write about one particular version or byte range. */
const CONDITIONAL_OPTIONS = ["onlyIf", "range", "ifMatch", "ifNoneMatch", "ifModifiedSince", "ifUnmodifiedSince"];

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
 * consumes it and nothing is left for the id key: those are written to the path only.
 */
function replayable(body) {
  if (typeof body === "string" || body instanceof ArrayBuffer || ArrayBuffer.isView(body)) return true;
  return typeof Blob !== "undefined" && body instanceof Blob;
}

/** The control plane's copy record for `path`, or `null` when it names none usable. */
function copyFor(answer, path) {
  const copies = answer?.copies;
  if (!copies || typeof copies !== "object") return null;
  if (!Object.prototype.hasOwnProperty.call(copies, path)) return null;
  const copy = copies[path];
  if (!copy || typeof copy.key !== "string" || copy.key === "" || isPlumbing(copy.key)) return null;
  return copy;
}

/** The copy a read may answer from: fresh, and carrying the path version it holds. */
function freshCopyFor(answer, path) {
  const copy = copyFor(answer, path);
  if (copy === null || copy.fresh !== true) return null;
  if (typeof copy.etag !== "string" || copy.etag === "") return null;
  return copy;
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

/** A write's result is a version: the store's `{etag}`, or `null` when a precondition failed. */
function written(result) {
  return result !== null && typeof result === "object" && typeof result.etag === "string" && result.etag !== "";
}

/**
 * The store with its reads and writes routed through the id layer.
 *
 * `lookup(paths)` answers `{copies}` as `noteIdLookup` does. `wrote(copy)`
 * records `{path, key, etag}` as `noteIdWrote` does. Both are bound by the
 * caller to one request's session, so this module holds no credential.
 *
 * Everything else delegates: the wrapper is the store's own object with the
 * same prototype and descriptors, so non-enumerable properties (the encryption
 * key, the search indexes, the bound move helpers) are carried across as they are.
 *
 * @param {object} store
 * @param {{lookup: (paths: string[]) => Promise<{copies: object}>, wrote: (copy: {path: string, key: string, etag: string}) => Promise<unknown>}} hooks
 */
export function withIdLayout(store, { lookup, wrote } = {}) {
  if (!store || typeof lookup !== "function" || typeof wrote !== "function") return store;

  const wrapped = Object.create(Object.getPrototypeOf(store), Object.getOwnPropertyDescriptors(store));

  /** The id copy a read of `path` may use, or `null`. A throwing lookup is no copy. */
  const readableCopy = async (path) => {
    try {
      return freshCopyFor(await lookup([path]), path);
    } catch {
      return null;
    }
  };

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

  /**
   * A read: the id copy under the path's etag, else the path itself. The
   * tree's etag can trail the bucket (a write by a store without this layer,
   * reported to the tree later), so "fresh" is also checked against the path
   * itself, with one HEAD asked alongside the lookup: a copy never serves a
   * body older than the path's. A `head` needs no copy at all: the path's
   * metadata is the answer either way.
   */
  if (typeof store.get === "function") {
    wrapped.get = async (path, ...rest) => {
      if (!mirroredPath(path) || hasConditional(rest[0]) || typeof store.head !== "function") {
        return await store.get(path, ...rest);
      }
      const [copy, current] = await Promise.all([readableCopy(path), pathEtag(path)]);
      if (copy !== null && current === copy.etag) {
        const object = await idObject(() => store.get(copy.key));
        // A copy written out of order (two saves racing) holds another version
        // than the one recorded: the key's own etag tells them apart.
        // A record that does not name the key's version cannot tell them apart, and is never trusted.
        const same = typeof copy.keyEtag === "string" && copy.keyEtag !== "" && object?.etag === copy.keyEtag;
        if (object !== null && same) return underPathEtag(object, copy.etag);
      }
      return await store.get(path, ...rest);
    };
  }

  /**
   * One write to the id key of `path`, then the record of it. Any failure is
   * swallowed: the copy is stale, and the copy pass writes it again.
   */
  const mirrorWrite = async (path, body, options, etag) => {
    try {
      const copy = copyFor(await lookup([path]), path);
      if (copy === null) return;
      const copied = await store.put(copy.key, body, unconditional(options));
      if (!copied) return;
      const keyEtag = typeof copied.etag === "string" && copied.etag !== "" ? copied.etag : undefined;
      await wrote({ path, key: copy.key, etag, ...(keyEtag === undefined ? {} : { keyEtag }) });
    } catch {
      // Stale until the copy pass. Nothing about the path's write changes.
    }
  };

  if (typeof store.put === "function") {
    wrapped.put = async (path, body, ...rest) => {
      // The path first: its result is the answer, whatever the id layer does next.
      const result = await store.put(path, body, ...rest);
      if (!mirroredPath(path) || !replayable(body) || !written(result)) return result;
      await mirrorWrite(path, body, rest[0], result.etag);
      return result;
    };
  }

  return wrapped;
}
