/**
 * Queued moves: a move the tree shows at once while the bucket catches up
 * behind it (phase 4 of `docs/decisions/app-and-console/convex-tree.md`).
 *
 * The control plane keeps the queue (`moveQueue`, `functions/nodeMoves.ts`).
 * A pending move is a pair of paths, `from` and `to`, as they were named when
 * the move was made. Until its last object is copied, an object can sit at its
 * old key while every screen draws it at its new one, and this module holds
 * the three things both sides of the platform need to agree on about that:
 *
 *  - **Where a key really is.** `logicalPath` folds a bucket key through the
 *    pending moves, oldest first; `physicalCandidates` goes the other way.
 *    Chained moves (`a` to `b`, then `b/x` to `c`) fold into one answer, so an
 *    object is copied once, straight to where it ends up.
 *  - **Moving one object** (`moveObject`), with a collaboratively edited
 *    note's history moved first, so edits only ever land on the new file.
 *  - **The store a request reads through while a move is pending**
 *    (`withPendingMoves`). Anything that touches an object at its new name
 *    moves that object there first, and opening a note at its old name moves
 *    it on (`promotePath`). That is "opening a note promotes its move": the
 *    editor, an agent's read and a save all reach the object where it now is.
 *
 * Imported by the control plane rather than ported, as `forwarding.js` is, so
 * a note opened in the app and the same note read by an agent take the same
 * path.
 */

import {
  eligible as collaborationEligible,
  moveDocument as moveCollaborationDocument,
  supported as collaborationSupported,
} from "@context/collaboration";
import { isEncryptedNote } from "../encryption.js";
import { isPlumbing } from "../privacy/engine.js";
import { LOGICAL_DELETE_CONTENT_TYPE, WRITABLE_CONTENT_TYPES } from "../store/contentTypes.js";
import { deleteCreatedDestination, retireMovedSource } from "./objects.js";

/** `key` renamed by one move, or `null` when the move does not reach it. */
function renamed(key, from, to) {
  if (key === from) return to;
  if (key.startsWith(`${from}/`)) return `${to}${key.slice(from.length)}`;
  return null;
}

/** Only well-formed moves count: two different non-empty paths, neither inside the other. */
export function pendingMovesOf(moves) {
  if (!Array.isArray(moves)) return [];
  return moves.filter(
    (move) =>
      move &&
      typeof move.from === "string" &&
      typeof move.to === "string" &&
      move.from !== "" &&
      move.to !== "" &&
      move.from !== move.to &&
      !move.from.endsWith("/") &&
      !move.to.endsWith("/") &&
      !move.to.startsWith(`${move.from}/`) &&
      !move.from.startsWith(`${move.to}/`),
  );
}

/**
 * Where a bucket key is in the tree people see: the key folded through every
 * pending move, oldest first. A folder marker key (`a/`) maps like the folder.
 */
export function logicalPath(key, moves) {
  let path = key;
  for (const move of moves) path = renamed(path, move.from, move.to) ?? path;
  return path;
}

/**
 * Every bucket key that may hold what the tree draws at `logical`, newest move
 * last undone first: the logical path itself (already copied, or never moved),
 * then each old name a pending move left behind. Only keys that really fold to
 * `logical` are returned.
 */
export function physicalCandidates(logical, moves) {
  const found = [logical];
  for (let index = moves.length - 1; index >= 0; index -= 1) {
    const move = moves[index];
    for (const path of [...found]) {
      const before = renamed(path, move.to, move.from);
      if (before !== null && !found.includes(before)) found.push(before);
    }
  }
  return found.filter((path) => logicalPath(path, moves) === logical);
}

/** A key a pending move is carrying away: its tree name is somewhere else. */
export function relocated(key, moves) {
  return logicalPath(key, moves) !== key;
}

/** A conflict a move cannot settle by itself; the worker counts it and retries. */
export class MoveObjectConflict extends Error {
  constructor(reason) {
    super(`move conflict: ${reason}`);
    this.name = "MoveObjectConflict";
    this.code = "MOVE_CONFLICT";
  }
}

function bytesEqual(left, right) {
  const a = new Uint8Array(left);
  const b = new Uint8Array(right);
  if (a.byteLength !== b.byteLength) return false;
  for (let index = 0; index < a.byteLength; index += 1) {
    if (a[index] !== b[index]) return false;
  }
  return true;
}

