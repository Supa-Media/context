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
 * within five minutes for legacy presence. Durable v2 text has a stronger
 * boundary: each live frame freshly authorizes both sender and recipients,
 * while the same deadline still bounds roster/caret membership. Live frames
 * are transient and never enter the legacy room log.
 */

import { COLLABORATION_PROTOCOL_VERSION, MEMBER_IDLE_MS, createRoom, expire, forget } from "./presence.js";
import { CLOSE_REAUTHORIZE, PRESENCE_SWEEP_MS } from "./presenceRoom/wire.js";
import { fetchRoom } from "./presenceRoom/fetch.js";
import * as messages from "./presenceRoom/messages.js";
import * as committed from "./presenceRoom/committed.js";
import * as liveRelay from "./presenceRoom/liveRelay.js";
import * as log from "./presenceRoom/log.js";

export {
  PRESENCE_SOCKET_MAX_MS,
  PRESENCE_SWEEP_MS,
  CLOSE_REAUTHORIZE,
  CLOSE_REFUSED,
} from "./presenceRoom/wire.js";

/*
 * Every method the runtime or the gateway calls is declared on this class, so
 * the class `wrangler.toml` binds is complete where it is defined. The longer
 * bodies live beside it in `presenceRoom/` — one file per job — and run with
 * this object as `this`, exactly as they did when they were written inline.
 */
export class PresenceRoom {
  constructor(state, env) {
    this.state = state;
    this.env = env;
    // Transient only: access tokens wait here solely while at most eight
    // authorization calls for this socket are in flight. Nothing in this map
    // is serialized into a socket attachment or Durable Object storage.
    this.liveRelayQueues = new WeakMap();
    this.closedLiveSockets = new WeakSet();
    // Only on the one instance per workspace keyed by `agentActivityKey`, and
    // only in memory. See `agentActivity.js` for why it is never stored.
    this.activity = [];
  }

  async fetch(request) {
    return await fetchRoom.call(this, request);
  }

  async webSocketMessage(ws, raw) {
    return await messages.webSocketMessage.call(this, ws, raw);
  }

  async handleCommitted(request) {
    return await committed.handleCommitted.call(this, request);
  }

  committedAgent(actor) {
    return committed.committedAgent.call(this, actor);
  }

  async enqueueLiveRelay(ws, message) {
    return await liveRelay.enqueueLiveRelay.call(this, ws, message);
  }

  pumpLiveRelay(ws, state) {
    return liveRelay.pumpLiveRelay.call(this, ws, state);
  }

  async relayLiveUpdate(ws, message) {
    return await liveRelay.relayLiveUpdate.call(this, ws, message);
  }

  async webSocketClose(ws, code, reason) {
    this.cancelLiveRelay(ws);
    this.releaseSocket(ws);
    // Before the 2026-04-07 compatibility behavior, Durable Objects had to
    // answer the closing handshake themselves. Keep doing so explicitly: the
    // runtime may continue returning a CLOSING socket from getWebSockets(),
    // but it must not remain a member while that handshake completes.
    try {
      ws.close(code, reason);
    } catch {
      // Already closed, or a peer supplied a close code the platform will not
      // echo. Membership was released above either way.
    }
  }

  async webSocketError(ws) {
    this.cancelLiveRelay(ws);
    this.releaseSocket(ws);
  }

  cancelLiveRelay(ws) {
    return liveRelay.cancelLiveRelay.call(this, ws);
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

    for (const ws of this.openSockets()) {
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

  /* ------------------------ the log: see log.js ------------------------- */

  async readLog() {
    return await log.readLog.call(this);
  }

  async appendUpdate(update, ...options) {
    return await log.appendUpdate.call(this, update, ...options);
  }

  async dropLogBefore(key) {
    return await log.dropLogBefore.call(this, key);
  }

  async askForSnapshotIfLong() {
    return await log.askForSnapshotIfLong.call(this);
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
    for (const ws of this.openSockets()) {
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
    for (const ws of this.openSockets()) {
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
    for (const ws of this.openSockets()) {
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
    if (this.openSockets().length > 0) return false;
    const entries = await this.state.storage.list({ prefix: "u:" });
    if (entries.size === 0) return false;
    await this.state.storage.deleteAll();
    return true;
  }

  dropSocket(ws, code, reason) {
    this.cancelLiveRelay(ws);
    this.releaseSocket(ws);
    try {
      ws.close(code, reason);
    } catch {
      // Already closing. The roster no longer holds it either way.
    }
  }

  closeById(id, code, reason) {
    for (const ws of this.openSockets()) {
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
    if (this.openSockets().length === 0) {
      const entries = await this.state.storage.list({ prefix: "u:", limit: 1 });
      if (entries.size === 0) return;
    }
    const existing = await this.state.storage.getAlarm();
    if (existing === null || existing === undefined) {
      await this.state.storage.setAlarm(Date.now() + PRESENCE_SWEEP_MS);
    }
  }

  /**
   * Sockets that still represent seated members.
   *
   * Cloudflare may keep returning a socket from `getWebSockets()` while its
   * close handshake is in the CLOSING state, including after this object has
   * hibernated and lost its in-memory closed-socket set. WebSocket readyState
   * is therefore the durable membership boundary; attachments alone are not.
   */
  openSockets() {
    return this.state.getWebSockets().filter(
      (ws) => ws?.readyState === 1 && !this.closedLiveSockets.has(ws),
    );
  }
}
