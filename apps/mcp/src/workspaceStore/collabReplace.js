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

import { CollaborationError, replaceText } from "@context/collaboration";
import { HOMES, isRevisionKey } from "./api.js";
import { liveRowByPath } from "./rowsByPath.js";
import { objectRowId } from "./treeOps.js";
import { WRITE_OPS, WriteOpRefused } from "./writeOps.js";
import { lastWriteEach } from "./lastWrite.js";

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

const wantsRecord = (fields) => typeof fields.workspaceId === "string" && Number.isFinite(fields.record?.at);

/**
 * Serve one replacement. `store` is the object's ready store (`{rows, sql, objects}`); `fields` is
 * `{path, key, noteId, legacyEtag?, rowEtag?, expectedEtag, text, record?}`: the row's version and its old name, as the
 * id layer resolved them, and `record: {at}` to record the new version here too.
 */
export async function serveCollabReplace(store, fields) {
  // The object's own clock, which moves only across its awaits (a digest, a read): the call's time inside, without the trip.
  const started = Date.now();
  const timed = (answer) => ({ ...answer, took: Date.now() - started });
  const { path, key, noteId, expectedEtag, text } = fields ?? {};
  if (typeof path !== "string" || typeof key !== "string" || !NOTE_KEY.test(key) || typeof noteId !== "string" || !NOTE_ID.test(noteId) || typeof expectedEtag !== "string" || typeof text !== "string") {
    return { served: false, reason: "bad_call" };
  }
  const { rows, sql, objects } = store;
  if (!sql || !objects || rows.home() !== HOMES.OBJECT || typeof rows.backfilledAt() !== "number") {
    return { served: false, reason: "not_held" };
  }
  const live = liveNoteAt(sql, path);
  if (live === null || live.key !== key || live.noteId !== noteId) return { served: false, reason: "row_moved" };

  const engine = engineStore(objects, { path, key, noteId, legacyEtag: typeof fields.legacyEtag === "string" ? fields.legacyEtag : null, rowEtag: typeof fields.rowEtag === "string" ? fields.rowEtag : null });
  // Only where each key ended goes back: a save writes its document state twice, and the bucket keeps the last.
  const handedBack = () => ({ writes: lastWriteEach(engine.writes), deletes: engine.deletes });
  try {
    const result = await replaceText(engine.store, path, { expectedEtag, onlyCurrent: true, text });
    const markdown = engine.writes.filter((write) => write.key === key).at(-1) ?? null;
    const recorded = markdown !== null && wantsRecord(fields) && recordVersion(store, fields, markdown);
    return timed({ served: true, result, markdown: markdown === null ? null : { etag: markdown.etag, size: markdown.size }, recorded, ...handedBack() });
  } catch (error) {
    const held = heldBack(error);
    if (held !== null) return timed({ served: false, reason: `not_held_${held.what}`, ...handedBack() });
    if (error instanceof CollaborationError) return timed({ served: true, error: { code: error.code, message: error.message }, ...handedBack() });
    throw error;
  }
}
