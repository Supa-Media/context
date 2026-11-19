/**
 * `ws.collab.replace`: a whole-note save's editing history, run inside the workspace object in one call.
 *
 * The collaboration engine (`@context/collaboration` `replaceText`) makes about seven dependent storage round trips
 * per save: the head, the Markdown and the document's state, the current revision, the new revision, the state's
 * compare-and-swap, the Markdown, and the state again. From the gateway each one is a trip to this object. Run here,
 * against the object's own SQLite, they are local reads and writes, and the gateway waits for one call.
 *
 * The engine is the same code with the same conditional writes, so etag conflict safety is unchanged: a version
 * that moved is a `CONFLICT`, and a lost compare-and-swap is retried as it is on the gateway.
 *
 * Served only where the object holds everything the engine may read: home `object`, backfilled, and the live row at
 * the path is the note the gateway resolved (same key and note id). The object's copies are plain either way; a
 * keyed workspace's data key seals only the bucket's backup copy, which the gateway writes.
 * Anything else answers `{served: false}` and the gateway runs the engine itself, as before. So does a saved version
 * this object no longer keeps (the bucket keeps every one; this object only its current ones): what was written by
 * then is handed back too, so the gateway still copies it to the bucket.
 *
 * Every write is handed back (`writes`, `deletes`) for the bucket's backup copy, which only the gateway can reach.
 *
 * A call that brings `record: {at}` (a member's save, whose version report would have come to this object anyway:
 * `store/objectLookup.js` `wrote`) also has the new Markdown version recorded on its row here, as `ws.write.wrote`
 * records it, with the change queued for the control plane's mirror in the same transaction (`serveWrites.js`). The
 * answer says `recorded: true`, and the gateway sends no second call. Anything short of that answers `recorded: false`
 * and the gateway reports the version as before.
 */

import { CollaborationError, commitUpdate, replaceText } from "@context/collaboration";
import { etagHex } from "../texStore/sha256.js";
import { HOMES, isRevisionKey } from "./api.js";
import { liveRowByPath } from "./rowsByPath.js";
import { objectRowId } from "./treeOps.js";
import { WRITE_OPS, WriteOpRefused } from "./writeOps.js";
import { lastWriteEach } from "./lastWrite.js";

/** A flush whose live rows moved while the save was computed. The transaction rolls back; the save runs again. */
class FlushConflict extends Error {}

const encoder = new TextEncoder();

