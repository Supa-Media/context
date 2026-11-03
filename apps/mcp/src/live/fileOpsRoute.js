/**
 * `POST /files/trash` and `POST /files/restore`: the app's trash and restore, answered by the workspace's object in
 * one transaction (`workspaceStore/treeWrites.js`), with Convex mirrored behind it and never asked on the way.
 *
 * Only a workspace whose notes live in its object (`home: object`, not behind) is served here; any other answers
 * 409 `not_object`, and the app sends the same operation to the control plane's `files.trashEntry` /
 * `files.restoreTrashEntry` as before. The object judges the caller by the scope, groups and user id this session
 * resolved, never by anything in the body, and a path the caller cannot see is `not_found` exactly like one that
 * does not exist.
 */

import { json } from "../http/responses.js";
import { hasScope, SCOPE_WRITE } from "../session.js";
import { normalizePath } from "../notes/paths.js";

export const FILE_OP_PATHS = new Set(["/files/trash", "/files/restore"]);

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
  if (path === "/files/trash") {
    if (Object.keys(body).some((key) => key !== "path" && key !== "expectedEtag")) return null;
    const target = text(body.path) ? normalizePath(body.path) : null;
    if (!target) return null;
    if (body.expectedEtag !== undefined && !text(body.expectedEtag)) return null;
    return { path: target, ...(body.expectedEtag === undefined ? {} : { expectedEtag: body.expectedEtag }) };
  }
  if (Object.keys(body).some((key) => key !== "from" && key !== "to")) return null;
  const from = text(body.from) ? normalizePath(body.from) : null;
  const to = text(body.to) ? normalizePath(body.to) : null;
  return from && to ? { from, to } : null;
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
  const caller = { scope: session.scope, groups: session.grantedGroups ?? [], userId: session.actorUserId ?? null };
  const answer =
    path === "/files/trash"
      ? await reading.client.write.trash({ ...asked, ...caller })
      : await reading.client.write.restore({ ...asked, ...caller });

  if (answer?.ok === true) {
    const from = path === "/files/trash" ? asked.path : asked.from;
    const to = path === "/files/trash" ? answer.to : asked.to;
    return json({ kind: "moved", from, to, paths: [to] });
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
