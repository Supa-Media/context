/**
 * `POST /files/trash`, `/files/restore` and `/files/move`: the app's trash, restore, moves and renames, answered by
 * the workspace's object in one transaction (`workspaceStore/treeWrites.js`, `moveWrites.js`), with Convex mirrored
 * behind it and never asked on the way. `POST /files/copy` and `/files/duplicate`: the app's Copy and Duplicate of
 * one note, made by the gateway and adopted by the object as a new note (`fileCopy.js`).
 *
 * Only a workspace whose notes live in its object (`home: object`, not behind) is served here; any other answers
 * 409 `not_object`, and the app sends the same operation to the control plane's `files.trashEntry` /
 * `files.restoreTrashEntry` / `files.moveEntry` as before; so does a move the object leaves to the control plane
 * (`DEFER`). The object judges the caller by the scope, groups and user id this session
 * resolved, never by anything in the body, and a path the caller cannot see is `not_found` exactly like one that
 * does not exist.
 */

import { json } from "../http/responses.js";
import { hasScope, SCOPE_WRITE } from "../session.js";
import { normalizePath } from "../notes/paths.js";
import { copyNote, duplicateNote } from "./fileCopy.js";

export const FILE_OP_PATHS = new Set(["/files/trash", "/files/restore", "/files/move", "/files/copy", "/files/duplicate"]);

/** Copy and Duplicate: made by the gateway itself (`fileCopy.js`), the copy adopted by the object as a new note. */
const COPY_PATHS = new Set(["/files/copy", "/files/duplicate"]);

const MAX_BODY_BYTES = 8 * 1024;
const MAX_TEXT = 1024;

const text = (value) => typeof value === "string" && value !== "" && value.length <= MAX_TEXT && !value.includes("\0");

/** The object's refusal codes, as the app reads them: the status the control plane's action would have failed with. */
const REFUSALS = new Map([
  ["NOT_FOUND", [404, "not_found"]],
  ["HIDDEN", [404, "not_found"]],
  ["CHANGED", [409, "changed"]],
  ["TAKEN", [409, "taken"]],
  ["ARCHIVE_STAYS", [409, "protected"]],
  ["BUILT_IN_ARCHIVED", [409, "protected"]],
  ["UNKEYED", [409, "not_object"]],
  ["INVALID", [400, "invalid_path"]],
  // A move the control plane decides (a folder doing a job, a name twinned by case, access not yet decided here): the
  // app sends it there, as for a workspace not served by its object.
  ["DEFER", [409, "not_object"]],
]);

async function readBody(request) {
  const length = Number(request.headers.get("content-length"));
  if (Number.isFinite(length) && length > MAX_BODY_BYTES) return null;
  const bytes = new Uint8Array(await request.arrayBuffer());
  if (bytes.byteLength > MAX_BODY_BYTES) return null;
  try {
    const body = JSON.parse(new TextDecoder().decode(bytes));
    return body !== null && typeof body === "object" && !Array.isArray(body) ? body : null;
  } catch {
    return null;
  }
}

/** The body this route takes for `path`, normalised, or null. Unknown keys are refused, so nothing rides along. */
function parse(path, body) {
  if (path === "/files/trash" || path === "/files/duplicate") {
    if (path === "/files/duplicate" && Object.keys(body).some((key) => key !== "path")) return null;
    if (Object.keys(body).some((key) => key !== "path" && key !== "expectedEtag")) return null;
    const target = text(body.path) ? normalizePath(body.path) : null;
    if (!target) return null;
    if (body.expectedEtag !== undefined && !text(body.expectedEtag)) return null;
    return { path: target, ...(body.expectedEtag === undefined ? {} : { expectedEtag: body.expectedEtag }) };
  }
  const keys = path === "/files/move" ? ["from", "to", "expectedEtag"] : ["from", "to"];
  if (Object.keys(body).some((key) => !keys.includes(key))) return null;
  const from = text(body.from) ? normalizePath(body.from) : null;
  const to = text(body.to) ? normalizePath(body.to) : null;
  if (body.expectedEtag !== undefined && !text(body.expectedEtag)) return null;
  return from && to ? { from, to, ...(body.expectedEtag === undefined ? {} : { expectedEtag: body.expectedEtag }) } : null;
}

