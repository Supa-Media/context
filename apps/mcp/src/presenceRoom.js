/**
 * The Durable Object behind one note's presence room — a thin shell over
 * `presence.js`, which holds every decision this file acts on.
 *
 * ## Why there is a Durable Object here at all
 *
 * The rest of this worker is stateless on purpose, and `session.js` explains at
 * length why nothing may be cached across requests. Presence is the one thing
 * that cannot be answered that way: "who else is in this note" is a fact about
 * *other people's live connections*, and there is no request in which to
 * compute it. A Durable Object is the platform's answer to exactly that, and it
 * is one binding covering every note rather than one resource per customer —
 * which is why this does not repeat the problem that pushed per-workspace
 * search onto the HTTP API (`search/d1/client.js`).
 *
 * ## Nothing here is durable, which is the point
 *
 * The object has no storage. The roster is rebuilt on every wake from the
 * sockets themselves — `getWebSockets()` plus each socket's attachment — so
 * there is no state to migrate, no state to leak between tenants, and nothing
 * to delete when the last person leaves. Hibernation evicts the object while
 * the sockets sit idle, and a room nobody has opened was never instantiated:
 * `idFromName` allocates nothing.
 *
 * This is also what makes the feature safe to switch off. Stop routing to it
 * and every note still opens, still saves, still conflicts exactly as it does
 * now. Presence is an overlay on the existing single-writer editor, not a new
 * path to the bucket — this object never touches a store and holds no
 * credential.
 *
 * ## Revocation, with the number said out loud
 *
 * A socket is authorized once, by the route that opened it, and is then closed
 * at `PRESENCE_SOCKET_MAX_MS`. A client reconnects through that same route,
 * which re-resolves the grant, re-reads `privacy.md` and re-checks that the
 * caller can still see the note. So a revoked grant, a changed role, or a note
 * that just became private takes effect at the next reconnect and therefore
 * within five minutes — not instantly. That bound is enforced here, by an
 * alarm, rather than being a sentence somebody has to trust.
 */

import {
  UPDATE_LOG_CAP,
  HEARTBEAT_MS,
  MEMBER_IDLE_MS,
  PRESENCE_PROTOCOL_VERSION,
  admit,
  applyCursor,
  createRoom,
  decodeClientFrame,
  expire,
  forget,
  roster,
  touch,
} from "./presence.js";

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

export class PresenceRoom {
  constructor(state, env) {
    this.state = state;
    this.env = env;
  }

  /**
   * Open one socket into this room.
   *
   * The member's name arrives from the route in a header rather than from the
   * client, and that is the only reason it can be trusted: a Durable Object is
   * not addressable from outside the worker, so the sole caller of this method
   * is the route that just resolved a session for it. Anything the *client*
   * sends arrives over the socket, below, where it is treated as hostile.
   */
  async fetch(request) {
    if (request.headers.get("Upgrade") !== "websocket") {
      return new Response("expected a websocket upgrade", { status: 426 });
    }

    let intent;
    try {
      intent = JSON.parse(request.headers.get("x-presence-member") || "null");
    } catch {
      intent = null;
    }
    if (!intent || typeof intent !== "object") {
      return new Response("missing member", { status: 400 });
    }

    const now = Date.now();
    const room = this.roomFromSockets();
    const id = crypto.randomUUID();
    const seated = admit(room, {
      id,
      name: intent.name,
      colorSeed: intent.colorSeed,
      now,
    });
    if (!seated.ok) {
      // A full room is a refusal with a reason, not a silent empty roster: the
      // console says "and N others" rather than drawing nothing and letting
      // somebody believe they are alone in a note they are not alone in.
      return new Response(JSON.stringify({ error: seated.reason }), {
        status: 409,
        headers: { "content-type": "application/json" },
      });
    }

    const pair = new WebSocketPair();
    const client = pair[0];
    const server = pair[1];

    // Hibernation: the runtime may evict this object while the socket stays
    // open, so everything needed to rebuild this member lives on the socket
    // rather than on `this`.
    server.serializeAttachment({
      ...seated.member,
      deadline: now + PRESENCE_SOCKET_MAX_MS,
    });
    this.state.acceptWebSocket(server);

    server.send(
      JSON.stringify({
        t: "welcome",
        v: PRESENCE_PROTOCOL_VERSION,
        you: seated.member.id,
        heartbeatMs: HEARTBEAT_MS,
        idleMs: MEMBER_IDLE_MS,
        reconnectAfterMs: PRESENCE_SOCKET_MAX_MS,
        members: roster(room),
      }),
    );
    this.broadcast({ t: "join", member: publicMember(seated.member) }, server);

    /*
      The document so far, replayed in order.

      This is why the room keeps a log at all. Somebody opening a note two
      other people are already editing has to arrive at the text they can see,
      and the only thing here that knows what that text is is the sequence of
      updates that produced it. The room replays them, the client applies them,
      and it lands where everybody else is.

      After the welcome, so a client has its own identity before any edit
      arrives, and in one frame rather than N so a join is one round trip.
    */
    const log = await this.readLog();
    if (log.length > 0) server.send(JSON.stringify({ t: "sync", updates: log }));

    await this.ensureAlarm();

    return new Response(null, { status: 101, webSocket: client });
  }

