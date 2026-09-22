/**
 * Who else has this note open, and where their caret is — the whole of it.
 *
 * ## What this is, and the line it does not cross
 *
 * Two people open `1-projects/foo.md` in the console. Today neither of them
 * learns the other exists until one saves and the other gets a conflict, which
 * is the worst possible moment to find out. This module is the state behind the
 * fix: a room per note, a member per open editor, and a caret offset that moves
 * as somebody types.
 *
 * ## Note text DOES pass through here now, and that was a decision
 *
 * This module was built on "a client sends two integers; the server relays two
 * integers", and that sentence is no longer true. Concurrent editing merges
 * documents, and a document is text — so edits, snapshots and a tool's write
 * all cross this channel, and the room's log holds them for as long as the
 * room exists. The old comment promised a line this feature has since walked
 * over, which is worse than no comment, so here is the line as it actually
 * stands:
 *
 *  - **The room never decodes any of it.** Updates are opaque base64 in and
 *    opaque base64 out; the room checks shape and size and relays. It cannot
 *    read a note and has no code that could start.
 *  - **The log is the shortest-lived copy in the system**, dropped when the
 *    room empties, and it is a derivative of a bucket that already holds the
 *    canonical note. Non-negotiable #3's terms, not an exception to them.
 *  - **The bucket stays canonical.** Nothing here is the only copy of
 *    anything, and the elected writer flushes the merged text back.
 *
 * `docs/decisions/gateway-protocol.md` carries the argument and what it costs.
 *
 * ## The server cannot check a caret, and says so rather than pretending
 *
 * A caret is an encoded *relative* position now rather than an integer offset,
 * because an offset names a place in a document that is moving underneath it.
 * Either way this module cannot check it: it has never seen the note and is
 * not going to read one to find out. So a caret is bounded for size and shape
 * and resolved by the *client* that draws it — a position that does not
 * resolve is not drawn at all. A peer sending nonsense can therefore make its
 * own caret disappear, and can do nothing else: no crash, no exception, no
 * read.
 *
 * ## A member cannot name itself
 *
 * `admit` takes the display name from the caller, and the only caller is the
 * room shell, which takes it from the resolved session rather than from the
 * socket. Nothing a client sends over the wire can set its own name, id or
 * colour. A connection that could would let anybody appear in somebody else's
 * note as anybody they liked, which is a spoof with a person's name on it.
 *
 * The id is per *connection*, not per person: the same person in two tabs is
 * two members with one name, because that is what is true, and because a shared
 * id would make one tab's close event remove the other tab's caret.
 *
 * ## Identity is a path, because there is no note id to key on
 *
 * A room is `workspaceId` plus the note's path. #735 gives a moved note a
 * forwarding *trail* between paths, deliberately not an id stamped into
 * anybody's file (`forwarding.js`: "never an id stamped into their
 * frontmatter"), so there is no stable identity available to key a room on. The
 * consequence is stated rather than hidden: renaming a note while two people
 * are in it ends that room, and their editors rejoin at the new path the same
 * way a freshly opened note joins one. Nothing is lost, because nothing in a
 * room is the only copy of anything.
 */

/**
 * The wire version. A client that speaks a version this worker does not is told
 * so and closed, rather than being left to interpret frames it will get wrong.
 */
export const PRESENCE_PROTOCOL_VERSION = 1;

/**
 * HTTP-committed collaboration sockets use the existing room only for
 * presence and delivery of committed snapshots.  They never participate in
 * the legacy in-room Yjs log protocol.
 */
export const COLLABORATION_PROTOCOL_VERSION = 2;

/**
 * How many editors may sit in one room.
 *
 * Presence is a thing you glance at. Past a couple of dozen carets the feature
 * stops being information and starts being confetti, and every frame costs a
 * fan-out to everybody else. The refusal is explicit (`room_full`) so a client
 * can say "5 others are here" rather than silently drawing nothing.
 */
export const MAX_MEMBERS_PER_ROOM = 24;

/**
 * How often a client is expected to speak, and how long silence is tolerated.
 *
 * A hibernating Durable Object does not notice a socket that died with its
 * laptop lid, so the roster would keep a ghost caret in the note forever. The
 * heartbeat is what makes a ghost expire. Three missed beats before eviction
 * rather than one, because a phone changing networks is normal and a caret that
 * flickers out on every subway tunnel is worse than one that lingers 45s.
 */
