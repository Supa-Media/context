/**
 * The sync status on a read of a data source's `about.md`: a `sync:` line in the read's header, saying when the source
 * last synced and what its status is (`syncLine` in `object.js`), so an agent that reads the source learns it without
 * a status call.
 *
 * The status is shown on the read, never written into the `about.md`. The about.md is a note the person edits, with
 * its own collaboration history, and the sync run writes only the sheets beside it. Nothing here is stored.
 *
 * It asks the workspace's own sync object, and only for the note the read has already judged: the reader was let to
 * read this `about.md` (its privacy, its folder, who asked), so the line answers no one who could not read it. A read
 * the store cannot address (no sync binding, no workspace), or a note that is not a data source's `about.md`, is
 * returned as it was.
 */

import { callDataSync, dataSyncStub } from "./object.js";
import { frontMatterFields } from "./about.js";
import { APPS } from "../connect/apps.js";

/** The `source:` values whose `about.md` is a data source the sync object keeps (`about.js`, `runApp.js`, `runUsage.js`). */
const SOURCE_KINDS = new Set(["url", "fetch", "usage", ...Object.keys(APPS)]);
const NOTE_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

/**
 * The store's way to its workspace's sync object, laid on the request's store where the `DATA_SYNC` binding is in
 * reach (`http/requestStore.js`). The tool layer never sees `env`, so it asks for one object by workspace id here and
 * gets `null` where there is no binding or the id is not one a workspace has.
 */
export function dataSyncStubFor(env) {
  return (workspaceId) => {
    try {
      return dataSyncStub(env, workspaceId);
    } catch {
      return null;
    }
  };
}

/**
 * How long a read waits for the sync object's answer before it goes out without the line. A read never waits on the
 * sync object for longer than this.
 */
export const SYNC_LINE_WAIT_MS = 2000;
const TIMED_OUT = Symbol("timed out");

/**
 * `read` (a `toolReadNote` result), with its `sync:` line added to the header when its note is a data source's
 * `about.md` and the sync object answers its status within `SYNC_LINE_WAIT_MS` (`options.waitMs` is for tests only).
 * Otherwise `read` itself, unchanged.
 */
export async function withSyncLine(read, store, { waitMs = SYNC_LINE_WAIT_MS } = {}) {
  if (read?.isError) return read;
  const opened = read?.opened;
  if (!opened || typeof opened.path !== "string") return read;
  if (opened.path !== "about.md" && !opened.path.endsWith("/about.md")) return read;
  if (opened.encrypted === true || typeof opened.noteId !== "string" || !NOTE_ID.test(opened.noteId)) return read;
  if (typeof opened.text !== "string") return read;
  const kind = String(frontMatterFields(opened.text).source ?? "").trim().toLowerCase();
  if (!SOURCE_KINDS.has(kind)) return read;

  // The workspace the read was addressed to: `store.actor` is set per context by the connection's own routing and by
  // `http/contextOpener.js` for a call that names another context (`context: "@name"`), so it is that workspace's id.
  const workspaceId = store?.actor?.workspaceId;
  const stub = typeof store?.dataSyncStub === "function" ? store.dataSyncStub(workspaceId) : null;
  if (stub === null || stub === undefined) return read;

  // Raced against the wait: a sync object that never answers leaves the read as it was, after `waitMs` at most.
  let timer;
  const timeout = new Promise((resolve) => {
    timer = setTimeout(() => resolve(TIMED_OUT), waitMs);
  });
  let answered;
  try {
    answered = await Promise.race([callDataSync(stub, "status", { workspaceId, noteIds: [opened.noteId] }).catch(() => null), timeout]);
  } finally {
    clearTimeout(timer);
  }
  if (answered === TIMED_OUT || answered === null) return read;
  const line = answered.status === 200 ? answered.body?.sources?.[0]?.line : undefined;
  if (typeof line !== "string") return read;

  // The header ends at the first blank line: `etag:`, `path:`, `visibility:` and the lines after them.
  const [first, ...rest] = read.content ?? [];
  if (typeof first?.text !== "string") return read;
  const end = first.text.indexOf("\n\n");
  if (end < 0) return read;
  const text = `${first.text.slice(0, end)}\nsync: ${line}${first.text.slice(end)}`;
  const result = { ...read, content: [{ ...first, text }, ...rest] };
  return Object.defineProperty(result, "opened", { value: read.opened, enumerable: false });
}