  async webSocketMessage(ws, raw) {
    const attachment = ws.deserializeAttachment();
    if (!attachment) return;

    const now = Date.now();
    if (now > attachment.deadline) {
      // Past its authorization, a socket stops being a member before it stops
      // being a socket: the caret goes away for everybody else at the same
      // moment the frame is refused, rather than one sweep later.
      this.dropSocket(ws, CLOSE_REAUTHORIZE, "reauthorize");
      return;
    }

    const decoded = decodeClientFrame(raw);
    if (!decoded.ok) {
      // A bad frame is dropped, never fatal. A client that sends junk gets a
      // room that ignores it; a client that sends something enormous gets the
      // same treatment, because `decodeClientFrame` measured it before parsing.
      return;
    }

    if (decoded.msg.t === "bye") {
      this.dropSocket(ws, 1000, "bye");
      return;
    }

    if (decoded.msg.t === "u") {
      /*
        One keystroke, on its way to everybody else.

        Relayed immediately and with no batching: this frame is the whole of
        why somebody sees a letter appear as it is typed rather than a second
        later. Appended to the log first so a person joining mid-sentence gets
        this character too, then sent to every socket but the sender's, who
        already has it — applying your own keystroke twice is work for nothing.
      */
      this.broadcast({ t: "u", d: decoded.msg.d }, ws);
      await this.appendUpdate(decoded.msg.d);
      return;
    }

    if (decoded.msg.t === "snap") {
      // A compacted state from a client, replacing everything before it. Taken
      // on trust as *bytes* and on nobody's word as *content*: the room cannot
      // tell a good snapshot from a bad one, so what protects the document is
      // that the bucket holds the last flushed text and every other client
      // still holds its own copy.
      await this.replaceLog(decoded.msg.d);
      return;
    }

    const room = this.roomFromSockets();
    if (decoded.msg.t === "ping") {
      touch(room, attachment.id, now);
      ws.serializeAttachment({ ...attachment, seen: now });
      ws.send(JSON.stringify({ t: "pong" }));
      return;
    }

    const moved = applyCursor(room, attachment.id, decoded.msg, now);
    if (!moved) return;
    ws.serializeAttachment({ ...attachment, a: moved.a, h: moved.h, seen: now });
    this.broadcast({ t: "cursor", id: moved.id, a: moved.a, h: moved.h }, ws);
  }

  async webSocketClose(ws) {
    this.releaseSocket(ws);
  }

  async webSocketError(ws) {
    this.releaseSocket(ws);
  }

  /**
   * The sweep. Two jobs, both of which exist because a socket can stop being
   * useful without being closed: a laptop lid that shut takes its heartbeat
   * with it, and an authorization runs out on the clock rather than on an
   * event.
   */
  async alarm() {
    const now = Date.now();
    const room = this.roomFromSockets();

    for (const ws of this.state.getWebSockets()) {
      const attachment = ws.deserializeAttachment();
      if (!attachment) continue;
      if (now > attachment.deadline) {
        this.dropSocket(ws, CLOSE_REAUTHORIZE, "reauthorize");
      }
    }

    for (const id of expire(room, now)) {
      this.closeById(id, CLOSE_REAUTHORIZE, "idle");
      this.broadcast({ t: "leave", id });
    }

    await this.ensureAlarm();
  }

  /* -------------------------------- the log ------------------------------- */

