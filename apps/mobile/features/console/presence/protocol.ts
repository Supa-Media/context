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

/** Matches `PRESENCE_PROTOCOL_VERSION` in the gateway. */
export const PRESENCE_PROTOCOL_VERSION = 1;

/** One other person's editor, as it is drawn. */
export interface PresenceMember {
  id: string;
  name: string;
  color: string;
  /** The selection's fixed end, in document offsets. */
  anchor: number;
  /** The end that moves, and where the caret is drawn. */
  head: number;
}

export type ServerFrame =
  | { t: "welcome"; you: string; members: PresenceMember[]; reconnectAfterMs: number; heartbeatMs: number }
  | { t: "join"; member: PresenceMember }
  | { t: "cursor"; id: string; anchor: number; head: number }
  | { t: "leave"; id: string }
  | { t: "pong" };

const MAX_OFFSET = 10_000_000;

function offset(value: unknown): number {
  if (typeof value !== "number" || !Number.isFinite(value)) return 0;
  const rounded = Math.trunc(value);
  if (rounded < 0) return 0;
  return rounded > MAX_OFFSET ? MAX_OFFSET : rounded;
}

/** A colour from a peer is drawn into this document, so it is not taken on trust. */
function color(value: unknown): string {
  return typeof value === "string" && /^#[0-9a-fA-F]{6}$/.test(value) ? value : "#8D857B";
}

function name(value: unknown): string {
  if (typeof value !== "string") return "Someone";
  // The gateway strips control characters already. Doing it again here is not
  // redundant: this module is also what a self-hosted or older gateway talks
  // to, and a label is drawn into the page either way. Escaped rather than
  // pasted, so the class is readable in the source instead of invisible in it.
  const cleaned = value
    .replace(/[\u0000-\u001f\u007f\u200b-\u200f\u2028\u2029\u202a-\u202e\u2066-\u2069]/g, "")
    .trim();
  if (cleaned.length === 0) return "Someone";
  return cleaned.length > 64 ? cleaned.slice(0, 64) : cleaned;
}

function member(value: unknown): PresenceMember | null {
  if (!value || typeof value !== "object") return null;
  const raw = value as Record<string, unknown>;
  if (typeof raw.id !== "string" || raw.id.length === 0) return null;
  return {
    id: raw.id,
    name: name(raw.name),
    color: color(raw.color),
    anchor: offset(raw.a),
    head: offset(raw.h),
  };
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
    if (frame.v !== PRESENCE_PROTOCOL_VERSION) return null;
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
    };
  }
  if (frame.t === "join") {
    const joined = member(frame.member);
    return joined ? { t: "join", member: joined } : null;
  }
  if (frame.t === "cursor") {
    if (typeof frame.id !== "string") return null;
    return { t: "cursor", id: frame.id, anchor: offset(frame.a), head: offset(frame.h) };
  }
  if (frame.t === "leave") {
    return typeof frame.id === "string" ? { t: "leave", id: frame.id } : null;
  }
  if (frame.t === "pong") return { t: "pong" };
  return null;
}

/** The only two frames this client ever sends, besides a parting `bye`. */
export function cursorFrame(anchor: number, head: number): string {
  return JSON.stringify({ t: "cursor", a: offset(anchor), h: offset(head) });
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
}): string {
  const url = new URL(`/t/${encodeURIComponent(options.token)}/presence`, options.gatewayOrigin);
  url.protocol = url.protocol === "http:" ? "ws:" : "wss:";
  url.searchParams.set("note", options.notePath);
  url.searchParams.set("seed", options.colorSeed);
  return url.toString();
}