export const HEARTBEAT_MS = 15_000;
export const MEMBER_IDLE_MS = 45_000;

/**
 * The largest frame a client may send.
 *
 * A cursor frame is about 40 bytes. A kilobyte is room for a protocol that
 * grows a field or two and is nowhere near room for somebody streaming a
 * document through the presence channel, which is the thing this number exists
 * to make structurally impossible rather than merely discouraged.
 */
export const MAX_CLIENT_FRAME_BYTES = 1024;

/**
 * The ceiling for a merge frame, which is a different size of thing.
 *
 * A caret is two integers. An *edit* is an encoded document update: a
 * keystroke is tens of bytes, a paste is more, and a snapshot of a long note
 * is larger again. So these get their own ceilings rather than sharing the
 * caret's — and they are still ceilings, because the room relays whatever it
 * is handed and an unbounded frame is somebody else's memory.
 *
 * The room never decodes either one. See `presenceRoom.js`.
 */
export const MAX_UPDATE_BYTES = 32 * 1024;
export const MAX_SNAPSHOT_BYTES = 512 * 1024;

/**
 * How many updates a room keeps before it asks for a snapshot.
 *
 * The log is replayed to whoever joins, so it cannot grow for the life of a
 * long editing session: a thousand keystrokes is a thousand entries and a slow
 * join. Past this the room asks the client that has been there longest for a
 * compacted snapshot and replaces the log with it.
 */
export const UPDATE_LOG_CAP = 400;

/** Longer than any name the control plane will hand us; truncated, not refused. */
export const MAX_DISPLAY_NAME = 64;

/**
 * A sanity ceiling on a caret offset. Not a document length — see the header.
 * Ten million characters is longer than any Markdown note anybody is editing
 * and short enough that a hostile offset cannot be used to make a client
 * allocate.
 */
export const MAX_OFFSET = 10_000_000;

/**
 * The caret colours, and why there are eight of them.
 *
 * Enough that a handful of people in one note are told apart at a glance, few
 * enough that every one of them can be checked against both palettes for
 * contrast against a text background. They are assigned from a hash of the
 * member id rather than round-robin, so a member's colour does not change when
 * somebody else leaves — a caret that changes colour mid-session reads as a
 * different person arriving.
 */
export const PRESENCE_COLORS = [
  "#3b82f6",
  "#ec4899",
  "#10b981",
  "#f59e0b",
  "#8b5cf6",
  "#ef4444",
  "#06b6d4",
  "#84cc16",
];

/**
 * The room key a Durable Object id is derived from.
 *
 * Both halves are percent-encoded, which makes the join injective: no pair of
 * (workspace, path) can collide with another pair, because the one character
 * that separates them cannot appear in either side. A collision here would put
 * two tenants in one room, which is the failure this whole file would be
 * remembered for.
 */
export function roomKey(workspaceId, path) {
  return `${encodeURIComponent(String(workspaceId))}/${encodeURIComponent(String(path))}`;
}

/**
 * A stable colour for a member id, by FNV-1a over the id.
 *
 * Any spread-out hash would do. What matters is that it is a pure function of
 * the id and nothing else, so every client in the room independently draws the
 * same person the same colour without the server having to say so.
 */