/** Whether `meta` (or none) passes `onlyIf`, as `texStore/objects.js` `passes` does. */
function passes(meta, onlyIf) {
  if (!onlyIf || typeof onlyIf !== "object") return true;
  const { etagMatches, etagDoesNotMatch } = onlyIf;
  if (typeof etagMatches === "string") {
    if (meta === null) return false;
    if (etagMatches !== "*" && etagMatches.replace(/"/g, "") !== meta.etag) return false;
  }
  if (typeof etagDoesNotMatch === "string") {
    if (etagDoesNotMatch === "*") return meta === null;
    if (meta !== null && etagDoesNotMatch.replace(/"/g, "") === meta.etag) return false;
  }
  return true;
}

/**
 * The engine's object store, with its writes held until `flush` lands them in one storage transaction.
 *
 * Each `put` used to commit on its own: the engine awaits between them, and a Durable Object commits at an await, so
 * a save waited out three durable commits (production, 2026-11-17: `obj:ws.collab.replace` median 451 ms, and the
 * object's own clock on the work read 0 — the wait is the commits after the handler). Held here, the same writes
 * commit once. A row that moved meanwhile fails the whole flush, and the save is computed again.
 */
function heldObjects(objects) {
  const ops = [];
  // The open put of each key: the one a later put to it (with no delete of it between) folds into.
  const openPut = new Map();
  const overlay = new Map();
  let landed = [];
  const liveHead = (key) => {
    if (overlay.has(key)) {
      const held = overlay.get(key);
      return held.deleted ? null : { etag: held.etag, size: held.size };
    }
    const head = typeof objects.head === "function" ? objects.head(key) : null;
    return head;
  };
  const api = {
    get(key, options = {}) {
      if (overlay.has(key)) {
        const held = overlay.get(key);
        if (held.deleted) return null;
        const meta = { key, etag: held.etag, size: held.size };
        if (!passes(meta, options.onlyIf)) return meta;
        return { ...meta, body: held.body };
      }
      return objects.get(key, options);
    },
    head(key) {
      if (overlay.has(key)) {
        const held = overlay.get(key);
        return held.deleted ? null : { key, etag: held.etag, size: held.size };
      }
      return objects.head(key);
    },
    async put(key, value, options = {}) {
      const bytes = typeof value === "string" ? encoder.encode(value) : value instanceof Uint8Array ? value : encoder.encode(String(value ?? ""));
      const existing = liveHead(key);
      if (!passes(existing, options.onlyIf)) return null;
      const etag = etagHex(bytes);
      overlay.set(key, { etag, size: bytes.byteLength, body: bytes, deleted: false });
      // A later put folds into the open one: it lands once, where the first landed, with the first's `onlyIf`. Equivalent
      // in one transaction, since the later `onlyIf` was checked against the first's etag above.
      const open = openPut.get(key);
      if (open) {
        open.bytes = bytes;
        open.etag = etag;
      } else {
        const op = { op: "put", key, bytes, etag, onlyIf: options.onlyIf };
        ops.push(op);
        openPut.set(key, op);
      }
      return { etag, size: bytes.byteLength };
    },
    delete(keys) {
      const list = Array.isArray(keys) ? keys : [keys];
      for (const key of list) {
        overlay.set(key, { deleted: true });
        openPut.delete(key);
      }
      ops.push({ op: "delete", keys: list });
    },
  };
  return {
    api,
    ops,
    /** The puts that landed, once `flush` is `"ok"`: one per key, with the bytes it ended with. */
    landedPuts() {
      return landed;
    },
    /** Land every held write, or `"conflict"` when a row moved. One transaction when `transact` is given. */
    flush(transact) {
      if (ops.length === 0) return "empty";
      let applied = [];
      const apply = () => {
        const puts = [];
        for (const op of ops) {
          if (op.op === "delete") {
            objects.delete(op.keys);
            continue;
          }
          const written = objects.putPrepared(op.key, op.bytes, op.etag, op.onlyIf ? { onlyIf: op.onlyIf } : {});
          if (written === null) throw new FlushConflict();
          puts.push(op);
        }
        applied = puts;
      };
      try {
        if (typeof transact === "function") transact(apply);
        else apply();
        landed = applied;
        return "ok";
      } catch (error) {
        if (error instanceof FlushConflict) return "conflict";
        throw error;
      }
    },
  };
}

const COLLABORATION_ROOT = ".context/collaboration/";
const NOTE_KEY = /^notes\/[A-Za-z0-9-]{1,128}\.md$/;
const NOTE_ID = /^[A-Za-z0-9-]{1,128}$/;

/**
 * Thrown inside the engine when the object cannot answer a read the bucket could. Never leaves this file. `what` is
 * which read it was (`version`, `key` or `listing`), said in the answer's reason so a save's timings show it.
 */
class NotHeldHere extends Error {
  constructor(message, what) {
    super(message);
    this.what = what;
  }
}

/** The `NotHeldHere` that `error` is, or was caused by (the engine wraps storage errors), or `null`. */
function heldBack(error) {
  for (let seen = error, depth = 0; seen && depth < 8; seen = seen.cause, depth += 1) if (seen instanceof NotHeldHere) return seen;
  return null;
}

/** Whether `error`, or anything it was caused by, is `NotHeldHere`. */
export function notHeldHere(error) {
  return heldBack(error) !== null;
}

/** The live row at `path` with its note id, from the object's own rows. */
function liveNoteAt(sql, path) {
  const cursor = sql.exec("SELECT note_id, storage_key FROM ws_rows WHERE path = ? AND gone = 0 ORDER BY id LIMIT 1", path);
  const row = typeof cursor?.toArray === "function" ? cursor.toArray()[0] : undefined;
  return row ? { noteId: row.note_id ?? null, key: row.storage_key ?? null } : null;
}

/**
 * The engine's store over this object's objects: the note's path is its key, the history keys are themselves, and
 * nothing else is reachable. Each write is recorded for the bucket.
 */
export function engineStore(objects, { path, key, noteId, legacyEtag = null, rowEtag = null }) {
  const writes = [];
  const deletes = [];
  const keyOf = (asked) => {
    if (asked === path) return key;
    if (typeof asked === "string" && asked.startsWith(COLLABORATION_ROOT)) return asked;
    throw new NotHeldHere("a key outside this note's history", "key");
  };
  const decoder = new TextDecoder();
  const store = {
    // As the gateway's store over this object says of itself (`store/r2.js`): no atomic conditional delete.
    capabilities: { conditionalWrite: true, conditionalCreate: true, conditionalDelete: false },
    noteIdAt: async (asked) => (asked === path ? noteId : null),
    async get(asked) {
      const stored = objects.get(keyOf(asked));
      if (stored === null) {
        // Older saved versions live in the bucket alone once pruned here (`workspaceRouting.js`): the gateway asks it.
        if (isRevisionKey(asked)) throw new NotHeldHere("a saved version this object no longer keeps", "version");
        return null;
      }
      const body = stored.body ?? new Uint8Array(0);
      return { key: asked, etag: stored.etag, size: stored.size, text: async () => decoder.decode(body), arrayBuffer: async () => body.slice().buffer };
    },
    async head(asked) {
      const meta = objects.head(keyOf(asked));
      if (meta === null && isRevisionKey(asked)) throw new NotHeldHere("a saved version this object no longer keeps", "version");
      return meta;
    },
    async put(asked, value, options = {}) {
      const target = keyOf(asked);
      const condition = options?.onlyIf;
      let onlyIf;
      if (condition?.absent === true) onlyIf = { etagDoesNotMatch: "*" };
      else if (typeof condition?.etagMatches === "string") {
        // A version read before the note had a key names it by its old etag while the row's version has not moved
        // since: compared as the row's version, exactly as the id layer compares it (`keyedExpectation`).
        const expected = target === key && legacyEtag !== null && rowEtag !== null && condition.etagMatches === legacyEtag && condition.etagMatches !== rowEtag ? rowEtag : condition.etagMatches;
        onlyIf = { etagMatches: expected };
      }
      const text = typeof value === "string" ? value : decoder.decode(value);
      const written = await objects.put(target, text, onlyIf ? { onlyIf } : {});
      if (written === null) return null;
      writes.push({ key: target, body: text, etag: written.etag, size: written.size });
      return { etag: written.etag };
    },
    async delete(keys) {
      const list = (Array.isArray(keys) ? keys : [keys]).map(keyOf);
      objects.delete(list);
      deletes.push(...list);
    },
    async list() {
      throw new NotHeldHere("a listing, which the bucket answers", "listing");
    },
  };
  return { store, writes, deletes };
}

/** Record the save's new Markdown version on its row, as `ws.write.wrote` does: whether it was. Never fails the save. */
function recordVersion(store, fields, markdown) {
  const { rows, sql, transact, mirror } = store;
  if (typeof transact !== "function" || typeof mirror?.enqueue !== "function") return false;
  const body = { path: fields.path, key: fields.key, etag: markdown.etag, size: markdown.size, at: fields.record.at, keyed: true };
  const now = Date.now();
  try {
    const outcome = transact(() => {
      const result = WRITE_OPS["ws.write.wrote"]({ rows, sql, members: store.members ?? null, now, lookupLive: (path) => liveRowByPath(sql, path), mintId: objectRowId }, body);
      if (result.change) mirror.enqueue(fields.workspaceId, result.change, now);
      return result;
    });
    if (outcome.change && typeof store.mirrorSoon === "function") store.mirrorSoon();
    return outcome.answer?.ok === true;
  } catch (error) {
    if (error instanceof WriteOpRefused) return false;
    throw error;
  }
}

/**
 * What a save landed, in bytes and counts, never what: the note's Markdown, its document state (which carries the
 * editing history's snapshot), every byte landed, and how many writes landed (two on a save that won its first try:
 * the state and the Markdown, plus one more when an idle version file is kept; more means it retried against another
 * writer). `puts` are the flush's landed puts, one per key.
 */
function sizesOf(puts, key) {
  const bytes = (put) => put?.bytes.byteLength ?? 0;
  const state = puts.filter((put) => put.key.startsWith(`${COLLABORATION_ROOT}v1/documents/`) && !put.key.includes("/operations/")).at(-1);
  return {
    note: bytes(puts.filter((put) => put.key === key).at(-1)),
    state: bytes(state),
    written: puts.reduce((sum, put) => sum + bytes(put), 0),
    writes: puts.length,
  };
}

const wantsRecord = (fields) => typeof fields.workspaceId === "string" && Number.isFinite(fields.record?.at);

/**
 * Serve one replacement. `store` is the object's ready store (`{rows, sql, objects}`); `fields` is
 * `{path, key, noteId, legacyEtag?, rowEtag?, expectedEtag, text, onlyCurrent?, record?}`: the row's version and its
 * old name, as the id layer resolved them, and `record: {at}` to record the new version here too. `onlyCurrent`
 * defaults to true (an agent's whole-note write); the app's exact-base replacement (`/collaboration`) sends false and
 * keeps its merge.
 */
export async function serveCollabReplace(store, fields) {
  const { expectedEtag, text } = fields ?? {};
  if (typeof expectedEtag !== "string" || typeof text !== "string") return { served: false, reason: "bad_call" };
  const onlyCurrent = fields.onlyCurrent !== false;
  return await serveInObject(store, fields, (engine, path) => replaceText(engine, path, { expectedEtag, onlyCurrent, text }));
}

/**
 * Serve one live edit: a Yjs update the app's editor sent (`/collaboration`), committed by the engine here, so typing
 * and every read of the note's history run in this object one call at a time (Dev2, 2026-11-11). `fields` is
 * `{path, key, noteId, documentId, update, record?}`.
 */
export async function serveCollabCommit(store, fields) {
  const { documentId, update } = fields ?? {};
  if (typeof documentId !== "string" || documentId === "" || typeof update !== "string" || update === "") return { served: false, reason: "bad_call" };
  return await serveInObject(store, fields, (engine, path) => commitUpdate(engine, path, { documentId, update }));
}

/** One engine call over this object's own storage for the note `fields` names, with what it wrote handed back. */
async function serveInObject(store, fields, run) {
  // The object's own clock, which moves only across its awaits (a digest, a read): the call's time inside, without the trip.
  const started = Date.now();
  // How long the call waited before it ran: queued behind the object's other work, and on the way here. By two
  // clocks, the gateway's and this object's, so a rough figure; a negative one is clock skew and reads as 0.
  const waited = Number.isFinite(fields?.sentAt) ? Math.max(0, Math.min(started - fields.sentAt, 600_000)) : null;
  const timed = (answer) => ({ ...answer, took: Date.now() - started, ...(waited === null ? {} : { waited }) });
  const { path, key, noteId } = fields ?? {};
  if (typeof path !== "string" || typeof key !== "string" || !NOTE_KEY.test(key) || typeof noteId !== "string" || !NOTE_ID.test(noteId)) {
    return { served: false, reason: "bad_call" };
  }
  const { rows, sql, objects } = store;
  if (!sql || !objects || rows.home() !== HOMES.OBJECT || typeof rows.backfilledAt() !== "number") {
    return { served: false, reason: "not_held" };
  }
  const live = liveNoteAt(sql, path);
  if (live === null || live.key !== key || live.noteId !== noteId) return { served: false, reason: "row_moved" };

  // A save that loses a race against another writer is computed again. Three is the engine's own bound for one attempt
  // (`MAX_RETRIES` there covers a retry inside the attempt); past that the caller is told it was a conflict.
  for (let attempt = 0; attempt < 3; attempt += 1) {
    const held = heldObjects(objects);
    const engine = engineStore(held.api, { path, key, noteId, legacyEtag: typeof fields.legacyEtag === "string" ? fields.legacyEtag : null, rowEtag: typeof fields.rowEtag === "string" ? fields.rowEtag : null });
    // Only where each key ended goes back: the bucket keeps the last write of each key the engine made.
    // Nothing is handed back until the flush commits: a refused save wrote nothing.
    const handedBack = () => ({ writes: lastWriteEach(engine.writes), deletes: engine.deletes });
    try {
      const result = await run(engine.store, path);
      if (held.flush(store.transact) === "conflict") continue;
      const markdown = engine.writes.filter((write) => write.key === key).at(-1) ?? null;
      const recorded = markdown !== null && wantsRecord(fields) && recordVersion(store, fields, markdown);
      return timed({ served: true, result, markdown: markdown === null ? null : { etag: markdown.etag, size: markdown.size }, recorded, sizes: sizesOf(held.landedPuts(), key), ...handedBack() });
    } catch (error) {
      const missed = heldBack(error);
      if (missed !== null) return timed({ served: false, reason: `not_held_${missed.what}`, writes: [], deletes: [] });
      if (error instanceof CollaborationError) return timed({ served: true, error: { code: error.code, message: error.message }, writes: [], deletes: [] });
      throw error;
    }
  }
  return timed({ served: true, error: { code: "CONFLICT", message: "collaboration state kept changing during replacement" }, writes: [], deletes: [] });
}
