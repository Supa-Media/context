/**
 * Dispatch for the `ws.write.*` calls (`writeOps.js`). An op runs in one storage transaction with the change it makes
 * queued for the mirror in that same transaction, so a change is queued if and only if it landed. A narrowing op
 * answers only once the mirror has the change (else 503 `MIRROR_PENDING`: the change stays queued); any other op
 * schedules a flush and answers.
 */

import { liveRowByPath } from "./rowsByPath.js";
import { WorkspaceRowRefused } from "./rows.js";
import { WRITE_OPS, WriteOpRefused } from "./writeOps.js";

const WORKSPACE_ID = /^[A-Za-z0-9_-]+$/;

export const isWriteOp = (op) => typeof op === "string" && op.startsWith("ws.write.");

/**
 * `store` is the object's `ready()` store: `{rows, sql, transact, mirror, flushMirror, mirrorSoon}`.
 * `now` is the object's clock for the change.
 */
export async function serveWrites(store, op, fields, now = Date.now()) {
  const handler = Object.hasOwn(WRITE_OPS, op) ? WRITE_OPS[op] : null;
  if (handler === null) return Response.json({ error: "unknown_op" }, { status: 400 });
  if (typeof fields.workspaceId !== "string" || fields.workspaceId.length > 64 || !WORKSPACE_ID.test(fields.workspaceId)) {
    return Response.json({ error: "bad_call" }, { status: 400 });
  }
  try {
    // The object belongs to one workspace: the first call that names one pins it, any other is refused (as every op does).
    store.rows.pinWorkspace(fields.workspaceId);
  } catch (error) {
    if (error instanceof WorkspaceRowRefused) return Response.json({ error: "refused", message: error.message }, { status: 422 });
    throw error;
  }
  let outcome;
  try {
    outcome = store.transact(() => {
      const result = handler({ rows: store.rows, access: store.access ?? null, mirrorPending: () => store.mirror.pending(1).length > 0, now, lookupLive: (path) => liveRowByPath(store.sql, path) }, fields);
      if (result.change) store.mirror.enqueue(fields.workspaceId, result.change, now);
      return result;
    });
  } catch (error) {
    if (error instanceof WriteOpRefused) return Response.json({ error: "refused", message: error.message }, { status: 422 });
    throw error;
  }
  // New rules (`ws.write.access`): the live tree's sockets re-judge what they show, as after a push's rules.
  if (outcome.rules === true && typeof store.onTreeChange === "function") {
    try {
      store.onTreeChange({ paths: null, rules: true });
    } catch {
      // The watcher catches up on its next change; the write has landed.
    }
  }
  if (outcome.narrows) {
    const flushed = await store.flushMirror();
    if (!flushed.done) return Response.json({ ok: false, code: "MIRROR_PENDING" }, { status: 503 });
  } else if (outcome.change) {
    store.mirrorSoon();
  }
  return Response.json(outcome.answer);
}