export function colorFor(memberId) {
  let hash = 0x811c9dc5;
  const text = String(memberId);
  for (let i = 0; i < text.length; i += 1) {
    hash ^= text.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return PRESENCE_COLORS[hash % PRESENCE_COLORS.length];
}

/** A display name that is safe to put in somebody else's editor. */
export function normalizeDisplayName(value) {
  const text = typeof value === "string" ? value : "";
  // Control characters out first: a name is drawn into a label in somebody
  // else's editor, and a stray newline, a zero-width joiner or a bidi override
  // in one is their UI to play with. Escaped rather than pasted, so what this
  // class covers is readable in the source instead of invisible in it.
  const cleaned = text
    .replace(/[\u0000-\u001f\u007f\u200b-\u200f\u2028\u2029\u202a-\u202e\u2066-\u2069]/g, "")
    .trim();
  if (cleaned.length === 0) return "Someone";
  return cleaned.length > MAX_DISPLAY_NAME ? cleaned.slice(0, MAX_DISPLAY_NAME) : cleaned;
}

/** An encoded relative position from a client, or `null` if it is not one. */
export function relativePosition(value) {
  if (typeof value !== "string" || value.length === 0 || value.length > 4096) return null;
  return /^[A-Za-z0-9+/]+={0,2}$/.test(value) ? value : null;
}

/** An offset a client sent, made safe to relay, or `null` if it was not one. */
export function normalizeOffset(value) {
  if (typeof value !== "number" || !Number.isFinite(value)) return null;
  const rounded = Math.trunc(value);
  if (rounded < 0) return 0;
  return rounded > MAX_OFFSET ? MAX_OFFSET : rounded;
}

/**
 * Parse one frame from a client.
 *
 * Everything is a refusal with a reason rather than a throw, because this runs
 * inside a WebSocket message handler where an exception takes the whole room
 * down and a malformed frame is a thing any client will occasionally send.
 *
 * The byte check is on the *encoded* length rather than `String.length`, so a
 * frame of astral-plane characters cannot be twice the size it is measured as.
 */
export function decodeClientFrame(raw) {
  if (typeof raw !== "string") return { ok: false, reason: "not_text" };
  // The outer ceiling is the largest any frame may be; the per-type ceilings
  // below are tighter and are what actually decide. Checked first and on the
  // encoded length, so a frame is bounded before it is parsed.
  if (frameBytes(raw) > MAX_SNAPSHOT_BYTES + 1024) return { ok: false, reason: "too_large" };
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return { ok: false, reason: "not_json" };
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    return { ok: false, reason: "not_object" };
  }
  if (parsed.t === "cursor") {
    // Same cap, checked before the branch returns. A caret frame that is not
    // caret-sized is not a caret frame.
    if (frameBytes(raw) > MAX_CLIENT_FRAME_BYTES) return { ok: false, reason: "too_large" };
    /*
      An encoded *relative* position now, rather than an integer offset: an
      offset names a place in a document that is changing underneath it, so a
      peer typing above your caret moved it without telling anybody. The room
      still does not decode this — it checks the shape and relays it — and the
      identity on the frame is still stamped here rather than claimed there.
    */
    const anchor = relativePosition(parsed.a);
    const head = relativePosition(parsed.h);
    /*
      **"This caret is the agent's, not mine."**

      A tool that writes a note is editing it, and somebody watching should see
      that happen rather than watch text appear from nowhere. The tool holds no
      socket, so the one client the room asked to merge its write reports where
      the change landed on its behalf.

      A boolean, never an id: the client says *that* the caret belongs to the
      agent and the room decides *which* agent, from the write it just relayed.
      Letting a client name the id would be letting it move any caret in the
      room, which is the spoof `admit` exists to prevent, arriving through the
      back door.
    */
    return { ok: true, msg: { t: "cursor", a: anchor, h: head, agent: parsed.agent === true } };
  }
  if (parsed.t === "ask") {
    /*
      **"Tell me what I am missing" — a read, and shaped like one.**

      This carries a Yjs state vector: a summary of what this client already
      has, which peers answer with the diff. It is a separate type from `y`
      for two reasons, and both are load-bearing.

      It is never logged. An `ask` describes one client's ignorance at one
      moment and is meaningless to anybody replaying the room later, so
      routing it through `y` filled the log with entries that convey no text
      and counted them towards compaction.

      And it does not need write authority. Asking a peer what a note says is
      a read, and a read-only member holds exactly that — so gating it like an
      edit left a reader unable to sync from anybody, dependent on whatever
      the room's log happened to still hold.

      Sized as an update rather than a snapshot: a state vector is a few bytes
      per contributing client, never a document.
    */
    if (typeof parsed.d !== "string" || parsed.d.length === 0) {
      return { ok: false, reason: "bad_update" };
    }
    if (!/^[A-Za-z0-9+/]+={0,2}$/.test(parsed.d)) return { ok: false, reason: "not_base64" };
    if (frameBytes(parsed.d) > MAX_UPDATE_BYTES) return { ok: false, reason: "too_large" };
    return { ok: true, msg: { t: "ask", d: parsed.d } };
  }
  if (parsed.t === "draw" || parsed.t === "drawsnap") {
    /*
      **A drawing changes by element, never as a file.**

      `draw` carries the Excalidraw elements that changed — created, moved,
      restyled, deleted (Excalidraw deletes by flag, so a deletion is an
      ordinary element update) — and `drawsnap` carries the whole scene when
      the room asks for a compaction. Both are base64 JSON that this room does
      not parse, exactly like an edit to a note.

      Treating the `.excalidraw.md` *file* as collaborative text instead would
      merge two people's base64 payloads character by character, which produces
      a payload that is neither person's drawing and very likely nobody's.
      Elements reconcile; serialized scenes do not.

      Both take the snapshot ceiling. A delta is usually a few hundred bytes,
      but dragging a selection of a hundred shapes is one change to a hundred
      elements, and a cap that refused that would refuse an ordinary gesture.
    */
    if (typeof parsed.d !== "string" || parsed.d.length === 0) {
      return { ok: false, reason: "bad_update" };
    }
    if (!/^[A-Za-z0-9+/]+={0,2}$/.test(parsed.d)) return { ok: false, reason: "not_base64" };
    if (frameBytes(parsed.d) > MAX_SNAPSHOT_BYTES) return { ok: false, reason: "too_large" };
    return { ok: true, msg: { t: parsed.t, d: parsed.d } };
  }
  if (parsed.t === "y" || parsed.t === "snap") {
    // Base64 of an encoded document update. Checked for *shape* and *size*
    // only: the room does not decode it, cannot decode it, and must not start
    // — see the header. An update that is malformed is somebody's own editor
    // refusing it on the far side, which is where a document belongs.
    if (typeof parsed.d !== "string" || parsed.d.length === 0) {
      return { ok: false, reason: "bad_update" };
    }
    if (!/^[A-Za-z0-9+/]+={0,2}$/.test(parsed.d)) return { ok: false, reason: "not_base64" };
    const cap = parsed.t === "snap" ? MAX_SNAPSHOT_BYTES : MAX_UPDATE_BYTES;
    if (frameBytes(parsed.d) > cap) return { ok: false, reason: "too_large" };
    return { ok: true, msg: { t: parsed.t, d: parsed.d } };
  }
  /*
    **Everything that is not a merge frame is still a caret-sized frame.**

    Raising the outer ceiling to admit a snapshot is what let these through: a
    padded cursor frame of half a megabyte was accepted, because the only
    tight caps were on the two new types. The two checks that caught it exist
    precisely to stop somebody streaming bulk down this channel, so the cap is
    reapplied here rather than the tests being taught to expect less.
  */
  if (frameBytes(raw) > MAX_CLIENT_FRAME_BYTES) return { ok: false, reason: "too_large" };
  if (parsed.t === "pointer") {
    /*
      Where somebody's pointer is on a canvas, and what they have selected.

      A caret in a note is one relative position; a pointer on a drawing is two
      scene coordinates and a set of element ids. Numbers and ids only — never
      an element, never a payload — and caret-sized by the ceiling above, which
      is what keeps this from becoming a second channel for scene data.

      Never logged: it describes where somebody's mouse is right now, which is
      meaningless to anybody replaying the room later. And not gated on write
      authority, because a read-only member watching a drawing being edited is
      exactly the case presence exists for.
    */
    const x = Number(parsed.x);
    const y = Number(parsed.y);
    if (!Number.isFinite(x) || !Number.isFinite(y)) return { ok: false, reason: "bad_pointer" };
    const selected = Array.isArray(parsed.s)
      ? parsed.s.filter((id) => typeof id === "string" && id.length > 0 && id.length <= 64).slice(0, 64)
      : [];
    // `agent` as above: whose pointer this is, decided by the room.
    return { ok: true, msg: { t: "pointer", x, y, s: selected, agent: parsed.agent === true } };
  }
  if (parsed.t === "saved") {
    /*
      **"I just wrote this note to the bucket, and it is at this version now."**

      The console does not save through the gateway's `write_note` — it goes
      through the control plane's own file operation — so the room has no other
      way to learn that the bucket moved. Without this, every other member of
      the room keeps the etag their editor opened with, and the moment the
      person who was saving leaves, the next one elected saves against a
      version that is two edits old and gets the conflict box this whole
      feature exists to delete.

      An etag, and nothing else. Short, opaque, and never note text: the shape
      check is what keeps this from becoming a channel for anything larger, and
      the caret ceiling below is the second half of that.
    */
    if (typeof parsed.v !== "string" || parsed.v.length === 0 || parsed.v.length > 128) {
      return { ok: false, reason: "bad_etag" };
    }
    // Printable ASCII without quotes or control characters: every store's etag
    // is a hex digest or a quoted one, and a client is not writing prose here.
    if (!/^[A-Za-z0-9._:+/=-]+$/.test(parsed.v)) return { ok: false, reason: "bad_etag" };
    return { ok: true, msg: { t: "saved", v: parsed.v } };
  }
  if (parsed.t === "ping") return { ok: true, msg: { t: "ping" } };
  if (parsed.t === "bye") return { ok: true, msg: { t: "bye" } };
  return { ok: false, reason: "unknown_type" };
}

