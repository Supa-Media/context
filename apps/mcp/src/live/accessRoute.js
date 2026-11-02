/**
 * `GET /presence/access` — the app's members, invitations, connected apps and
 * "shared with me" screens, read and written in the objects that hold who may
 * reach what (decided by the owner, 2026-11-01;
 * `/mnt/project-files/workspace-access/plan.md`, thread F). The object side is
 * `workspaceStore/accessSockets.js`; the frames are `accessFrames.cjs`.
 *
 * ## It authorizes like `/presence/tree`, and the client names nothing that matters
 *
 * Same token (the console grant, offered as a subprotocol so it never sits in
 * a URL), same session, same role clamp. `?of=` picks one of two objects, and
 * both are read off the session, never off the request:
 * - `workspace`: the workspace the grant resolved to;
 * - `person`: the signed-in person's own personal workspace.
 * The **reader** (side, person, role, scope, deadline) is written here into one
 * header on a request built from nothing, so no header the client sent reaches
 * the object.
 *
 * ## The app's own client only
 *
 * These screens remove members, revoke connections and accept invitations, and
 * name every app a person connected. Today those are Convex calls only the
 * signed-in app can make, so an MCP client holding a grant is refused here
 * rather than handed a new power: only the console's client (`context_console`)
 * opens this socket. Tex guest grants (`@#` names) are refused as on the tree.
 *
 * ## A socket lives at most five minutes
 *
 * Then the object closes it and the app reconnects through here, so a grant
 * revoked or a membership taken away stops the feed within that time; a write
 * that removes somebody closes their sockets at once.
 */

import { resolvePresentedSession } from "../http/presentedToken.js";
import { hasScope, SCOPE_READ, SessionRefusal } from "../session.js";
import { createControlPlane } from "../controlPlane.js";
import { forbiddenResponse, unauthorizedResponse } from "../oauth.js";
import { json } from "../http/responses.js";
import { workspaceStub } from "../workspaceStore/api.js";
import { ACCESS_READER_HEADER } from "../workspaceStore/accessSockets.js";
import {
  ACCESS_PROTOCOL,
  ACCESS_SOCKET_MAX_MS,
  ACCESS_SOCKET_PATH,
  isSide,
} from "../../../../packages/shared/src/accessFrames.cjs";

export { ACCESS_SOCKET_PATH };

/** The app's own client (`CONSOLE_CLIENT_ID` in `apps/convex/functions/agentGrant.ts`). */
const CONSOLE_CLIENT_ID = "context_console";
const MEMBER_ROLES = new Set(["owner", "editor", "member"]);

/**
 * The person's own workspace among those the session reaches: the personal one
 * they own. Every account has exactly one; a session without it reaches no
 * person object.
 */
export function personalWorkspaceOf(session) {
  const own = (session.workspaces ?? []).filter((entry) => entry?.kind === "personal" && entry?.role === "owner");
  return own.length === 1 && typeof own[0].workspaceId === "string" ? own[0].workspaceId : null;
}

function withAccessProtocol(response, upgraded) {
  if (response.status !== 101) return response;
  const headers = new Headers(response.headers);
  headers.set("Sec-WebSocket-Protocol", ACCESS_PROTOCOL);
  return upgraded(headers, response.webSocket);
}

const upgradedResponse = (headers, webSocket) => new Response(null, { status: 101, headers, webSocket });

export async function handleAccess(request, env, { slug, pathToken, origin }, deps = {}) {
  if (request.method !== "GET") return new Response(null, { status: 405 });
  if ((request.headers.get("Upgrade") || "").toLowerCase() !== "websocket") {
    return new Response("expected a websocket upgrade", { status: 426 });
  }
  const side = new URL(request.url).searchParams.get("of");
  if (!isSide(side)) return json({ error: "bad_side" }, 400);
  // A deployment without workspace objects says so; the app reads Convex as before.
  if (!env.WORKSPACE_STORE) return json({ error: "access_unavailable" }, 501);

  const controlPlane = deps.controlPlane ?? createControlPlane(env);
  let session;
  try {
    session = await resolvePresentedSession(request, { pathToken, path: ACCESS_SOCKET_PATH, slug, controlPlane });
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
  if (
    session.actorClientId !== CONSOLE_CLIENT_ID ||
    typeof session.actorUserId !== "string" ||
    !session.actorUserId ||
    !MEMBER_ROLES.has(session.role) ||
    groups.some((name) => name.startsWith("@#"))
  ) {
    return json({ error: "forbidden" }, 403);
  }

  const objectId = side === "workspace" ? session.workspaceId : personalWorkspaceOf(session);
  if (typeof objectId !== "string" || !objectId) return json({ error: "access_unavailable" }, 501);
  const stub = workspaceStub(env, objectId);
  if (stub === null) return json({ error: "access_unavailable" }, 501);
  const expiresAt = typeof session.expiresAt === "number" ? session.expiresAt : Infinity;
  const reader = {
    side,
    userId: session.actorUserId,
    workspaceId: objectId,
    // On the person side the person owns the object; on the workspace side the role is theirs there.
    role: side === "person" ? "owner" : session.role,
    scope: session.scope,
    groups,
    grantId: session.grantId,
    deadline: Math.min(expiresAt, Date.now() + ACCESS_SOCKET_MAX_MS),
  };
  const forwarded = new Request("https://workspace-store.internal/access", {
    headers: { Upgrade: "websocket", [ACCESS_READER_HEADER]: JSON.stringify(reader) },
  });
  return withAccessProtocol(await stub.fetch(forwarded), deps.upgraded ?? upgradedResponse);
}
