import { COLLABORATION_PROTOCOL_VERSION, applyCursor, decodeClientFrame, touch } from "../presence.js";
import { CLOSE_REAUTHORIZE } from "./wire.js";

/** One frame from a member's socket. Everything the client sends is hostile until checked here. */
export async function webSocketMessage(ws, raw) {
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

  if (decoded.msg.t === "live") {
    await this.enqueueLiveRelay(ws, decoded.msg);
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
