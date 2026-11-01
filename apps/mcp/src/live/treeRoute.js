/**
 * `GET /presence/tree` — the app's live file tree, kept by the workspace's object
 * (`workspaceStore/treeSockets.js`; decided by the owner, 2026-11-01).
 *
 * ## It authorizes like `/presence`, and the client names nothing that matters
 *
 * Same token (the console grant, offered as a subprotocol so it never sits in
 * a URL), same session, same role clamp. The **workspace** is the one the
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
 * reads by somebody else's rules (a Tex guest chat, a pinned guest: names
 * beginning `@#`) is refused here rather than judged by the members' rules.
 *
 * ## A socket lives at most five minutes
 *
 * Then the object closes it (`TREE_CLOSE_REAUTH`) and the app reconnects
 * through here, so a membership taken away or a grant revoked stops the feed
 * within that time; a rule change reaches open sockets at once.
 */

import { resolvePresentedSession } from "../http/presentedToken.js";
import { hasScope, SCOPE_READ, SessionRefusal } from "../session.js";
import { createControlPlane } from "../controlPlane.js";
import { forbiddenResponse, unauthorizedResponse } from "../oauth.js";
import { json } from "../http/responses.js";
import { workspaceStub } from "../workspaceStore/api.js";
import { TREE_READER_HEADER } from "../workspaceStore/treeSockets.js";
import { TREE_PROTOCOL, TREE_SOCKET_MAX_MS, TREE_SOCKET_PATH } from "../../../../packages/shared/src/treeFrames.cjs";

export { TREE_SOCKET_PATH };

const MEMBER_ROLES = new Set(["owner", "editor", "member"]);

/**
 * The object's 101, naming the one subprotocol accepted, so the token offered beside it is never echoed.
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
    session = await resolvePresentedSession(request, { pathToken, path: TREE_SOCKET_PATH, slug, controlPlane });
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
  if (!MEMBER_ROLES.has(session.role) || groups.some((name) => name.startsWith("@#"))) {
    return json({ error: "forbidden" }, 403);
  }

  const stub = workspaceStub(env, session.workspaceId);
  if (stub === null) return json({ error: "tree_unavailable" }, 501);
  const expiresAt = typeof session.expiresAt === "number" ? session.expiresAt : Infinity;
  const reader = {
    scope: session.scope,
    groups,
    deadline: Math.min(expiresAt, Date.now() + TREE_SOCKET_MAX_MS),
  };
  const forwarded = new Request("https://workspace-store.internal/tree", {
    headers: { Upgrade: "websocket", [TREE_READER_HEADER]: JSON.stringify(reader) },
  });
  return withTreeProtocol(await stub.fetch(forwarded), deps.upgraded ?? upgradedResponse);
}