  /**
   * Every update this room has relayed, oldest first.
   *
   * In Durable Object storage rather than memory, because hibernation evicts
   * memory and somebody rejoining must not find the last ten minutes of
   * everybody's typing gone. Keys are zero-padded so a lexicographic `list`
   * returns them in arrival order, which is the order they must be applied in.
   *
   * **This is the one place in the feature where note content is durable
   * outside the customer's bucket**, and it is deliberately the shortest-lived
   * copy in the system: the client elected to save writes the merged text to
   * the bucket on a debounce, and the log is dropped once the room empties.
   * `docs/decisions/gateway-protocol.md` states what that costs.
   */
  async readLog() {
    const stored = await this.state.storage.list({ prefix: "u:" });
    return [...stored.values()];
  }

  async appendUpdate(update) {
    const seq = ((await this.state.storage.get("seq")) ?? 0) + 1;
    await this.state.storage.put({ [`u:${String(seq).padStart(9, "0")}`]: update, seq });
    if (seq % 50 === 0) await this.askForSnapshotIfLong();
  }

  /**
   * Replace the whole log with one compacted state.
   *
   * The delete and the write are one `transaction`, so a room that dies midway
   * cannot come back holding neither — which would be an empty document handed
   * to the next person who opens the note.
   */
  async replaceLog(snapshot) {
    await this.state.storage.transaction(async (txn) => {
      const existing = await txn.list({ prefix: "u:" });
      await txn.delete([...existing.keys()]);
      await txn.put({ "u:000000001": snapshot, seq: 1 });
    });
  }

  /**
   * Ask somebody to compact, once the log is long enough to slow a join.
   *
   * The *oldest* socket, because it has been applying updates longest and is
   * likeliest to hold the whole document. Asked rather than told: a client
   * that ignores this costs a slower join and nothing else.
   */
  async askForSnapshotIfLong() {
    const entries = await this.state.storage.list({ prefix: "u:" });
    if (entries.size < UPDATE_LOG_CAP) return;
    const sockets = this.state.getWebSockets();
    if (sockets.length === 0) return;
    try {
      sockets[0].send(JSON.stringify({ t: "compact" }));
    } catch {
      // The next fifty updates ask again.
    }
  }

  /* ------------------------------ internals ------------------------------ */

  /**
   * The roster, derived from the live sockets rather than held anywhere.
   *
   * This is the reason there is no storage on this object and nothing to clean
   * up when the last person leaves: the sockets *are* the state, and when they
   * are gone so is the room.
   */
  roomFromSockets() {
    const room = createRoom();
    for (const ws of this.state.getWebSockets()) {
      const attachment = ws.deserializeAttachment();
      if (!attachment || typeof attachment.id !== "string") continue;
      room.members.set(attachment.id, {
        id: attachment.id,
        name: attachment.name,
        color: attachment.color,
        a: attachment.a ?? 0,
        h: attachment.h ?? 0,
        seen: attachment.seen ?? 0,
      });
    }
    return room;
  }

  broadcast(message, except) {
    const text = JSON.stringify(message);
    for (const ws of this.state.getWebSockets()) {
      if (ws === except) continue;
      try {
        ws.send(text);
      } catch {
        // A socket that cannot be written to is one the runtime is already
        // tearing down. Its close event removes it from the roster; failing the
        // whole broadcast because one peer died would take the room with it.
      }
    }
  }

  releaseSocket(ws) {
    const attachment = ws.deserializeAttachment();
    if (!attachment || typeof attachment.id !== "string") return;
    const room = this.roomFromSockets();
    forget(room, attachment.id);
    this.broadcast({ t: "leave", id: attachment.id }, ws);
  }

  dropSocket(ws, code, reason) {
    this.releaseSocket(ws);
    try {
      ws.close(code, reason);
    } catch {
      // Already closing. The roster no longer holds it either way.
    }
  }

  closeById(id, code, reason) {
    for (const ws of this.state.getWebSockets()) {
      const attachment = ws.deserializeAttachment();
      if (attachment && attachment.id === id) {
        try {
          ws.close(code, reason);
        } catch {
          // See `broadcast`.
        }
      }
    }
  }

  async ensureAlarm() {
    // An object with nobody in it sets no alarm, so an empty room costs nothing
    // and is evicted rather than waking on a timer forever.
    if (this.state.getWebSockets().length === 0) return;
    const existing = await this.state.storage.getAlarm();
    if (existing === null || existing === undefined) {
      await this.state.storage.setAlarm(Date.now() + PRESENCE_SWEEP_MS);
    }
  }
}

/** What a peer is told about another member. Never the heartbeat clock. */
function publicMember(member) {
  return { id: member.id, name: member.name, color: member.color, a: member.a, h: member.h };
}
