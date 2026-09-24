import {
  HEARTBEAT_MS,
  MEMBER_IDLE_MS,
  PRESENCE_PROTOCOL_VERSION,
  COLLABORATION_PROTOCOL_VERSION,
  admit,
  colorFor,
  normalizeDisplayName,
  roster,
} from "../presence.js";
import { pruneActivity, recordActivity } from "../agentActivity.js";
import { PRESENCE_SOCKET_MAX_MS, json, publicMember } from "./wire.js";

/**
 * Open one socket into this room.
 *
 * The member's name arrives from the route in a header rather than from the
 * client, and that is the only reason it can be trusted: a Durable Object is
 * not addressable from outside the worker, so the sole caller of this method
 * is the route that just resolved a session for it. Anything the *client*
 * sends arrives over the socket, below, where it is treated as hostile.
 */
export async function fetchRoom(request) {
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
    **Which notes agents touched in this workspace, for the file tree.**

    Internal only, like `/committed`: the gateway records an event after a
    tool call it has already authorized and completed, and reads the log
    back for a route that has already resolved a session. The log goes back
    whole; the route filters it through `canSee` for the caller, because this
    object has no `privacy.md` and must not try to decide visibility.
  */
  if (requestUrl.pathname === "/activity") {
    const now = Date.now();
    if (request.method === "POST") {
      let event;
      try {
        event = await request.json();
      } catch {
        return new Response(null, { status: 400 });
      }
      return json({ recorded: recordActivity(this.activity, event, now) });
    }
    if (request.method === "GET") {
      // Every event, unaggregated: the one filter is on the side that knows
      // the manifest, and it has to run before anything is counted.
      return json({ events: pruneActivity(this.activity, now) });
    }
    return new Response(null, { status: 405 });
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
    for (const ws of this.openSockets()) {
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
  if (
    collaborationV2 &&
    (typeof intent.grantId !== "string" || !intent.grantId ||
      typeof intent.workspaceId !== "string" || !intent.workspaceId ||
      typeof intent.path !== "string" || !intent.path ||
      (intent.documentId !== null &&
        (typeof intent.documentId !== "string" || !intent.documentId || intent.documentId.length > 256)))
  ) {
    return new Response("missing collaboration identity", { status: 400 });
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
    ...(collaborationV2
      ? {
          grantId: intent.grantId,
          workspaceId: intent.workspaceId,
          workspaceSlug: typeof intent.workspaceSlug === "string" ? intent.workspaceSlug : null,
          path: intent.path,
          documentId: intent.documentId,
        }
      : {}),
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
