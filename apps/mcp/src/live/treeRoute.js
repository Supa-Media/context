/**
 * `GET /presence/tree` — the app's live file tree, kept by the workspace's object
 * (`workspaceStore/treeSockets.js`; decided by the owner, 2026-11-01).
 *
 * ## It authorizes like `/presence`, and the client names nothing that matters
 *
 * Same token (the console grant, behind a one-use ticket offered as a
 * subprotocol: `live/ticket.js`), same session, same role clamp. The **workspace** is the one the
 * grant resolved to, never one the URL names beyond the slug selector the
 * session already checked. The **reader** (scope, group names, deadline) is
 * written here into one header on a request built from nothing, so no header
 * the client sent (its own `x-tree-reader` above all) reaches the object.
 * The client names only folders to watch, and every folder is judged at the
 * reader's clearance inside the object.
 *
 * ## Members only, as the console's tree is
 *
 * The Convex tree asks `resolveFileAccess` for `member` at least. A grant that
 * reads by somebody else's rules (a Tex guest chat, a pinned guest: their
 * markers, `readsByOtherRules`) is refused here rather than judged by the
 * members' rules. A row's token (`@#<noteId>`) is a member's own name for a
 * note shared to them by name or a Tex chat home they are in, and is carried
 * to the object (2026-11-02: refusing every `@#` name sent anyone holding one
 * to the Convex tree, and the person object's session, which held none, hid
 * every chat home).
 *
 * ## A socket lives at most five minutes
 *
 * Then the object closes it (`TREE_CLOSE_REAUTH`) and the app reconnects
 * through here, so a membership taken away or a grant revoked stops the feed
 * within that time; a rule change reaches open sockets at once.
 */

import { resolvePresentedSession } from "../http/presentedToken.js";
import { hasScope, SCOPE_READ, SessionRefusal } from "../session.js";
import { readsByOtherRules } from "./readerNames.js";
import { createControlPlane } from "../controlPlane.js";
import { forbiddenResponse, unauthorizedResponse } from "../oauth.js";
import { json } from "../http/responses.js";
import { workspaceStub } from "../workspaceStore/api.js";
import { TREE_READER_HEADER } from "../workspaceStore/treeSockets.js";
import { TREE_PROTOCOL, TREE_SOCKET_MAX_MS, TREE_SOCKET_PATH } from "../../../../packages/shared/src/treeFrames.cjs";

export { TREE_SOCKET_PATH };

const MEMBER_ROLES = new Set(["owner", "editor", "member"]);

/**
 * The object's 101, naming the one subprotocol accepted, so the ticket offered beside it is never echoed.
 * `upgraded` builds the answer (Node's `Response` cannot hold a 101, so tests pass their own).
 */
function withTreeProtocol(response, upgraded) {
  if (response.status !== 101) return response;
  const headers = new Headers(response.headers);
  headers.set("Sec-WebSocket-Protocol", TREE_PROTOCOL);
  return upgraded(headers, response.webSocket);
}

const upgradedResponse = (headers, webSocket) => new Response(null, { status: 101, headers, webSocket });

export async function handleTree(request, env, { slug, pathToken, origin }, deps = {}) {
  if (request.method !== "GET") return new Response(null, { status: 405 });
  if ((request.headers.get("Upgrade") || "").toLowerCase() !== "websocket") {
    return new Response("expected a websocket upgrade", { status: 426 });
  }
  // A deployment without workspace objects says so; the app reads the tree from Convex as before.
  if (!env.WORKSPACE_STORE) return json({ error: "tree_unavailable" }, 501);

  const controlPlane = deps.controlPlane ?? createControlPlane(env);
  let session;
  try {
    session = await resolvePresentedSession(request, { pathToken, path: TREE_SOCKET_PATH, slug, controlPlane, env });
  } catch (error) {
    if (!(error instanceof SessionRefusal)) throw error;
    return error.status === 403 ? forbiddenResponse(origin, null, error) : unauthorizedResponse(origin, slug, error);
  }
  if (!hasScope(session, SCOPE_READ)) {
    return forbiddenResponse(origin, null, {
      description: `This connection does not hold the ${SCOPE_READ} scope.`,
      scope: [SCOPE_READ],
    });
  }
  const groups = [...(session.grantedGroups ?? [])];
  if (!MEMBER_ROLES.has(session.role) || readsByOtherRules(session)) {
    return json({ error: "forbidden" }, 403);
  }

  const stub = workspaceStub(env, session.workspaceId);
  if (stub === null) return json({ error: "tree_unavailable" }, 501);
  const expiresAt = typeof session.expiresAt === "number" ? session.expiresAt : Infinity;
  // A tree change the control plane committed and has not pushed to the object yet -- a share just taken back --
  // would be served from the object's older rows, and this route holds no binding to read `notesBehind` from
  // (opening one decrypts a storage credential for one boolean). `objectBehind` is that boolean: one indexed read
  // there, the gateway secret only, and anything but a clear false counts as behind. The object then answers
  // `not_served`, so the app reads the Convex tree, which has the change.
  let behind = true;
  try {
    behind = await controlPlane.objectBehind(session.workspaceId);
  } catch {
    behind = true;
  }
  const reader = {
    scope: session.scope,
    groups,
    deadline: Math.min(expiresAt, Date.now() + TREE_SOCKET_MAX_MS),
    ...(behind ? { behind: true } : {}),
    // Who is reading, for an object that decides access from its own members (`workspaceStore/members.js`).
    ...(typeof session.actorUserId === "string" ? { userId: session.actorUserId } : {}),
  };
  const forwarded = new Request("https://workspace-store.internal/tree", {
    headers: { Upgrade: "websocket", [TREE_READER_HEADER]: JSON.stringify(reader) },
  });
  return withTreeProtocol(await stub.fetch(forwarded), deps.upgraded ?? upgradedResponse);
}
