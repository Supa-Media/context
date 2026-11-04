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
 *
 * `checks: true` (a save that skipped its own find and name checks, `tools/notes/write.js`): before anything is
 * written, the call is declined (`{served: false, reason}`, nothing written) wherever those checks could have said
 * anything: a row already at the path or a file on its way, a name on its way that differs from a live one only by
 * case, or a top-level name with no row yet (a new top-level folder or root file, whose role the control plane's
 * guards judge). The gateway then saves the note the long way. Wider than the gateway's own checks, which judge only
 * what the caller can see, so a decline never stands for an answer.
 */

import { HOMES } from "./api.js";
import { WRITE_OPS, WriteOpRefused } from "./writeOps.js";
import { runWriteOp } from "./serveWrites.js";
import { committed } from "./committed.js";
import { isNoteId } from "../store/noteIdKeys.js";
import { liveRowByPath } from "./rowsByPath.js";

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

  if (fields.checks === true) {
    const declined = checksDecline(sql, path);
    if (declined !== null) return timed({ served: false, reason: declined });
  }
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
  if ((outcome.change || outcome.changes?.length > 0) && typeof store.mirrorSoon === "function") {
    // Set before the durable-write wait, so one flush carries the alarm too (`serveWrites.js`).
    await store.mirrorSoon();
  }
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


/** Why a checked create is not this object's to make alone (see the module note), or `null`. */
function checksDecline(sql, path) {
  const segments = path.split("/");
  if (segments.length < 2 || segments.some((segment) => segment === "")) return "top_level";
  for (let depth = 1; depth <= segments.length; depth += 1) {
    const here = segments.slice(0, depth).join("/");
    const row = liveRowByPath(sql, here);
    if (depth === segments.length) {
      if (row !== null) return "taken";
    } else if (row !== null && row.kind !== "folder") {
      return "parent_file";
    } else if (depth === 1 && row === null) {
      return "top_level";
    }
    const twins = sql.exec("SELECT path FROM ws_rows WHERE gone = 0 AND lower(path) = lower(?) LIMIT 5", here).toArray();
    if (twins.some((twin) => twin.path !== here)) return "twin";
  }
  return null;
}
