/**
 * The presence wire, from the client's side — the mirror of `apps/mcp/src/presence.js`.
 *
 * Two integers go out, a roster comes back. Nothing here ever holds note text,
 * in either direction, which is the property the whole feature rests on: see
 * the gateway module's header, and `docs/decisions/gateway-protocol.md`.
 *
 * Everything in this file is pure, so the state machine it feeds
 * (`session.ts`) and the extension that draws it (`remoteCarets.ts`) are both
 * testable without a socket, a document or a browser.
 *
 * ## Frames from the server are untrusted
 *
 * The gateway relays what other *clients* send. It bounds and normalizes them
 * first, but the thing on the other end of a relayed caret is somebody else's
 * browser, so every frame is parsed defensively here too rather than cast. A
 * peer that sends nonsense gets its own caret drawn somewhere silly and does
 * nothing else — no exception, no wrong document, no crash in a note somebody
 * is writing in.
 */

import { isolateForDisplay } from "@context/shared/src/displayText.cjs";

/** Matches `PRESENCE_PROTOCOL_VERSION` in the gateway. */
export const PRESENCE_PROTOCOL_VERSION = 1;
export const COLLABORATION_PROTOCOL_VERSION = 2;

/** One other person's editor, as it is drawn. */
export interface PresenceMember {
  id: string;
  name: string;
  /** `null` when the peer sent no usable colour; the view supplies one. */
  color: string | null;
  /**
   * The selection's ends, as *relative* positions — see `sync.ts`.
   *
   * `null` when a peer has no usable position, which is an ordinary state: an
   * empty document has no character for a caret to sit beside. The view draws
   * nothing rather than drawing at zero, because a caret parked at the start
   * of the document is a claim about where somebody is, and a wrong one.
   */
  anchor: string | null;
  head: string | null;
  /**
   * Whether the room would accept an edit from this member.
   *
   * Every client elects one peer to write the merged text back to the bucket,
   * and the election has to land on somebody the room will actually relay
   * edits from — otherwise a room whose lowest member id belongs to a
   * read-only viewer elects that viewer and nobody saves at all. Comes off the
   * grant at the gateway, never off the client.
   */
  canWrite: boolean;
  /**
   * Whether this member is a tool rather than a person.
   *
   * A tool that writes a note is editing it, and somebody watching should be
   * able to tell which of the carets in their note is not a colleague. It
   * holds no socket — the room announces it when a write arrives and the
   * client drops it again shortly after, because "who is typing right now" is
   * the only thing a caret can honestly claim.
   */
  isAgent: boolean;
}