/**
 * Serves one file operation for `session` on `store` (the request's own store: its `objectReading` names the
 * workspace's object client and home). `path` is one of `FILE_OP_PATHS`.
 */
export async function handleFileOp(request, path, store, session) {
  if (request.method !== "POST") return json({ error: "method_not_allowed" }, 405);
  if (!hasScope(session, SCOPE_WRITE)) return json({ error: "forbidden" }, 403);
  const body = await readBody(request);
  if (body === null) return json({ error: "invalid_request" }, 400);
  const asked = parse(path, body);
  if (asked === null) return json({ error: "invalid_path" }, 400);

  const reading = store?.objectReading ?? null;
  if (reading === null || reading.client === null || reading.home !== "object" || reading.behind === true) {
    return json({ error: "not_object" }, 409);
  }
  if (COPY_PATHS.has(path)) return await serveCopy(path, asked, store, session);
  // The session's names are a Set (`grantedGroupsOf`), which JSON would send as `{}`: sent as a list.
  const caller = { scope: session.scope, groups: [...(session.grantedGroups ?? [])], userId: session.actorUserId ?? null };
  const write = reading.client.write;
  const answer =
    path === "/files/trash"
      ? await write.trash({ ...asked, ...caller })
      : path === "/files/move"
      ? await write.move({ ...asked, ...caller })
      : await write.restore({ ...asked, ...caller });

  if (answer?.ok === true) {
    const from = path === "/files/trash" ? asked.path : asked.from;
    const to = path === "/files/trash" ? answer.to : asked.to;
    return json({ kind: "moved", from, to, paths: [to], ...(path === "/files/move" && typeof answer.etag === "string" ? { etag: answer.etag } : {}) });
  }
  const refusal = REFUSALS.get(answer?.code);
  if (refusal !== undefined) {
    const [status, error] = refusal;
    return json({ error, ...(error === "changed" && typeof answer.currentEtag === "string" ? { currentEtag: answer.currentEtag } : {}) }, status);
  }
  // The trash committed in the object but Convex has not taken it yet (`MIRROR_PENDING`): it is queued and lands on
  // its own, so the app must not send the same trash to the control plane as well.
  if (answer?.code === "MIRROR_PENDING") return json({ error: "mirror_pending" }, 503);
  // The object refused the call's shape, or failed before it committed: nothing moved, and the app's fallback to
  // the control plane is correct.
  return json({ error: "unavailable" }, 503);
}

/** How a copy's refusals reach the app: the status the control plane's action would have failed with. */
const COPY_REFUSALS = new Map([
  ["not_found", [404, "not_found"]],
  ["taken", [409, "taken"]],
  ["invalid_path", [400, "invalid_path"]],
  ["forbidden", [403, "forbidden"]],
  // Something the control plane decides (a folder, a file that is not a note, a carried exception): sent there.
  ["defer", [409, "not_object"]],
]);

async function serveCopy(path, asked, store, session) {
  const caller = { scope: session.scope, groups: session.grantedGroups ?? new Set() };
  let answer;
  try {
    answer = path === "/files/copy" ? await copyNote(store, caller, asked.from, asked.to) : await duplicateNote(store, caller, asked.path);
  } catch {
    // Nothing was put, or a put the app's retry would find taken: the control plane's copy is the honest fallback only
    // when nothing was made, so this answers `unavailable`, which the app sends there.
    return json({ error: "unavailable" }, 503);
  }
  if (answer?.ok === true) return json({ kind: "moved", from: answer.from, to: answer.to, paths: [answer.to] });
  const [status, error] = COPY_REFUSALS.get(answer?.code) ?? [503, "unavailable"];
  return json({ error }, status);
}
