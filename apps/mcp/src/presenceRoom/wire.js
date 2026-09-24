/**
 * What a presence room promises on the wire: how long a socket lives, how
 * often the room sweeps, the two close codes a client acts on, and the shapes
 * of what it answers with.
 */

/**
 * How long one authorized socket may stay open.
 *
 * Five minutes is the whole of this feature's revocation story, so it is a
 * number rather than a feeling: short enough that losing access to a note stops
 * showing your caret to the room promptly, long enough that a reconnect costs
 * two control-plane round trips per client per five minutes rather than per
 * minute. A reconnect is invisible — the client keeps its colour across one
 * (see `colorSeed` in `presence.js`) and the roster is rebuilt from sockets.
 */
export const PRESENCE_SOCKET_MAX_MS = 5 * 60_000;

/** How often the room sweeps for dead members and expired sockets. */
export const PRESENCE_SWEEP_MS = 15_000;

/** The close code a client is told to reconnect on, rather than to give up on. */
export const CLOSE_REAUTHORIZE = 4001;
/** The close code for "you are not welcome here", which a client must not retry. */
export const CLOSE_REFUSED = 4003;

/** A small JSON answer, since this object has no access to the worker's. */
export function json(body) {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { "content-type": "application/json" },
  });
}

/** What a peer is told about another member. Never the heartbeat clock. */
export function publicMember(member) {
  return {
    id: member.id,
    name: member.name,
    color: member.color,
    w: member.w === true,
    a: member.a,
    h: member.h,
  };
}
