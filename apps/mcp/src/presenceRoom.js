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
  COLLABORATION_PROTOCOL_VERSION,
  MAX_SNAPSHOT_BYTES,
  admit,
  applyCursor,
  colorFor,
  createRoom,
  decodeClientFrame,
  expire,
  forget,
  normalizeDisplayName,
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
    const requestUrl = new URL(request.url);
    const collaborationV2 = requestUrl.searchParams.get("collaboration") === "2";

    /*
      The v2 socket is a live delivery/presence overlay for the HTTP
      collaboration endpoint.  It must never inherit the legacy room log:
      that log contains opaque client-authored updates from v1 clients and is
      not the authority for a v2 document.
    */
    if (requestUrl.pathname === "/committed") {
      return await this.handleCommitted(request);
    }

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
    if (requestUrl.pathname === "/external") {
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
      const etag = typeof notice.etag === "string" ? notice.etag : null;
      const merger = this.mergerSocket();

      /*
        **The tool joins the room as a member, and leaves when it stops typing.**

        Somebody watching a note change should see *who* is changing it. A tool
        holds no socket, so it is not in `roomFromSockets()` and never will be
        — but everything a caret needs is already built around a roster entry,
        so it is announced as one rather than given a parallel concept: the
        join frame, the cursor frame, and the leave frame all work unchanged.

        Identity is the room's, from what the gateway resolved. The name came
        off the caller's grant and the id is opaque — never the control plane's
        own client id, which is nobody else's business even inside a shared
        workspace.

        In memory rather than in storage, and deliberately: this is who is
        typing *right now*. A room that hibernates between the write and the
        caret loses the caret, which is the correct amount of wrong.
      */
      const actor = notice.actor && typeof notice.actor === "object" ? notice.actor : null;
      const agentId = typeof actor?.id === "string" && actor.id ? `a:${actor.id}` : null;
      /*
        **A write from a client already sitting here is somebody saving.**

        The console has no private save path: it writes through `write_note`
        like any agent, because that is the only shape there is. So without
        this, pressing save in a note you have open announces a tool joining
        the room, wearing your own name, next to your own caret — and a second
        one for every other client that ever saved, since nothing takes them
        down but time.

        Matched on the client rather than the member, because two tabs are two
        members of one client and either of them saving is still the same
        person. The key is a digest the gateway computes identically for the
        socket and for the write; see `presenceClientKey`.

        The agent is *cleared* rather than merely not replaced. It names who
        the last write belonged to, and the caret the merger is about to report
        is that write's — so leaving a previous tool in place would draw its
        caret at text somebody else wrote.
      */
      const seatedClients = new Set();
      for (const ws of this.state.getWebSockets()) {
        const held = ws.deserializeAttachment();
        if (typeof held?.clientKey === "string" && held.clientKey) seatedClients.add(held.clientKey);
      }
      if (agentId && seatedClients.has(actor.id)) {
        this.agent = null;
      } else if (agentId) {
        /*
          **And the room records which client it handed the write to.**

          The caret is reported by a client, with a boolean and no id, so the
          room supplies the id — which closes the spoof at *which* member and
          leaves *who may speak* open. Any socket could send the frame, and the
          room drew whatever arrived: within the idle window, every member of
          the room could place a named agent's caret anywhere in the document,
          in everybody's window. A read-only one included, because `cursor` is
          deliberately ungated — watching somebody edit is a read — so the one
          member the room refuses every edit from could still point an agent at
          text it never wrote.

          Only the client the write was given to knows where it landed, which
          is the sentence this feature was built on. Recorded here rather than
          re-derived later: the election can change between the write and the
          caret, and the honest claim is about the client that merged *this*
          write, not whoever happens to be elected when the frame arrives.
        */
        this.agent = {
          id: agentId,
          at: Date.now(),
          reporter: merger ? (merger.deserializeAttachment()?.id ?? null) : null,
        };
        this.broadcast({
          t: "join",
          member: {
            id: agentId,
            name: normalizeDisplayName(actor.name),
            color: colorFor(agentId),
            // A tool's caret is drawn, and a tool is never elected to save:
            // the election runs over members the room accepts edits from, and
            // this one has no socket to accept anything from.
            w: false,
            g: true,
            a: null,
            h: null,
          },
        });
      }
      /*
        **The version goes to the one member that is given the text, and to
        nobody else.**

        This used to broadcast the etag to the whole room on the reasoning that
        every client's next save is a conditional write and the bucket had just
        moved. True, and it is the wrong half of the truth: that refusal is the
        only thing standing between a stale draft and a silent overwrite, and
        moving a client's etag is what spends it.

        Only the merger is given the text. Everybody else is given the version
        of a write they have not received — so their next save passes its
        conditional check and writes their own older content over the tool's,
        with nobody shown a conflict. On a canvas that is not even a race: the
        merger reconciles the elements into its own scene and records them as
        already-sent, precisely so it does not echo them back, so the agent's
        drawing reaches exactly one screen and every other member is holding
        its version without it.

        A member who keeps their old etag conflicts once and is asked. That is
        the outcome this feature wanted to remove, and it is the correct one
        here, because the alternative is losing somebody's work quietly. The
        case the feature was actually built for — the saver leaves, and the
        next one elected has an etag two edits old — is the `saved` frame
        below, where the content really has reached everybody: a note through
        the shared document, a canvas through element reconciliation.
      */
      if (!merger) return json({ delivered: false });
      try {
        merger.send(JSON.stringify({ t: "external", text: notice.text, etag }));
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
    /*
      Built once and written twice — plain, not clever, and the reason is a
      bug this file has already had: the second write below rebuilt the object
      from `seated.member` and quietly dropped whatever the first one added.
      A field that exists in one of two identical-looking literals is a field
      that is there until somebody joins a room with a log in it.
    */
    const attachment = {
      ...seated.member,
      /*
        Write authority, decided by the route from the caller's grant and role
        and carried here. Never taken from the client: a socket that could
        assert its own write access would make the scope check theatre.
      */
      canWrite: intent.canWrite === true,
      /*
        Which client this socket belongs to, so that a write arriving from the
        same one is read as this person saving rather than as a tool joining.
        Opaque and stable; see `presenceClientKey` in the gateway.
      */
      clientKey: typeof intent.clientKey === "string" ? intent.clientKey : null,
      collaborationVersion: collaborationV2 ? COLLABORATION_PROTOCOL_VERSION : PRESENCE_PROTOCOL_VERSION,
      eligibleToCompact: false,
      deadline: now + PRESENCE_SOCKET_MAX_MS,
    };
    server.serializeAttachment(attachment);
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
    const log = collaborationV2 ? [] : await this.readLog();
    const seed = collaborationV2 ? false : room.members.size === 1 && log.length === 0;

    server.send(
      JSON.stringify({
        t: "welcome",
        v: collaborationV2 ? COLLABORATION_PROTOCOL_VERSION : PRESENCE_PROTOCOL_VERSION,
        you: seated.member.id,
        heartbeatMs: HEARTBEAT_MS,
        idleMs: MEMBER_IDLE_MS,
        reconnectAfterMs: PRESENCE_SOCKET_MAX_MS,
        members: roster(room),
        ...(collaborationV2 ? {} : { seed }),
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
    if (!collaborationV2 && log.length > 0) server.send(JSON.stringify({ t: "sync", updates: log }));

    /*
      This socket has now been handed everything the room holds, so a snapshot
      from it later is a complete state and is safe to compact against.
      A socket that joined before some entry cannot vouch for the entries it
      never saw, and the room will not delete anything on its word.
    */
    server.serializeAttachment({ ...attachment, eligibleToCompact: true });

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

    // v2 clients receive snapshots only from the authorized HTTP commit path.
    // In particular, do not let a client smuggle a legacy Yjs update or
    // snapshot into the room and have it appear as a committed document.
    if (
      attachment.collaborationVersion === COLLABORATION_PROTOCOL_VERSION &&
      (decoded.msg.t === "y" || decoded.msg.t === "snap" || decoded.msg.t === "ask")
    ) {
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
    if (
      (decoded.msg.t === "y" ||
        decoded.msg.t === "snap" ||
        decoded.msg.t === "draw" ||
        decoded.msg.t === "drawsnap" ||
        decoded.msg.t === "saved") &&
      !attachment.canWrite
    ) {
      return;
    }

    if (decoded.msg.t === "saved") {
      /*
        Somebody in this room wrote the note to the bucket. Everybody else
        moves onto that version, so their next save is a conditional write
        against what is actually there.

        Relayed and dropped: an etag describes the bucket right now and is
        meaningless to anybody replaying the room later, so it never reaches
        the log. Gated on write authority above, because a member who cannot
        write cannot have saved — and a peer that could announce an arbitrary
        etag could make everybody else's next save overwrite a version they
        never saw.
      */
      this.broadcast({ t: "etag", v: decoded.msg.v }, ws);
      return;
    }

    if (decoded.msg.t === "ask") {
      /*
        A joiner asking the room's peers what it is missing.

        **Relayed as an `ask`, and that is the whole of a security fix.** This
        used to broadcast it as a `y`, on the reasoning that a peer reads both
        with the same protocol reader — which is exactly the problem: that
        reader chooses between *answering* and *applying* on a type byte inside
        the payload, and the payload comes from the sender. So an `ask` holding
        an ordinary update was an edit by the member whose edits the gate above
        had just refused, applied by every peer and flushed to the bucket by
        the elected writer.

        This room cannot tell the two apart and must not learn how: it has no
        Yjs and the bytes are opaque by design. Keeping the *type* is what lets
        the client tell them apart, by reading an `ask` with a reader that can
        only produce an answer (`answerStateVector`).

        Not appended to the log — see `decodeClientFrame` — and deliberately
        above the write gate, because asking is a read.
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

    if (decoded.msg.t === "draw" || decoded.msg.t === "drawsnap") {
      /*
        One shape moving, on its way to everybody else.

        Relayed and logged exactly like a note edit, and for the same reason:
        somebody joining mid-drag has to arrive at the canvas the others can
        see, and the log is the only thing here that knows what that is.
        Excalidraw reconciles the replay by element version, so applying the
        same element twice is the same drawing — which is what makes an
        append-only log safe for a scene as well as for text.

        `drawsnap` is a complete scene and therefore a checkpoint, on the same
        terms as `snap`: only from a socket the room has already handed
        everything to.
      */
      this.broadcast({ t: "draw", d: decoded.msg.d }, ws);
      await this.appendUpdate(decoded.msg.d, {
        checkpoint: decoded.msg.t === "drawsnap" && attachment.eligibleToCompact === true,
      });
      return;
    }

    const room = this.roomFromSockets();
    if (decoded.msg.t === "pointer") {
      /*
        Where somebody is on the canvas. Relayed and dropped: never logged,
        never stored on the attachment — a pointer is only interesting while
        the person is still there, and the roster already carries a caret for
        the note case.
      */
      touch(room, attachment.id, now);
      ws.serializeAttachment({ ...attachment, seen: now });
      if (decoded.msg.agent === true) {
        // The agent's pointer on a canvas, reported by the client that merged
        // its write. Same three rules as the caret below: the room owns the
        // id, only the client it handed the write to may report, and only for
        // as long as that write is recent.
        if (!this.reportsForAgent(attachment, now)) return;
        this.broadcast({
          t: "pointer",
          id: this.agent.id,
          x: decoded.msg.x,
          y: decoded.msg.y,
          s: decoded.msg.s,
        });
        return;
      }
      this.broadcast(
        { t: "pointer", id: attachment.id, x: decoded.msg.x, y: decoded.msg.y, s: decoded.msg.s },
        ws,
      );
      return;
    }

    if (decoded.msg.t === "ping") {
      touch(room, attachment.id, now);
      ws.serializeAttachment({ ...attachment, seen: now });
      ws.send(JSON.stringify({ t: "pong" }));
      return;
    }

    if (decoded.msg.agent === true) {
      /*
        A caret reported on the agent's behalf by the client that merged its
        write. The room supplies the id — see `decodeClientFrame` — so a client
        can say "this one is the agent's" and cannot say *which* member any
        caret belongs to; and the room checks that this is the client it handed
        that write to, so a peer cannot say it at all. Sent to the reporter
        too, because unlike its own caret this is one it should be drawing.
      */
      if (!this.reportsForAgent(attachment, now)) return;
      touch(room, attachment.id, now);
      this.broadcast({ t: "cursor", id: this.agent.id, a: decoded.msg.a, h: decoded.msg.h });
      return;
    }

    const moved = applyCursor(room, attachment.id, decoded.msg, now);
    if (!moved) return;
    ws.serializeAttachment({ ...attachment, a: moved.a, h: moved.h, seen: now });
    this.broadcast({ t: "cursor", id: moved.id, a: moved.a, h: moved.h }, ws);
  }

  /**
   * Internal-only delivery from the gateway's committed HTTP update path.
   * Durable Objects are not internet-addressable; the gateway is the only
   * caller.  The snapshot is deliberately not appended to the legacy log:
   * customer storage and the collaboration engine are the v2 authority.
   */
  async handleCommitted(request) {
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
    const payload = JSON.stringify({ t: "committed", documentId, etag });
    let delivered = 0;
    for (const ws of this.state.getWebSockets()) {
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
  /**
   * The tool this room is currently drawing a caret for, if there still is one.
   *
   * Bounded by the same idle window a member gets, and for a sharper reason
   * than tidiness. An agent caret is reported by a *client* — with a boolean
   * that says "this one is the tool's" and no id, so the room supplies the id
   * from the write it last relayed. Without a bound, a client could send that
   * frame at any later moment and move a tool's caret anywhere it liked, hours
   * after that tool had finished: not a member it could impersonate, but a
   * name in the roster it could point at text the tool never wrote.
   *
   * The honest claim was only ever about the write that had just landed, so
   * that is exactly how long the room will make it.
   */
  currentAgent(now) {
    if (!this.agent) return null;
    if (now - this.agent.at > MEMBER_IDLE_MS) {
      this.agent = null;
      return null;
    }
    return this.agent;
  }

  /**
   * Whether this socket may report where the agent's caret is.
   *
   * Two questions, and the feature's own sentence is the second one: *"the
   * client the room asked to merge is the only party that knows where the
   * change landed."* The room handed that write to exactly one socket and
   * wrote down which; anybody else reporting is claiming knowledge they were
   * never given.
   *
   * Without it the frame is unauthenticated in the direction that matters. It
   * carries no id, so the room supplies one — but any socket could send it,
   * and `cursor` is ungated on purpose, so a **read-only** member could place
   * a named agent's caret anywhere in the document for everybody in the room.
   * Nothing is read and nothing is written; what is forged is attribution, in
   * the one feature whose whole purpose is saying who changed what.
   */
  reportsForAgent(attachment, now) {
    const agent = this.currentAgent(now);
    if (!agent) return null;
    if (!agent.reporter || agent.reporter !== attachment.id) return null;
    return agent;
  }

  mergerSocket() {
    let best = null;
    let bestId = null;
    for (const ws of this.state.getWebSockets()) {
      const attachment = ws.deserializeAttachment();
      if (!attachment || attachment.canWrite !== true) continue;
      // Legacy external merges are intentionally kept out of v2 rooms.  A v2
      // client receives durable committed snapshots through /committed; it
      // must never apply the legacy text merge as another local operation.
      if (attachment.collaborationVersion === COLLABORATION_PROTOCOL_VERSION) continue;
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
    const legacyDocumentFrame =
      message?.t === "y" || message?.t === "snap" || message?.t === "ask" || message?.t === "saved";
    for (const ws of this.state.getWebSockets()) {
      if (ws === except) continue;
      if (legacyDocumentFrame) {
        const attachment = ws.deserializeAttachment();
        if (attachment?.collaborationVersion === COLLABORATION_PROTOCOL_VERSION) continue;
      }
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