function frameBytes(text) {
  // `TextEncoder` is on the Workers runtime and on node; measuring rather than
  // guessing is the point, so there is no fallback that silently under-counts.
  return new TextEncoder().encode(text).length;
}

/** The longest colour seed worth reading. A tab key is a uuid; this is room for one. */
export const MAX_COLOR_SEED = 64;

function usableSeed(value) {
  if (typeof value !== "string") return null;
  if (value.length === 0 || value.length > MAX_COLOR_SEED) return null;
  return value;
}

/** An empty room. Plain data: a Durable Object rebuilds one on every wake. */
export function createRoom() {
  return { members: new Map() };
}

/**
 * Put a member in the room.
 *
 * Returns the member, or a refusal. The caller supplies `id` and `name`; see
 * the header for why a client may supply neither.
 */
export function admit(room, { id, name, colorSeed, canWrite, now }) {
  if (room.members.has(id)) return { ok: false, reason: "duplicate_id" };
  if (room.members.size >= MAX_MEMBERS_PER_ROOM) return { ok: false, reason: "room_full" };
  const member = {
    id,
    name: normalizeDisplayName(name),
    // The seed is the one thing a client gets to influence, and all it can
    // influence is which of eight colours its own caret is drawn in. It exists
    // so a reconnect five minutes later is invisible rather than a peer
    // apparently leaving and a differently-coloured stranger arriving. A seed
    // long enough to be a payload is ignored rather than trusted.
    color: colorFor(usableSeed(colorSeed) ?? id),
    /*
      **Whether this member's edits would be accepted, on the roster.**

      Not a decoration: every client elects one of its peers to write the
      merged text back to the bucket, and that election has to land on
      somebody whose writes the room will actually relay. Without this it ran
      over the whole roster, so a room whose lowest member id belonged to a
      read-only viewer elected that viewer — and then nobody saved, because
      the one client that believed it was saving was the one the room refuses
      edits from.

      Decided by the route from the caller's grant and role and carried here;
      never claimed by a client. It tells peers only who may edit a note they
      can all already see.
    */
    w: canWrite === true,
    a: 0,
    h: 0,
    seen: now,
  };
  room.members.set(id, member);
  return { ok: true, member };
}

