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

/** A small JSON answer, since this object has no access to the worker's. */
function json(body) {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { "content-type": "application/json" },
  });
}

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
    /*
      **A tool wrote this note. One member is asked to merge it.**

      Reachable only from inside this worker — a Durable Object is not
      addressable from the internet — so the sole caller is the gateway, which
      has just authorized and completed a write to exactly this note in exactly
      this workspace. Nothing here re-authorizes, for the same reason the
      socket route's `x-presence-member` header is trusted: there is no other
      way in.

      The text goes to **one** socket, not all of them. Every client applying
      the same text to its own copy of the shared document would insert those
      characters once per client, because each copy generates its own
      operations for them. So the room picks the member who may actually have
      a merge accepted — write authority, lowest id, the same rule the clients
      use to choose who saves — and everybody else receives the merge as the
      ordinary edit it becomes.
    */
    if (new URL(request.url).pathname === "/external") {
      if (request.method !== "POST") return new Response(null, { status: 405 });
      let notice;
      try {
        notice = await request.json();
      } catch {
        return new Response(null, { status: 400 });
      }
      if (!notice || typeof notice.text !== "string") {
        return new Response(null, { status: 400 });
      }
      const merger = this.mergerSocket();
      if (!merger) return json({ delivered: false });
      try {
        merger.send(
          JSON.stringify({
            t: "external",
            text: notice.text,
            etag: typeof notice.etag === "string" ? notice.etag : null,
          }),
        );
      } catch {
        return json({ delivered: false });
      }
      return json({ delivered: true });
    }

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
      canWrite: intent.canWrite === true,
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
      /*
        Write authority, decided by the route from the caller's grant and role
        and carried here. Never taken from the client: a socket that could
        assert its own write access would make the scope check theatre.
      */
      canWrite: intent.canWrite === true,
      eligibleToCompact: false,
      deadline: now + PRESENCE_SOCKET_MAX_MS,
    });
    this.state.acceptWebSocket(server);

    /*
      **Who puts the note into the shared document, decided here.**

      A note starts as text in a bucket and exactly one client has to seed it.
      Two clients seeding means the note contains itself twice; none seeding
      means the shared document starts empty, and the client elected to save
      then writes that emptiness over the customer's note — the same shape as
      the snapshot bug below, arrived at from the other direction.

      The client used to decide this by asking whether the roster in its own
      welcome was empty. It never is: `admit` seats the member before `roster`
      reads the room, so the first person to open a note is told about
      themselves and concludes somebody was already here. Every unit test
      agreed, because every unit test built the frame the way the client
      expected it; two browsers on a real socket disagreed inside a second.

      So the room answers it, because the room is the only party that can. It
      holds both halves: whether anybody else is seated, and whether the log
      about to be replayed already carries the document. A client alone in a
      room whose log survived the last person leaving must not seed either —
      the replay is about to hand it the text.
    */
    const log = await this.readLog();
    const seed = room.members.size === 1 && log.length === 0;

    server.send(
      JSON.stringify({
        t: "welcome",
        v: PRESENCE_PROTOCOL_VERSION,
        you: seated.member.id,
        heartbeatMs: HEARTBEAT_MS,
        idleMs: MEMBER_IDLE_MS,
        reconnectAfterMs: PRESENCE_SOCKET_MAX_MS,
        members: roster(room),
        seed,
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
    if (log.length > 0) server.send(JSON.stringify({ t: "sync", updates: log }));

    /*
      This socket has now been handed everything the room holds, so a snapshot
      from it later is a complete state and is safe to compact against.
      A socket that joined before some entry cannot vouch for the entries it
      never saw, and the room will not delete anything on its word.
    */
    server.serializeAttachment({
      ...seated.member,
      canWrite: intent.canWrite === true,
      eligibleToCompact: true,
      deadline: now + PRESENCE_SOCKET_MAX_MS,
    });

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

    /*
      **Write authority is checked on the frame, by the server.**

      The route authorizes a *read* to open this socket, which is right — you
      have to be able to see a note to watch somebody edit it. It is not
      authority to change it. Without this line a `member` with read-only
      access could send edits that every other client would apply and the
      elected writer would flush to the bucket, which is non-negotiable #4
      exactly: "write access to somebody else's context is never implied by
      read".

      Refused silently rather than with an error: a client that should not be
      writing is either broken or hostile, and neither is owed a diagnostic.
      Their own editor still shows their own typing; it simply reaches nobody.
    */
    if ((decoded.msg.t === "y" || decoded.msg.t === "snap") && !attachment.canWrite) {
      return;
    }

    if (decoded.msg.t === "ask") {
      /*
        A joiner asking the room's peers what it is missing.

        **Relayed under its own name, never as a `y`.** It is deliberately
        above the write gate, because asking is a read and a read-only member
        holds exactly that. What follows from the same fact is that its payload
        arrives from somebody who may not edit — and this room cannot check
        what is in it, because it holds no Yjs and the bytes are opaque here by
        design.

        Relabelling it `y` erased the one distinction the receiving client has
        to go on. A peer reads a `y` with the sync protocol's own reader, which
        chooses between answering and *applying* on a type byte inside the
        payload — so an ask carrying an update was an edit by a member the
        write gate had just refused. Keeping the type is what lets the client
        answer it without applying it: see `readSyncAsk`.

        Not appended to the log either — see `decodeClientFrame`.
      */
      this.broadcast({ t: "ask", d: decoded.msg.d }, ws);
      return;
    }

    if (decoded.msg.t === "y") {
      /*
        One keystroke, on its way to everybody else.

        Relayed immediately and with no batching: this frame is the whole of
        why somebody sees a letter appear as it is typed rather than a second
        later. Appended to the log first so a person joining mid-sentence gets
        this character too, then sent to every socket but the sender's, who
        already has it — applying your own keystroke twice is work for nothing.
      */
      this.broadcast({ t: "y", d: decoded.msg.d }, ws);
      await this.appendUpdate(decoded.msg.d);
      return;
    }

    if (decoded.msg.t === "snap") {
      /*
        **A snapshot appends. It does not replace, and it never did safely.**

        The first version of this called `replaceLog`, and every client sent a
        snapshot on connect — so the second person to open a note replaced the
        room's whole history with their own *empty* document and destroyed what
        the first person had written. The elected writer would then have
        flushed that empty text to the bucket. It is the worst bug in this
        feature's history and it was introduced by a fix for a smaller one.

        So: snapshots are ordinary entries in an append-only log. A snapshot is
        a complete state, so replaying it followed by later updates converges
        to the same document either way — appending costs storage and is
        incapable of losing text, while replacing is one bad frame away from
        losing all of it.

        Compaction is the *room's* decision, never a client's, and it is
        handled in `checkpoint` below where eligibility is checked.
      */
      if (!attachment.canWrite) return;
      this.broadcast({ t: "y", d: decoded.msg.d }, ws);
      await this.appendUpdate(decoded.msg.d, { checkpoint: attachment.eligibleToCompact === true });
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

    // Nobody left: the room's copy of the note goes, and the object with it.
    if (await this.dropLogIfEmpty()) return;

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

  /**
   * Add one entry to the log.
   *
   * `checkpoint` says this entry is a complete state from a client the room
   * knows has seen everything before it, so everything before it can go. That
   * is the only path by which anything is ever deleted from the log, and the
   * delete happens *after* the write, so a failure between them leaves a
   * longer log rather than a shorter one.
   */
  async appendUpdate(update, { checkpoint = false } = {}) {
    const seq = ((await this.state.storage.get("seq")) ?? 0) + 1;
    const key = `u:${String(seq).padStart(9, "0")}`;
    await this.state.storage.put({ [key]: update, seq });
    if (checkpoint) await this.dropLogBefore(key);
    else if (seq % 50 === 0) await this.askForSnapshotIfLong();
  }

  /** Everything before a confirmed checkpoint, which is now redundant. */
  async dropLogBefore(key) {
    const existing = await this.state.storage.list({ prefix: "u:", end: key });
    if (existing.size === 0) return;
    await this.state.storage.delete([...existing.keys()]);
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
        w: attachment.canWrite === true,
        a: attachment.a ?? 0,
        h: attachment.h ?? 0,
        seen: attachment.seen ?? 0,
      });
    }
    return room;
  }

  /**
   * The one member asked to merge a write that came from outside the room.
   *
   * Write authority first, because a merge from a socket that cannot write is
   * refused by `webSocketMessage` and would be a merge that silently reached
   * nobody — the room would have handed the note's new text to the one client
   * guaranteed not to be able to share it. Then the lowest member id, so the
   * choice is stable across notices and matches the rule the clients already
   * use to elect whoever saves.
   *
   * Null when nobody in the room may write, which is a real state and not an
   * error: those clients see the change at their next reconnect.
   */
  mergerSocket() {
    let best = null;
    let bestId = null;
    for (const ws of this.state.getWebSockets()) {
      const attachment = ws.deserializeAttachment();
      if (!attachment || attachment.canWrite !== true) continue;
      if (typeof attachment.id !== "string") continue;
      if (bestId === null || attachment.id < bestId) {
        best = ws;
        bestId = attachment.id;
      }
    }
    return best;
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

  /**
   * The last person left, so the room's copy of the note goes.
   *
   * Review found this missing: the header claimed the log is "dropped once the
   * room empties" and nothing dropped it, so note content stayed in Durable
   * Object storage indefinitely — a second durable copy outside the customer's
   * bucket, which is the one cost this design is supposed to bound. A retention
   * policy nobody implemented is not a policy, it is a sentence.
   *
   * Only when the room is genuinely empty, and only after the flush has had
   * its chance: the elected writer saves on a debounce while connected, and a
   * room that is emptying has just lost that client. So this runs on the sweep
   * rather than on the close, which gives the write time to land and means a
   * reconnect within the window finds its document still here.
   */
  async dropLogIfEmpty() {
    if (this.state.getWebSockets().length > 0) return false;
    const entries = await this.state.storage.list({ prefix: "u:" });
    if (entries.size === 0) return false;
    await this.state.storage.deleteAll();
    return true;
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
    /*
      An object with nobody in it and nothing stored sets no alarm, so an empty
      room costs nothing and is evicted rather than waking forever.

      The storage check is not redundant: without it, the last socket closing
      cancels the sweep that would have deleted the log, and the note's content
      sits in Durable Object storage with nothing scheduled to ever remove it.
    */
    if (this.state.getWebSockets().length === 0) {
      const entries = await this.state.storage.list({ prefix: "u:", limit: 1 });
      if (entries.size === 0) return;
    }
    const existing = await this.state.storage.getAlarm();
    if (existing === null || existing === undefined) {
      await this.state.storage.setAlarm(Date.now() + PRESENCE_SWEEP_MS);
    }
  }
}

/** What a peer is told about another member. Never the heartbeat clock. */
function publicMember(member) {
  return {
    id: member.id,
    name: member.name,
    color: member.color,
    w: member.w === true,
    a: member.a,
    h: member.h,
  };
}