/**
 * Move one object from `source` to `destination`, idempotently.
 *
 * - Nothing at `source`: it was moved already (by the worker, or by a read
 *   that promoted it), or never there. Answered, never thrown.
 * - A Markdown note the collaboration engine owns moves through it, history
 *   first (`moveDocument`), exactly as a console rename does: that keeps the
 *   note's identity, so the open editor's edits land on the new file.
 * - Anything else is copied only-if-absent, then the source retired against
 *   the version that was copied (`retireMovedSource`). A destination that
 *   already holds these exact bytes is our own earlier copy, and the move
 *   finishes; any other destination is a conflict.
 *
 * @returns {Promise<{state: "moved" | "already" | "missing", etag?: string, size?: number}>}
 */
export async function moveObject(store, source, destination) {
  if (source === destination) return { state: "already" };
  const object = await store.get(source);
  if (object === null || object === undefined) {
    const landed = await store.get(destination);
    return { state: landed ? "already" : "missing" };
  }
  let body;
  if (!source.endsWith("/") && source.endsWith(".md") && destination.endsWith(".md") && collaborationSupported(store)) {
    const text = await object.text();
    if (!isEncryptedNote(text) && collaborationEligible(source, text)) {
      try {
        const moved = await moveCollaborationDocument(store, source, destination);
        return { state: "moved", ...(typeof moved?.etag === "string" ? { etag: moved.etag } : {}) };
      } catch (error) {
        if (error?.code === "MOVED") return { state: "already" };
        if (error?.code === "DESTINATION_EXISTS") throw new MoveObjectConflict("destination exists");
        if (error?.code === "CONFLICT" || error?.code === "BASE_MISSING" || error?.code === "GENERATION_MISMATCH") {
          throw new MoveObjectConflict("note changed while moving");
        }
        throw error;
      }
    }
    body = new TextEncoder().encode(text);
  } else {
    body = await object.arrayBuffer();
  }
  // An image stays an image: the type it was stored as goes with it, where it is one a store may write.
  const type = object.contentType || object.httpMetadata?.contentType;
  const keepType = typeof type === "string" && type !== LOGICAL_DELETE_CONTENT_TYPE && WRITABLE_CONTENT_TYPES.has(type);
  const created = await store.put(destination, body, { onlyIf: { absent: true }, ...(keepType ? { contentType: type } : {}) });
  if (created === null || created === undefined) {
    // Something is at the destination already. Our own earlier copy (a pass
    // that died before retiring the source, or another request promoting the
    // same object a moment ago) holds these exact bytes, and the move only has
    // to retire the source. A zero-byte source is the claim marker a retire on
    // a bucket without conditional deletes leaves when its delete failed.
    const there = await store.get(destination);
    const ours = there && (body.byteLength === 0 || bytesEqual(await there.arrayBuffer(), body));
    if (!ours) throw new MoveObjectConflict("destination exists");
    const retired = await retireMovedSource(store, source, object.etag);
    if (retired !== "retired") {
      if ((await store.get(source)) === null) return { state: "already" };
      throw new MoveObjectConflict("note changed while moving");
    }
    return { state: "moved", ...(typeof there.etag === "string" ? { etag: there.etag } : {}), size: body.byteLength };
  }
  const retired = await retireMovedSource(store, source, object.etag);
  if (retired !== "retired") {
    // Edited while it was copied (or the bucket could not guard the retire):
    // the copy is taken back and the next pass copies the newest version.
    await deleteCreatedDestination(store, destination, created.etag);
    throw new MoveObjectConflict("note changed while moving");
  }
  return { state: "moved", ...(typeof created.etag === "string" ? { etag: created.etag } : {}), size: body.byteLength };
}

/** Thrown for a write to an old name whose object a pending move already carried away. */
export class MovingPathError extends Error {
  constructor() {
    super("This note just moved. Open it again from its new place.");
    this.name = "MovingPathError";
    this.code = "MOVED";
  }
}