export type ServerFrame =
  | {
      t: "welcome";
      you: string;
      members: PresenceMember[];
      reconnectAfterMs: number;
      heartbeatMs: number;
      /**
       * Whether this client is the one to put the note's text into the shared
       * document.
       *
       * **The room decides this and the client obeys it.** The client cannot:
       * the roster it is handed includes the member it was handed to, so "was
       * anybody already here" reads the same for the first person as for the
       * tenth, and the room also knows something the client does not — whether
       * the replay about to follow already carries the document. Absent from an
       * older gateway, where it reads `false`, which is the safe way to be
       * wrong: a note that fails to seed shows empty and is not saved over,
       * while a note seeded twice contains itself twice.
       */
      seed: boolean;
    }
  | { t: "join"; member: PresenceMember }
  | { t: "cursor"; id: string; anchor: string | null; head: string | null }
  | { t: "leave"; id: string }
  /** One edit from somebody else, to apply to the shared document. */
  /** One Yjs sync-protocol message, relayed from another client. */
  | { t: "y"; d: string }
  /**
   * A peer asking what it is missing, relayed with its type intact.
   *
   * Kept distinct from `y` because the distinction is a security boundary: an
   * `ask` is allowed past the room's write gate, and a client must therefore
   * read it with a reader that can only *answer* — never one that would apply
   * whatever the sender put in the payload. See `answerStateVector`.
   */
  | { t: "ask"; d: string }
  /** The document so far, replayed because this client just joined. */
  | { t: "sync"; updates: string[] }
  /** The room is asking this client to send a compacted snapshot. */
  | { t: "compact" }
  /**
   * Elements somebody else changed on a canvas.
   *
   * Base64 JSON, undecoded here: the reconciliation is Excalidraw's and runs
   * in the editor page. A drawing merges by element and never as text — see
   * `packages/drawings/src/collab.js`.
   */
  | { t: "draw"; d: string }
  /** Where a peer's pointer is on a canvas, and what they have selected. */
  | { t: "pointer"; id: string; x: number; y: number; selected: string[] }
  /**
   * The bucket moved: somebody in this room saved, or a tool wrote the note.
   *
   * No text, because the text is already shared — this is the *version*, so
   * this client's next conditional write is checked against what is actually
   * in the bucket rather than against what it opened. Without it, the moment
   * the person who was saving leaves, the next one elected conflicts.
   */
  | { t: "etag"; etag: string }
  /**
   * A tool wrote this note, and this client is the one asked to merge it.
   *
   * Sent to exactly one member — see `presenceRoom.js` — because every client
   * merging the same text would insert it once per client. Everybody else
   * receives the result as an ordinary edit.
   */
  | { t: "external"; text: string; etag: string | null }
  /**
   * Durable collaboration changed; the HTTP client performs an authorized read repair.
   *
   * `agent` names the tool whose write this was, when it was one. The room
   * says who; the client works out where from the update its own HTTP read
   * fetches, so no peer ever reports a caret on an agent's behalf.
   */
  | { t: "committed"; documentId: string; update?: string; etag: string; agent?: CommittedAgent }
  | { t: "live"; documentId: string; d: string; clientKey: string }
  | { t: "pong" };



/** The tool behind a committed write, as the room named it. */
export interface CommittedAgent {
  id: string;
  name: string;
  color: string | null;
}

/**
 * A colour from a peer is drawn into this document, so it is not taken on trust.
 *
 * `null` rather than a fallback hex, because this module decides what is *safe*
 * and the view decides what things *look like*: naming a colour here would put
 * a literal in a wire module and take the choice away from the palette, which
 * `paletteDiscipline.test.ts` is right to refuse. A peer that sends nonsense
 * gets whatever muted token the renderer picks for an unknown member.
 */
function color(value: unknown): string | null {
  return typeof value === "string" && /^#[0-9a-fA-F]{6}$/.test(value) ? value : null;
}

function name(value: unknown): string {
  if (typeof value !== "string") return "Someone";
  // The gateway strips control characters already. Doing it again here is not
  // redundant: this module is also what a self-hosted or older gateway talks
  // to, and a label is drawn into the page either way. Escaped rather than
  // pasted, so the class is readable in the source instead of invisible in it.
  // Stripping control characters IS the point here: this string is drawn into a
  // label in somebody else's editor, and `no-control-regex` exists to catch the
  // ones nobody meant to match. The directive sits on the line it governs —
  // `eslint-disable-next-line` means the next LINE, not the next statement, and
  // a version of this with the explanation in between disabled a comment.
  const cleaned = value
    // eslint-disable-next-line no-control-regex
    .replace(/[\u0000-\u001f\u007f\u200b-\u200f\u2028\u2029\u202a-\u202e\u2066-\u2069]/g, "")
    .trim();
  if (cleaned.length === 0) return "Someone";
  /*
    AND THEN CONTAINED, BECAUSE THE LIST ABOVE IS A BLOCKLIST.

    Everything it removes, it removes because somebody enumerated it — and the
    enumeration is short by at least **U+061C ARABIC LETTER MARK**, which the
    bidi algorithm acts on, and the U+FFF9-FFFB annotation set. A list reaches
    exactly as far as it reaches.

    `isolateForDisplay` does not depend on recognising the character: whatever
    survives is wrapped so it resolves its own direction and cannot reach the
    caret labels, the member list or the note it is drawn over. One spelling of
    that property for the whole product, in `packages/shared`, rather than a
    third private copy — see its header.

    Additive on purpose. The removals above are a *name* policy (a zero-width
    name is a look-alike, which is a different problem), and nothing that was
    cleaned before stops being cleaned.
  */
  const bounded = cleaned.length > 64 ? cleaned.slice(0, 64) : cleaned;
  return isolateForDisplay(bounded);
}

