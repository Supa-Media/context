/**
 * `ws.create`: a new note's bytes and its row, made inside the workspace object in one call.
 *
 * A new note took three trips to this object one after another: its bytes at its id key (`put`), its row
 * (`ws.write.adopt`), and the reads around them. About 126 ms of a 195 ms save in production (2026-11-03). Here the
 * bytes are written with the same `absent` condition the gateway's put carries, and the row is adopted by the same op
 * (`writeOps.js` `adopt`), in a transaction with its mirror entry (`serveWrites.js` `runWriteOp`).
 *
 * What it answers, so the gateway does what it did before for every case but the plain one:
 * - `{served: false, reason}`: nothing was written here (not held here, a bad call, the key already held). The gateway
 *   writes the note as before.
 * - `{served: true, etag, size, adopted: true}`: both landed. The row's change is queued for the control plane.
 * - `{served: true, etag, size, adopted: false, reason}`: the bytes landed and the adoption is the control plane's
 *   (`DEFER`, the same reasons `ws.write.adopt` gives). The gateway asks it, as it did after its own put.
 *
 * Every write is handed back (`writes`) for the bucket's backup copy, which only the gateway can reach.
 */

import { HOMES } from "./api.js";
import { WRITE_OPS, WriteOpRefused } from "./writeOps.js";
import { runWriteOp } from "./serveWrites.js";
import { isNoteId } from "../store/noteIdKeys.js";

const NOTE_KEY = /^notes\/[A-Za-z0-9-]{1,128}\.md$/;
const WORKSPACE_ID = /^[A-Za-z0-9_-]{1,64}$/;
const MAX_PATH = 1024;

/** The metadata a put may carry, as the gateway's store passes it to this object's objects. */
function metadataOf(fields) {
  const contentType = typeof fields.contentType === "string" && fields.contentType.length <= 256 ? fields.contentType : null;
  return contentType === null ? {} : { httpMetadata: { contentType } };
}

/**
 * Serve one new note. `store` is the object's ready store (`{rows, sql, objects, transact, mirror, mirrorSoon}`);
 * `fields` is `{workspaceId, path, noteId, key, text, tier, at, contentType?}`.
 */
export async function serveCreateNote(store, fields) {
  const started = Date.now();
  const timed = (answer) => ({ ...answer, took: Date.now() - started });
  const { workspaceId, path, noteId, key, text, tier, at } = fields ?? {};
  if (
    typeof workspaceId !== "string" || !WORKSPACE_ID.test(workspaceId) ||
    typeof path !== "string" || path === "" || path.length > MAX_PATH ||
    !isNoteId(noteId) || typeof key !== "string" || !NOTE_KEY.test(key) ||
    typeof text !== "string" || (tier !== "private" && tier !== "team") || !Number.isFinite(at)
  ) {
    return { served: false, reason: "bad_call" };
  }
  const { rows, sql, objects } = store;
  if (!sql || !objects || typeof store.transact !== "function" || typeof store.mirror?.enqueue !== "function") return { served: false, reason: "not_held" };
  if (rows.home() !== HOMES.OBJECT || typeof rows.backfilledAt() !== "number") return { served: false, reason: "not_held" };

  // The key is a fresh id: somebody already at it is the gateway's to name (`NoteCreateRaced`), from its own put.
  const written = await objects.put(key, text, { ...metadataOf(fields), onlyIf: { etagDoesNotMatch: "*" } });
  if (written === null) return timed({ served: false, reason: "key_held" });
  const writes = [{ key, body: text }];

  let outcome;
  try {
    outcome = runWriteOp(store, WRITE_OPS["ws.write.adopt"], { workspaceId, path, noteId, key, etag: written.etag, size: written.size, at, tier });
  } catch (error) {
    if (!(error instanceof WriteOpRefused)) throw error;
    outcome = { answer: { ok: false, code: "DEFER", reason: "refused" } };
  }
  if ((outcome.change || outcome.changes?.length > 0) && typeof store.mirrorSoon === "function") store.mirrorSoon();
  const commit = await committed(store);
  const adopted = outcome.answer?.ok === true && outcome.answer.adopted === true;
  return timed({
    served: true,
    etag: written.etag,
    size: written.size,
    adopted,
    ...(adopted ? {} : { reason: typeof outcome.answer?.reason === "string" ? outcome.answer.reason : "deferred" }),
    writes,
    ...(commit === null ? {} : { commit }),
  });
}

/**
 * How long the object's storage took to make this call's writes durable (`store.settle`, the Durable Object's
 * `storage.sync()`), or `null` where it cannot say. The answer waits for that anyway (the output gate), so waiting here
 * moves the wait without adding to it, and a Durable Object's clock only moves across a wait like this one: the call's
 * own time (`took`) reads 0 without it.
 */
async function committed(store) {
  if (typeof store.settle !== "function") return null;
  const at = Date.now();
  try {
    await store.settle();
  } catch {
    return null;
  }
  return Date.now() - at;
}