/**
 * The store one request reads through while moves are pending.
 *
 * Before anything touches a key at its **new** name whose object still sits
 * at an old one, that object is moved there (promoted). So a read finds it, an
 * existence check sees it, and a write lands on it rather than beside it. This
 * is what makes "the note is already where the tree draws it" true for every
 * reader that asks by name, whether or not the worker has reached it.
 *
 * A key at its **old** name reads as the bucket holds it. A walk of the
 * bucket (search, link rewriting) keeps seeing objects where they physically
 * are until they move, and never moves thousands of them inline. A write
 * there is allowed while the object is still there (the move carries the
 * newest version), and refused once it has gone (`MovingPathError`), because a
 * new object at an old name would collide with the one the move just put at
 * the new name. Opening a note by its old name is promoted by the caller
 * (`promotePath`), so the reader follows the move's forwarding entry.
 *
 * `list` is passed through: listings of the tree are the control plane's, and
 * they draw pending moves already. `onMoved` hears every object this request
 * moved, so the caller can tell the tree. Plumbing keys (`.context/`,
 * `privacy.md`) are never promoted.
 *
 * @param {object} store
 * @param {{from: string, to: string}[]} moves pending moves, oldest first
 * @param {{onMoved?: (moved: {from: string, to: string, etag?: string, size?: number}) => Promise<void>|void}} [options]
 */
export function withPendingMoves(store, moves, options = {}) {
  const pending = pendingMovesOf(moves);
  if (!store || pending.length === 0) return store;
  const promotion = promoter(store, pending, options.onMoved);

  const promoteDestination = async (key) => {
    if (typeof key !== "string" || key === "" || isPlumbing(key) || relocated(key, pending)) return;
    for (const source of physicalCandidates(key, pending)) {
      if (source !== key) await promotion(source, key);
    }
  };
  const guardOldName = async (key) => {
    if (typeof key !== "string" || isPlumbing(key) || !relocated(key, pending)) return;
    if ((await store.get(key)) === null) throw new MovingPathError();
  };

  const wrapped = Object.create(Object.getPrototypeOf(store), Object.getOwnPropertyDescriptors(store));
  for (const method of ["get", "head", "exists", "existsMetadata", "delete"]) {
    if (typeof store[method] !== "function") continue;
    const original = store[method].bind(store);
    wrapped[method] = async (key, ...rest) => {
      await promoteDestination(key);
      return await original(key, ...rest);
    };
  }
  if (typeof store.put === "function") {
    const put = store.put.bind(store);
    wrapped.put = async (key, ...rest) => {
      await guardOldName(key);
      await promoteDestination(key);
      return await put(key, ...rest);
    };
  }
  if (typeof store.copy === "function") {
    const copy = store.copy.bind(store);
    wrapped.copy = async (source, destination, ...rest) => {
      await guardOldName(destination);
      await promoteDestination(source);
      await promoteDestination(destination);
      return await copy(source, destination, ...rest);
    };
  }
  Object.defineProperty(wrapped, "pendingMoves", { value: pending, enumerable: false, configurable: true });
  return wrapped;
}

/**
 * Move the object at `path` to where the tree draws it now, when a pending
 * move is still carrying it: what opening a note by its old name does first,
 * so the read that follows finds it gone and follows the forwarding entry.
 * `false` when nothing was pending for it.
 */
export async function promotePath(store, moves, path, onMoved) {
  const pending = pendingMovesOf(moves);
  if (typeof path !== "string" || isPlumbing(path) || !relocated(path, pending)) return false;
  await promoter(store, pending, onMoved)(path, logicalPath(path, pending));
  return true;
}

/** One promotion per source and destination per request, retried after a failure. */
function promoter(store, pending, onMoved) {
  const settled = new Map();
  return (source, destination) => {
    const key = `${source}\u0000${destination}`;
    if (!settled.has(key)) {
      const work = (async () => {
        const moved = await moveObject(store, source, destination);
        if (moved.state === "moved" && typeof onMoved === "function") {
          await onMoved({
            from: source,
            to: destination,
            ...(moved.etag ? { etag: moved.etag } : {}),
            ...(moved.size === undefined ? {} : { size: moved.size }),
          });
        }
      })();
      settled.set(key, work.catch((error) => {
        settled.delete(key);
        throw error;
      }));
    }
    return settled.get(key);
  };
}