/** An encoded relative position from a peer, or `null` if it is not one. */
function position(value: unknown): string | null {
  if (typeof value !== "string" || value.length === 0 || value.length > 4096) return null;
  return /^[A-Za-z0-9+/]+={0,2}$/.test(value) ? value : null;
}

function member(value: unknown): PresenceMember | null {
  if (!value || typeof value !== "object") return null;
  const raw = value as Record<string, unknown>;
  if (typeof raw.id !== "string" || raw.id.length === 0) return null;
  return {
    id: raw.id,
    name: name(raw.name),
    color: color(raw.color),
    anchor: position(raw.a),
    head: position(raw.h),
    // Absent reads as "cannot write", which is the safe way to be wrong: an
    // election that skips somebody costs a save nobody makes until the next
    // roster, and one that includes somebody the room refuses costs every save.
    canWrite: raw.w === true,
    isAgent: raw.g === true,
  };
}

/**
 * The agent on a committed frame, or `null` for none.
 *
 * Only the room's own id shape is accepted: `a:` and a 16-digit digest. That
 * is what keeps an agent's caret from ever sharing an id with a seated member,
 * whose ids the room mints as uuids.
 */
function committedAgent(value: unknown): CommittedAgent | null {
  if (!value || typeof value !== "object") return null;
  const raw = value as Record<string, unknown>;
  if (typeof raw.id !== "string" || !/^a:[0-9a-f]{16}$/.test(raw.id)) return null;
  return { id: raw.id, name: name(raw.name), color: color(raw.color) };
}

