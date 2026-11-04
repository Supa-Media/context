/**
 * A connection's session and its store's `ws.open` in one call to the person's own object (2026-11-03, Dev's "every
 * read and write under 0.1 s"). Every MCP call asked the personal workspace's object twice before its tool ran: the
 * session (`person.session`), then the open (`ws.open`). Where the session's workspace is this same object's, the open
 * is answered here beside it, exactly as `ws.open` answers it (`bindingRows.js`), after the same wait for an open mark.
 *
 * Only for a session found here, for the workspace this object is pinned to, for the person it names. Anything else
 * answers the session alone, and the gateway asks `ws.open` as before (`store/objectBinding.js`).
 */

import { ACCESS_HOMES } from "./access.js";
import { BINDING_OPS, serveBindingCall } from "./bindingRows.js";
import { waitForMarks } from "./marks.js";

/** `answer` is `person.session`'s response; the same response, with `open` beside the session where it may be. */
export async function withOpen(store, answer, fields) {
  if (fields?.open !== true || !answer.ok) return answer;
  let body;
  try {
    body = await answer.clone().json();
  } catch {
    return answer;
  }
  const session = body?.session ?? null;
  const workspaceId = fields.personalWorkspaceId;
  if (session === null || typeof workspaceId !== "string" || session.defaultWorkspaceId !== workspaceId) return answer;
  if (typeof session.actorUserId !== "string" || session.actorUserId === "") return answer;
  try {
    // The open is this workspace's: an object pinned to another one answers the session alone.
    store.rows.pinWorkspace(workspaceId);
  } catch {
    return answer;
  }
  const waitStarted = Date.now();
  const behind = await waitForMarks(store.marks ?? null);
  const opened = serveBindingCall(store, BINDING_OPS.OPEN, { userId: session.actorUserId }, ACCESS_HOMES.OBJECT, { behind });
  if (opened === null || !opened.ok) return answer;
  const open = { ...(await opened.json()), waitedMs: Date.now() - waitStarted, workspaceId, userId: session.actorUserId };
  return Response.json({ ...body, open });
}