/** Move a member's caret. A frame from a member who is not in the room is dropped. */
export function applyCursor(room, id, msg, now) {
  const member = room.members.get(id);
  if (!member) return null;
  member.a = msg.a;
  member.h = msg.h;
  member.seen = now;
  return member;
}

/** Record that a member is still alive without moving its caret. */
export function touch(room, id, now) {
  const member = room.members.get(id);
  if (!member) return false;
  member.seen = now;
  return true;
}

/** Remove a member. Returns whether it was there, so a close is idempotent. */
export function forget(room, id) {
  return room.members.delete(id);
}

/**
 * Drop members who have not been heard from.
 *
 * Returns the ids removed so the caller can tell the room, rather than leaving
 * every client to time peers out on its own clock — which would mean four
 * clients disagreeing about who is present.
 */
export function expire(room, now) {
  const dropped = [];
  for (const [id, member] of room.members) {
    if (now - member.seen > MEMBER_IDLE_MS) {
      room.members.delete(id);
      dropped.push(id);
    }
  }
  return dropped;
}

/** The roster as it goes on the wire: no timestamps, no ids beyond the room's own. */
export function roster(room) {
  return [...room.members.values()].map((member) => ({
    id: member.id,
    name: member.name,
    color: member.color,
    w: member.w === true,
    a: member.a,
    h: member.h,
  }));
}