/** Parse one frame from the gateway, or `null` if it is not one we act on. */
export function decodeServerFrame(raw: unknown): ServerFrame | null {
  if (typeof raw !== "string") return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return null;
  const frame = parsed as Record<string, unknown>;

  if (frame.t === "welcome") {
    if (frame.v !== PRESENCE_PROTOCOL_VERSION && frame.v !== COLLABORATION_PROTOCOL_VERSION) return null;
    if (typeof frame.you !== "string") return null;
    const members = Array.isArray(frame.members)
      ? frame.members.map(member).filter((one): one is PresenceMember => one !== null)
      : [];
    return {
      t: "welcome",
      you: frame.you,
      members,
      reconnectAfterMs: typeof frame.reconnectAfterMs === "number" ? frame.reconnectAfterMs : 300_000,
      heartbeatMs: typeof frame.heartbeatMs === "number" ? frame.heartbeatMs : 15_000,
      // Exactly `true`, never truthy: this is the flag that decides whether a
      // client writes the note's text into a document everybody shares.
      seed: frame.v === PRESENCE_PROTOCOL_VERSION && frame.seed === true,
    };
  }
  if (frame.t === "join") {
    const joined = member(frame.member);
    return joined ? { t: "join", member: joined } : null;
  }
  if (frame.t === "cursor") {
    if (typeof frame.id !== "string") return null;
    return { t: "cursor", id: frame.id, anchor: position(frame.a), head: position(frame.h) };
  }
  if (frame.t === "leave") {
    return typeof frame.id === "string" ? { t: "leave", id: frame.id } : null;
  }
  if (frame.t === "y") {
    return typeof frame.d === "string" && frame.d.length > 0 ? { t: "y", d: frame.d } : null;
  }
  if (frame.t === "ask") {
    return typeof frame.d === "string" && frame.d.length > 0 ? { t: "ask", d: frame.d } : null;
  }
  if (frame.t === "sync") {
    // Every entry checked, and a bad one dropped rather than failing the whole
    // replay: a join that lands on *most* of the document and then converges
    // on the next keystroke is better than one that lands on none of it.
    if (!Array.isArray(frame.updates)) return null;
    const updates = frame.updates.filter(
      (one): one is string => typeof one === "string" && one.length > 0,
    );
    return { t: "sync", updates };
  }
  if (frame.t === "draw") {
    return typeof frame.d === "string" && frame.d.length > 0 ? { t: "draw", d: frame.d } : null;
  }
  if (frame.t === "pointer") {
    if (typeof frame.id !== "string" || frame.id.length === 0) return null;
    const x = Number(frame.x);
    const y = Number(frame.y);
    // A pointer that is not two numbers is not a pointer. Drawing one at the
    // origin would be a claim about where somebody is, and a wrong one.
    if (!Number.isFinite(x) || !Number.isFinite(y)) return null;
    return {
      t: "pointer",
      id: frame.id,
      x,
      y,
      selected: Array.isArray(frame.s)
        ? frame.s.filter((id): id is string => typeof id === "string").slice(0, 64)
        : [],
    };
  }
  if (frame.t === "etag") {
    return typeof frame.v === "string" && frame.v.length > 0 ? { t: "etag", etag: frame.v } : null;
  }
  if (frame.t === "compact") return { t: "compact" };
  if (frame.t === "external") {
    // A missing text is not an empty note: it is a frame this client does not
    // understand, and merging "" would delete somebody's work.
    if (typeof frame.text !== "string") return null;
    return {
      t: "external",
      text: frame.text,
      etag: typeof frame.etag === "string" ? frame.etag : null,
    };
  }
  if (
    frame.t === "committed" &&
    typeof frame.documentId === "string" &&
    typeof frame.etag === "string"
  ) {
    const agent = committedAgent(frame.agent);
    return {
      t: "committed",
      documentId: frame.documentId,
      ...(typeof frame.update === "string" ? { update: frame.update } : {}),
      etag: frame.etag,
      ...(agent === null ? {} : { agent }),
    };
  }
  if (frame.t === "live") {
    if (typeof frame.documentId !== "string" || frame.documentId.length === 0 || frame.documentId.length > 256 ||
        typeof frame.clientKey !== "string" || frame.clientKey.length === 0 || frame.clientKey.length > 256 ||
        typeof frame.d !== "string" || frame.d.length === 0 || frame.d.length > 32 * 1024 ||
        !/^[A-Za-z0-9+/]+={0,2}$/.test(frame.d)) return null;
    return { t: "live", documentId: frame.documentId, d: frame.d, clientKey: frame.clientKey };
  }
  if (frame.t === "pong") return { t: "pong" };
  return null;
}

/** Transient authorization travels only to the room, never to a peer or storage. */
export function liveUpdateFrame(documentId: string, update: string, accessToken: string): string {
  return JSON.stringify({ t: "live", documentId, d: update, accessToken });
}

/** Where this editor's caret is, as relative positions. */
export function cursorFrame(anchor: string | null, head: string | null): string {
  return JSON.stringify({ t: "cursor", a: anchor, h: head });
}

/**
 * Where the *agent's* caret is, reported by the client that merged its write.
 *
 * One boolean, and never an id: this says the caret belongs to the agent, and
 * the room decides which agent from the write it just relayed. A client that
 * could name the member would be a client that could move anybody's caret.
 */
export function agentCursorFrame(anchor: string | null, head: string | null): string {
  return JSON.stringify({ t: "cursor", a: anchor, h: head, agent: true });
}

