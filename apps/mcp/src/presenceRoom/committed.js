import { COLLABORATION_PROTOCOL_VERSION, colorFor, normalizeDisplayName } from "../presence.js";
import { agentMemberId } from "../agentActivity.js";
import { json } from "./wire.js";

/**
 * Internal-only delivery from the gateway's committed HTTP update path.
 * Durable Objects are not internet-addressable; the gateway is the only
 * caller.  The snapshot is deliberately not appended to the legacy log:
 * customer storage and the collaboration engine are the v2 authority.
 */
export async function handleCommitted(request) {
  if (request.method !== "POST") return new Response(null, { status: 405 });
  let notice;
  try {
    notice = await request.json();
  } catch {
    return new Response(null, { status: 400 });
  }
  const documentId = typeof notice?.documentId === "string" ? notice.documentId : "";
  const etag = typeof notice?.etag === "string" ? notice.etag : "";
  if (
    !documentId || documentId.length > 256 ||
    !etag || etag.length > 128 || !/^[A-Za-z0-9._:+/=-]+$/.test(etag)
  ) {
    return new Response(null, { status: 400 });
  }
  // A committed frame is only a change hint. Clients must re-authorize over
  // HTTP before fetching the snapshot; sending update bytes over a socket
  // whose lease may outlive a revoked grant would leak new note content.
  const payload = JSON.stringify({ t: "committed", documentId, etag, ...this.committedAgent(notice?.actor) });
  let delivered = 0;
  for (const ws of this.openSockets()) {
    const attachment = ws.deserializeAttachment();
    if (attachment?.collaborationVersion !== COLLABORATION_PROTOCOL_VERSION) continue;
    try {
      ws.send(payload);
      delivered += 1;
    } catch {
      // The close callback removes dead sockets; one dead peer must not
      // prevent a committed update reaching the remaining editors.
    }
  }
  return json({ delivered });
}

/**
 * Who made a committed write, when it was a tool and not somebody here.
 *
 * The v1 room announced a tool as a member and asked one client to report
 * where its caret landed (`/external`). A v2 room cannot do that: nobody is
 * handed the text, and every client re-reads the snapshot over HTTP on its
 * own. So the room names the agent and each client works out the changed
 * span from the update it just fetched. That is an authorized read, so no
 * client reports a caret on anybody else's behalf.
 *
 * The same rule as `/external` for a save: a write from a client already
 * seated here is somebody saving, and naming it as a tool would put a
 * robot wearing their own name beside their own caret.
 */
export function committedAgent(actor) {
  if (!actor || typeof actor !== "object") return {};
  if (typeof actor.id !== "string" || !/^[0-9a-f]{16}$/.test(actor.id)) return {};
  for (const ws of this.openSockets()) {
    if (ws.deserializeAttachment()?.clientKey === actor.id) return {};
  }
  const id = agentMemberId(actor.id);
  return { agent: { id, name: normalizeDisplayName(actor.name), color: colorFor(id) } };
}
