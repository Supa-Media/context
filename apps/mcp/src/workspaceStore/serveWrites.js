/**
 * Dispatch for the `ws.write.*` calls (`writeOps.js`). An op runs in one storage transaction with the change it makes
 * queued for the mirror in that same transaction, so a change is queued if and only if it landed. A narrowing op
 * answers only once the mirror has the change (else 503 `MIRROR_PENDING`: the change stays queued); any other op
 * schedules a flush and answers.
 */

import { liveRowByPath } from "./rowsByPath.js";
import { objectRowId } from "./treeOps.js";
import { WorkspaceRowRefused } from "./rows.js";
import { WRITE_OPS, WriteOpRefused } from "./writeOps.js";
import { committed } from "./committed.js";

const WORKSPACE_ID = /^[A-Za-z0-9_-]+$/;

/** The write whose answer carries its own time (`took`) and its durable-write wait (`commit`). */
const TIMED_OP = "ws.write.move";

export const isWriteOp = (op) => typeof op === "string" && op.startsWith("ws.write.");

/**
 * Run one write op in a storage transaction, queuing each change it makes for the mirror in that same transaction.
 * Throws `WriteOpRefused` for a call the op refuses. Also run by a call that writes bytes first (`createNote.js`).
 */
export function runWriteOp(store, handler, fields, now = Date.now(), mintId = objectRowId) {
  const result = store.transact(() => {
    const result = handler(
      {
        rows: store.rows,
        sql: store.sql,
        members: store.members ?? null,
        access: store.access ?? null,
        handles: store.handles ?? null,
        mirrorPending: () => store.mirror.pending(1).length > 0,
        now,
        lookupLive: (path) => liveRowByPath(store.sql, path),
        mintId,
      },
      fields,
    );
    // An op that makes more than one change (a move and its narrowing) hands them over in order as `changes`.
    for (const change of changesOf(result)) store.mirror.enqueue(fields.workspaceId, change, now);
    return result;
  });
  // Committed: the app's live tree hears of it here, once for every write op, as it does of a row pushed in
  // (`serve.js`). The object is the tree's only source while it serves it, so a write it is not told of stays drawn.
  treeChanged(store, result);
  return result;
}

const changesOf = (result) => result.changes ?? (result.change ? [result.change] : []);
const ancestorsOf = (path) => path.split("/").slice(0, -1).map((_, index, parts) => parts.slice(0, index + 1).join("/"));

/**
 * Every path a landed change named, before and after: a move's both ends, the folders it stood up, the note it
 * adopted or wrote. A change that removed rows (folders a move emptied, an erase) names only their ids, and every
 * row it removed sits above a path it moved, so their ancestors are listed again too.
 */
export function pathsOfChange(change) {
  const record = change?.record ?? {};
  const paths = [];
  for (const move of record.moves ?? []) paths.push(move.from, move.to);
  for (const folder of record.folders ?? []) paths.push(folder.path);
  if (typeof record.path === "string") paths.push(record.path);
  const named = paths.filter((path) => typeof path === "string" && path !== "");
  if ((record.removed ?? []).length > 0) named.push(...named.flatMap(ancestorsOf));
  return named;
}

/** Tell the tree's watchers what a committed op changed; never the op's failure. */
function treeChanged(store, result) {
  if (typeof store.onTreeChange !== "function") return;
  // New rules re-judge everything a socket shows (`ws.write.access`), as after a push's rules.
  const change = result.rules === true ? { paths: null, rules: true } : { paths: [...new Set(changesOf(result).flatMap(pathsOfChange))], rules: false };
  if (change.paths !== null && change.paths.length === 0) return;
  try {
    store.onTreeChange(change);
  } catch {
    // The watcher catches up on its next change; the write has landed.
  }
}

/**
 * `store` is the object's `ready()` store: `{rows, sql, transact, mirror, flushMirror, mirrorSoon}`.
 * `now` is the object's clock for the change.
 */
export async function serveWrites(store, op, fields, now = Date.now(), mintId = objectRowId) {
  const started = Date.now();
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
    outcome = runWriteOp(store, handler, fields, now, mintId);
  } catch (error) {
    if (error instanceof WriteOpRefused) return Response.json({ error: "refused", message: error.message }, { status: 422 });
    throw error;
  }
  if (outcome.narrows) {
    const flushed = await store.flushMirror();
    // The change landed and stays queued; its answer goes back beside the code, for a caller that must keep what it
    // says (an erase's files, which the bucket half deletes).
    if (!flushed.done) return Response.json({ ok: false, code: "MIRROR_PENDING", answer: outcome.answer }, { status: 503 });
  } else if (outcome.change || outcome.changes?.length > 0) {
    store.mirrorSoon();
  }
  if (op === TIMED_OP && outcome.answer?.ok === true) {
    // A move's own time and its wait for durable writes (`createNote.js` `committed`), for the move's timings: the
    // answer waits for those writes anyway (the output gate), so waiting here adds nothing.
    // Without a way to wait for its writes (a test's store) the object's clock does not move, so it says nothing.
    const commit = await committed(store);
    if (commit !== null) return Response.json({ ...outcome.answer, took: Date.now() - started, commit });
  }
  return Response.json(outcome.answer);
}