/** Where the agent's pointer is on a canvas. Same rule as above. */
export function agentPointerFrame(x: number, y: number): string {
  return JSON.stringify({ t: "pointer", x, y, s: [], agent: true });
}

/** One Yjs sync-protocol message on its way to the room. */
export function syncFrame(payload: string): string {
  return JSON.stringify({ t: "y", d: payload });
}

/**
 * "Here is what I already have; tell me the rest."
 *
 * A Yjs state vector, on its own frame type rather than on `y`. The room never
 * writes one to its log — it describes one client's ignorance at one instant
 * and means nothing to anybody replaying the room later — and it needs no write
 * authority, because asking what a note says is a read. A read-only member
 * sends this and peers answer it.
 */
export function askFrame(payload: string): string {
  return JSON.stringify({ t: "ask", d: payload });
}

/** Elements this person changed on a canvas, on their way to the room. */
export function drawFrame(payload: string): string {
  return JSON.stringify({ t: "draw", d: payload });
}

/** The whole scene, when the room asks a canvas for a compaction. */
export function drawSnapshotFrame(payload: string): string {
  return JSON.stringify({ t: "drawsnap", d: payload });
}

/** "I wrote this note to the bucket, and it is at this version now." */
export function savedFrame(etag: string): string {
  return JSON.stringify({ t: "saved", v: etag });
}

/** Where this person's pointer is on a canvas. */
export function pointerFrame(x: number, y: number, selected: string[]): string {
  return JSON.stringify({ t: "pointer", x, y, s: selected });
}

/** The whole document, when the room asks for a compaction. */
export function snapshotFrame(base64: string): string {
  return JSON.stringify({ t: "snap", d: base64 });
}

export function pingFrame(): string {
  return JSON.stringify({ t: "ping" });
}

export function byeFrame(): string {
  return JSON.stringify({ t: "bye" });
}

/**
 * Bring a peer's offsets inside this document.
 *
 * The server cannot do this: it has never seen the note and is not going to
 * read one to find out how long it is. So the clamp is here, at the only place
 * that knows — which also means a peer whose document has drifted from ours
 * (they typed, we have not received it yet) draws at the end of ours rather
 * than throwing out of a CodeMirror range.
 */
export function clampToDocument(value: number, length: number): number {
  if (!Number.isFinite(value) || value < 0) return 0;
  return value > length ? length : Math.trunc(value);
}

/**
 * The close code the gateway sends when this member may not be in the room.
 *
 * Mirrors `CLOSE_REFUSED` in `apps/mcp/src/presenceRoom.js`. Final: retrying
 * cannot change the answer, and a refreshed credential must never be used to
 * try, because refreshing is not how access is regained.
 */
export const CLOSE_REFUSED = 4003;

/**
 * The presence socket's URL for one note.
 *
 * The token goes in the path, as `/t/<token>/presence`, because a browser
 * `WebSocket` cannot set an `Authorization` header and the gateway already has
 * exactly this fallback for exactly this reason (`index.js`, "Token-in-path
 * fallback"). It is a transport for an OAuth-issued token and not a second kind
 * of credential: same resolution, same grant, same authority. A URL lands in
 * logs and history, so what rides here is the short-lived console grant and
 * never anything longer-lived.
 */
export function presenceSocketUrl(options: {
  gatewayOrigin: string;
  notePath: string;
  token: string;
  colorSeed: string;
  collaborationVersion?: 2;
  documentId?: string;
}): string {
  const url = new URL(`/t/${encodeURIComponent(options.token)}/presence`, options.gatewayOrigin);
  url.protocol = url.protocol === "http:" ? "ws:" : "wss:";
  url.searchParams.set("note", options.notePath);
  url.searchParams.set("seed", options.colorSeed);
  if (options.collaborationVersion !== undefined) url.searchParams.set("collaboration", String(options.collaborationVersion));
  if (options.documentId !== undefined) url.searchParams.set("documentId", options.documentId);
  return url.toString();
}
