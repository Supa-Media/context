/**
 * The app's access socket (`GET /presence/access` on the gateway, answered by a
 * workspace object: `apps/mcp/src/workspaceStore/accessSockets.js`). Who may
 * reach what lives in the objects (decided by the owner, 2026-11-01), and the
 * members, invitations, connected apps and "shared with me" screens read and
 * write it here. Both sides read their frames through this file, so neither can
 * drift.
 *
 * One socket talks to one object, chosen by the gateway from the session and
 * never from anything the client names:
 *   `?of=workspace`  the grant's workspace object: `members`, `invites`
 *   `?of=person`     the person's own (personal workspace) object: `reach`,
 *                    `my_invites`, `connections`, `shared_to_me`, `shared_seen`
 *
 * Client to object:
 *   {t: "sub", topics: string[]}          the topics to keep live
 *   {t: "op", id, op, args}               one write; answered by an `ack` with the same id
 *   {t: "ping"}
 * Object to client:
 *   {t: "rows", topic, rows}              a topic's rows at this reader's clearance, again on every change
 *   {t: "not_served", topic}              this topic is not read from the object yet: use Convex
 *   {t: "ack", id, ok: true, result}      the write landed
 *   {t: "ack", id, ok: false, error}      it did not, with a fixed code
 *   {t: "pong"}
 *
 * The socket closes with ACCESS_CLOSE_REAUTH when the grant it opened on needs
 * checking again (at most every ACCESS_SOCKET_MAX_MS, or at once when the
 * person loses access), and the client reconnects with a fresh grant.
 */

const ACCESS_PROTOCOL = "context.access";
/** Under `/presence`, whose first segment is reserved (`apps/mcp/src/workspacePath.js`). */
const ACCESS_SOCKET_PATH = "/presence/access";
const ACCESS_SIDES = ["workspace", "person"];
const ACCESS_TOPICS = {
  workspace: ["members", "invites"],
  person: ["reach", "my_invites", "connections", "shared_to_me", "shared_seen"],
};
/** The writes each side answers; anything else is refused before it reaches a handler. */
const ACCESS_OPS = {
  workspace: ["invite", "revoke_invite", "remove_member", "set_role"],
  person: ["accept_invite", "decline_invite", "revoke_connection", "mark_shared_seen"],
};
const ACCESS_SOCKET_MAX_MS = 5 * 60_000;
const ACCESS_CLOSE_REAUTH = 4001;
const ACCESS_CLOSE_NOT_SERVED = 4404;
const MAX_FRAME_BYTES = 16 * 1024;
const MAX_OP_ID = 64;

const isSide = (side) => ACCESS_SIDES.includes(side);
const topicOk = (side, topic) => isSide(side) && ACCESS_TOPICS[side].includes(topic);
const opOk = (side, op) => isSide(side) && ACCESS_OPS[side].includes(op);

function parse(raw, limit) {
  if (typeof raw !== "string" || (limit !== null && raw.length > limit)) return null;
  try {
    const frame = JSON.parse(raw);
    return frame !== null && typeof frame === "object" && !Array.isArray(frame) ? frame : null;
  } catch {
    return null;
  }
}

/** A client frame as the object on `side` reads it, or null when it is not one. */
function decodeClientFrame(side, raw) {
  const frame = parse(raw, MAX_FRAME_BYTES);
  if (frame === null) return null;
  if (frame.t === "ping") return { t: "ping" };
  if (frame.t === "sub") {
    if (!Array.isArray(frame.topics) || !frame.topics.every((topic) => topicOk(side, topic))) return null;
    return { t: "sub", topics: [...new Set(frame.topics)] };
  }
  if (frame.t === "op") {
    if (typeof frame.id !== "string" || frame.id.length === 0 || frame.id.length > MAX_OP_ID) return null;
    if (!opOk(side, frame.op)) return null;
    const args = frame.args === undefined ? {} : frame.args;
    if (args === null || typeof args !== "object" || Array.isArray(args)) return null;
    return { t: "op", id: frame.id, op: frame.op, args };
  }
  return null;
}

/** An object frame as the app on `side` reads it, or null when it is not one. */
function decodeServerFrame(side, raw) {
  const frame = parse(raw, null);
  if (frame === null) return null;
  if (frame.t === "pong") return { t: "pong" };
  if (frame.t === "not_served" && topicOk(side, frame.topic)) return { t: "not_served", topic: frame.topic };
  if (frame.t === "rows" && topicOk(side, frame.topic) && frame.rows !== undefined) {
    return { t: "rows", topic: frame.topic, rows: frame.rows };
  }
  if (frame.t === "ack" && typeof frame.id === "string") {
    if (frame.ok === true) return { t: "ack", id: frame.id, ok: true, result: frame.result ?? null };
    return { t: "ack", id: frame.id, ok: false, error: typeof frame.error === "string" ? frame.error : "failed" };
  }
  return null;
}

const subFrame = (topics) => JSON.stringify({ t: "sub", topics: [...topics] });
const opFrame = (id, op, args) => JSON.stringify({ t: "op", id, op, args: args ?? {} });
const pingFrame = () => JSON.stringify({ t: "ping" });
const rowsFrame = (topic, rows) => JSON.stringify({ t: "rows", topic, rows });
const notServedFrame = (topic) => JSON.stringify({ t: "not_served", topic });
const ackFrame = (id, result) => JSON.stringify({ t: "ack", id, ok: true, result: result ?? null });
const refusedFrame = (id, error) => JSON.stringify({ t: "ack", id, ok: false, error });
const pongFrame = () => JSON.stringify({ t: "pong" });

module.exports = {
  ACCESS_PROTOCOL,
  ACCESS_SOCKET_PATH,
  ACCESS_SIDES,
  ACCESS_TOPICS,
  ACCESS_OPS,
  ACCESS_SOCKET_MAX_MS,
  ACCESS_CLOSE_REAUTH,
  ACCESS_CLOSE_NOT_SERVED,
  isSide,
  topicOk,
  opOk,
  decodeClientFrame,
  decodeServerFrame,
  subFrame,
  opFrame,
  pingFrame,
  rowsFrame,
  notServedFrame,
  ackFrame,
  refusedFrame,
  pongFrame,
};
