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
import { notAMarker } from "../store/logicalDelete.js";
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

/**
 * Whether a read of `key` is a read of a name a move has carried away, which
 * is no longer an address for the note.
 *
 * Every listing draws a pending move at once and judges each name by the
 * rules at the name it draws. The bucket catches up behind that, so a move
 * that narrows — a `team` folder moved somewhere private — would otherwise go
 * on serving each note at its old key, judged by the old key's rules, for as
 * long as the move takes, while every screen says it is done. The rules at
 * the old name are kept deliberately (`lib/nodes/movePrivacy.ts`): an object
 * still sitting there has to be readable by the worker carrying it.
 *
 * The console never had that window, because its barrier promotes the path a
 * read opens before the read (`storeWithMoves`), so the old key is gone and
 * the miss is forwarded, where `canSee` is asked again at the destination.
 * This is the same answer without the copy, and it is the one the move engine
 * before this gives for a path under a job's source (`notes/visibleKeys.js`).
 *
 * Plumbing is excluded, as it is from promotion: the tree never carries it.
 */
function isOldName(key, moves) {
  return typeof key === "string" && key !== "" && !isPlumbing(key) && relocated(key, moves);
}

/**
 * What each read answers for a name a move has carried away: not found, in
 * that method's own shape. `delete` is not a read and is absent, so it still
 * reaches the object where it is.
 */
const AWAY_ANSWER = { get: null, head: null, exists: false, existsMetadata: false };

/**
 * A conflict a move cannot settle by itself. `clash` says which: `true` when a
 * different object already sits at the destination (the worker can settle
 * that by keeping both, `lib/nodes/moveSteps.ts`), `false` when the source
 * changed while it was copied (the next try copies the newest version).
 */
export class MoveObjectConflict extends Error {
  constructor(reason) {
    super(`move conflict: ${reason}`);
    this.name = "MoveObjectConflict";
    this.code = "MOVE_CONFLICT";
    this.clash = reason === DESTINATION_EXISTS;
  }
}

const DESTINATION_EXISTS = "destination exists";

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
  if (serverCopies(store) && !source.endsWith("/") && !source.endsWith(".md") && !destination.endsWith(".md")) {
    const fast = await moveByServerCopy(store, source, destination);
    if (fast !== null) return fast;
  }
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
        if (error?.code === "DESTINATION_EXISTS") throw new MoveObjectConflict(DESTINATION_EXISTS);
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
  let created;
  try {
    created = await store.put(destination, body, { onlyIf: { absent: true }, ...(keepType ? { contentType: type } : {}) });
  } catch (error) {
    // The logical view refuses to bring a file that is not a note back over a
    // deleted file's marker: the name is held, which is a clash the worker
    // settles by keeping the file beside it, never a failure to retry for ever.
    if (/over a logical tombstone/.test(String(error?.message))) throw new MoveObjectConflict(DESTINATION_EXISTS);
    throw error;
  }
  if (created === null || created === undefined) {
    // Something is at the destination already. Our own earlier copy (a pass
    // that died before retiring the source, or another request promoting the
    // same object a moment ago) holds these exact bytes, and the move only has
    // to retire the source. A zero-byte source is the claim marker a retire on
    // a bucket without conditional deletes leaves when its delete failed.
    const there = await store.get(destination);
    const ours = there && (body.byteLength === 0 || bytesEqual(await there.arrayBuffer(), body));
    if (!ours) throw new MoveObjectConflict(DESTINATION_EXISTS);
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

/** Whether this bucket proved at connect that it copies server-side, preconditions and all. */
function serverCopies(store) {
  return store?.capabilities?.serverSideCopy === "same-store" &&
    typeof store.copy === "function" && typeof store.head === "function";
}

/** Past this a clash is decided by size and etag alone; under it the bytes are compared. */
const COMPARE_BYTES_MAX = 8 * 1024 * 1024;

/**
 * Move an object that is not a note by the bucket's own copy: a HEAD, a
 * create-only copy pinned to that version, and the guarded retire. Its bytes
 * never pass through here, whatever its size (`S3Store.copy` copies past
 * 5 GiB in parts). Answers `null` where it cannot decide, and the caller
 * takes the read-and-write path, which can: a HEAD that cannot rule out a
 * deletion marker, or a small destination whose bytes need comparing.
 */
async function moveByServerCopy(store, source, destination) {
  const meta = await store.head(source);
  if (meta === undefined) return null;
  if (meta === null) {
    const landed = await store.head(destination);
    return { state: landed ? "already" : "missing" };
  }
  if (!notAMarker(meta)) return null;
  const moved = (etag) => ({ state: "moved", ...(typeof etag === "string" && etag ? { etag } : {}), size: meta.size });
  const copied = await store.copy(source, destination, {
    onlyIf: { absent: true },
    sourceOnlyIf: { etagMatches: meta.etag },
    size: meta.size,
    ...(typeof meta.contentType === "string" ? { contentType: meta.contentType } : {}),
  });
  if (copied === null || copied === undefined) {
    const there = await store.head(destination);
    if (there === null || there === undefined) {
      if ((await store.head(source)) === null) return { state: "already" };
      throw new MoveObjectConflict("note changed while moving");
    }
    // Our own earlier copy (a pass that died before retiring the source): same size and the
    // version it was copied from, as its etag or, for a copy made in parts, its stamp.
    // A deleted file's marker holds the name: a clash, kept beside rather than written over.
    if (!notAMarker(there)) throw new MoveObjectConflict(DESTINATION_EXISTS);
    const ours = there.size === meta.size && (there.etag === meta.etag || there.copyOf === meta.etag);
    if (!ours) {
      if (meta.size <= COMPARE_BYTES_MAX) return null;
      throw new MoveObjectConflict(DESTINATION_EXISTS);
    }
    const retired = await retireMovedSource(store, source, meta.etag);
    if (retired !== "retired") {
      if ((await store.head(source)) === null) return { state: "already" };
      throw new MoveObjectConflict("note changed while moving");
    }
    return moved(there.etag);
  }
  const retired = await retireMovedSource(store, source, meta.etag);
  if (retired !== "retired") {
    await deleteCreatedDestination(store, destination, copied.etag);
    throw new MoveObjectConflict("note changed while moving");
  }
  return moved(copied.etag);
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
    const away = AWAY_ANSWER[method];
    wrapped[method] = async (key, ...rest) => {
      if (away !== undefined && isOldName(key, pending)) return away;
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
  // The object still sitting at an old name, read without moving it: for a
  // reader that holds an index's bucket key and has already asked `canSee` at
  // the name the tree draws (`readAtTreeName`). Never an address a person
  // gave: that read goes through `get`, which answers "not found".
  if (typeof store.get === "function") {
    Object.defineProperty(wrapped, "getStillAt", { value: store.get.bind(store), enumerable: false, configurable: true });
  }
  return wrapped;
}

/**
 * Read what an index holds at bucket key `key`, judged at the name the tree
 * draws it under: `null` when the caller may not see that name. A key no
 * pending move carries is read as it always was. Search snippets come from
 * here, so a note inside a folder whose queued move is still copying is found,
 * shown at its new name, and never shown to anyone the move took it from.
 *
 * `isVisible` is the whole of the protection on that read, because
 * `getStillAt` is the store's own `get` with the pending-move guard taken
 * off. A caller that supplies none is therefore answered `null` rather than
 * the bytes: the gate is shut by default, so adding a reader cannot quietly
 * reopen the old name. A key no move is carrying needs no check and is read
 * as it always was.
 *
 * @param {{ get: (key: string) => Promise<any>, getStillAt?: (key: string) => Promise<any>, pendingMoves?: unknown }} store
 * @param {string} key
 * @param {(path: string) => boolean} [isVisible] required for a key a move carries
 */
export async function readAtTreeName(store, key, isVisible) {
  const pending = pendingMovesOf(store?.pendingMoves);
  const named = pending.length > 0 ? logicalPath(key, pending) : key;
  if (named === key) return await store.get(key);
  if (typeof isVisible !== "function" || !isVisible(named)) return null;
  return typeof store.getStillAt === "function" ? await store.getStillAt(key) : await store.get(key);
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
