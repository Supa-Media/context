/**
 * The wire between the console's chat with Tex and the gateway's
 * `/tex/app-chat` route.
 *
 * The route is the server half of this contract. It always answers for the
 * person's own 1:1 chat, so nothing here names a chat, a user or a workspace:
 * the grant does. Pure, and separate from the hook that drives it, for the
 * same reason as `features/approvals/gateway.ts`: what is sent, what is shown
 * and what somebody is told when it fails are each decided where a test can
 * reach them.
 *
 * ## Fields are named, never spread
 *
 * A row on the server carries more than the page should draw, and some of it
 * is the chat object's own bookkeeping. Each field kept here is read by name,
 * so a field the server adds for some other purpose stays off the page until a
 * diff says otherwise.
 *
 * ## A malformed answer is a failure value, never a throw
 *
 * A chat with somebody typing at it cannot throw. Every reader returns either
 * the value or a sentence, and an answer this build cannot read is a failure:
 * a half-read history is not shown as the whole of it.
 */

/** The two things a person can answer an approval with: a 👍 or a 👎 on Tex's text. */
export type AskChoice = "approve" | "deny";

/** Messages' six tapbacks, the only reactions the route takes. 👍 and 👎 on an open ask answer it. */
export const TAPBACKS = ["❤️", "👍", "👎", "😂", "‼️", "❓"] as const;
export type ReactionEmoji = (typeof TAPBACKS)[number];

/** The longest text the route accepts, after trimming. Matches the route's own limit. */
export const MAX_TEXT = 4000;
/** The most pictures one text carries. Matches the route's own limit. */
export const MAX_PICTURES = 4;
/** A picture's largest size after the page shrinks it, in bytes. The route refuses anything over 5 MB. */
export const MAX_PICTURE_BYTES = 5_000_000;

/** A tapback on a row: the person's own (`me`) or Tex's. */
export interface RowReaction {
  who: "me" | "tex";
  emoji: string;
}

/** One row of the app's own chat with Tex, as the page draws it. */
export interface AppChatRow {
  /** The chat's event id. Stable across reads; a reaction, a reply, an edit and a picture name it. */
  id: string;
  /** `me` for the person's own texts, `tex` for Tex's. */
  who: "me" | "tex";
  /** The words now: an edited text's latest, "" for an unsent one or a picture with no words. */
  text: string;
  /** Epoch milliseconds, from the server. */
  at: number;
  kind: "text" | "link" | "picture" | "file";
  /** Picture ids, read with `pictureRequest`. */
  pics?: string[];
  /** The text this one replies to, and its words when known. */
  replyTo?: { id: string; text?: string };
  /** The person changed the words after sending. */
  edited?: true;
  /** The person took this text back. Shown as a line saying so, never its words. */
  unsent?: true;
  /** At most one tapback each from the person and from Tex. */
  reactions?: RowReaction[];
  /** The person can still edit this text's words (their own words, within 15 minutes). */
  editable?: true;
  /** The person can still take this back, a picture included (their own, within 15 minutes). */
  unsendable?: true;
  /** An approval Tex asked on this text. Absent when there was none. */
  ask?: { id: string; open: boolean };
}

/**
 * The person's own text, shown before the server has it. Replaced by the
 * server's row once a read carries the id the send answered (`mergeRows`), or
 * left showing as failed.
 */
export interface PendingLine {
  pending: true;
  localId: string;
  who: "me";
  text: string;
  /** Object URLs of the pictures being sent, for the page to show meanwhile. */
  previews?: string[];
  /** The row it replies to, shown above it meanwhile. */
  replyTo?: { id: string; text?: string };
  /** The server's id once the send answered, so the next read replaces this line by id. */
  msgId?: string;
  /** Epoch milliseconds, from this device. Only orders the line until it is replaced. */
  at: number;
  state: "sending" | "failed";
}

/** A line on the page: a row from the server, or a pending text of the person's own. */
export type ChatLine = AppChatRow | PendingLine;

export function isPending(line: ChatLine): line is PendingLine {
  return "pending" in line && line.pending === true;
}

/**
 * The route, derived from the MCP endpoint the console shows.
 *
 * The origin and nothing else, as `approvalsEndpoint` does and for the same
 * reason: the grant names the context, so a path in the URL would be a second
 * answer to a question the token has already answered.
 */
export function appChatEndpoint(mcpEndpoint: string): string | null {
  let parsed: URL;
  try {
    parsed = new URL(mcpEndpoint);
  } catch {
    return null;
  }
  if (parsed.protocol !== "https:" && parsed.protocol !== "http:") return null;
  return `${parsed.origin}/tex/app-chat`;
}

/** What a send carries: words, pictures as base64 (no `data:` prefix), and the row it replies to. */
export interface SendBody {
  op: "send";
  text: string;
  pictures?: string[];
  replyTo?: string;
}

/**
 * `null` when there is nothing to send (no words and no pictures), the words are too long, or there are too many
 * pictures. The page checks this before it shows a pending line.
 */
export function sendRequest(text: string, options: { pictures?: readonly string[]; replyTo?: string | null } = {}): SendBody | null {
  const trimmed = text.trim();
  const pictures = options.pictures ?? [];
  if (trimmed.length > MAX_TEXT || pictures.length > MAX_PICTURES) return null;
  if (trimmed.length === 0 && pictures.length === 0) return null;
  return {
    op: "send",
    text: trimmed,
    ...(pictures.length > 0 ? { pictures: [...pictures] } : {}),
    ...(options.replyTo ? { replyTo: options.replyTo } : {}),
  };
}

/** The tapback for one answer: 👍 approves, 👎 does not. */
export function reactionEmoji(choice: AskChoice): ReactionEmoji {
  return choice === "approve" ? "👍" : "👎";
}

/** An approval's answer: a 👍 or 👎 on Tex's text. `msgId` is that row's `id` from a `get`. */
export function reactRequest(msgId: string, choice: AskChoice): { op: "react"; msgId: string; emoji: ReactionEmoji; answer: true } {
  // `answer`: the route never takes a tapback back for an answer, so Approve twice cannot undo the yes.
  return { op: "react", msgId, emoji: reactionEmoji(choice), answer: true };
}

/** Any of the six tapbacks on any row. */
export function tapbackRequest(msgId: string, emoji: ReactionEmoji): { op: "react"; msgId: string; emoji: ReactionEmoji } {
  return { op: "react", msgId, emoji };
}

/** New words for one of the person's own `editable` rows; `null` when they are empty or too long. */
export function editRequest(msgId: string, text: string): { op: "edit"; msgId: string; text: string } | null {
  const trimmed = text.trim();
  if (trimmed.length === 0 || trimmed.length > MAX_TEXT) return null;
  return { op: "edit", msgId, text: trimmed };
}

/** Take back one of the person's own `unsendable` rows. */
export function unsendRequest(msgId: string): { op: "unsend"; msgId: string } {
  return { op: "unsend", msgId };
}

/** One picture's bytes. The answer is the picture itself, never JSON. */
export function pictureRequest(id: string): { op: "picture"; id: string } {
  return { op: "picture", id };
}

/**
 * The person opened the chat or started typing: the gateway warms the model's cache for their next text when node
 * `warm` is wired (`apps/mcp/src/agent/textsWarm.js`). Fire and forget: its answer is never shown.
 */
export function warmRequest(cause: "open" | "typing"): { op: "warm"; cause: "open" | "typing" } {
  return { op: "warm", cause };
}

/** How long typing waits before it asks to warm again: the gateway itself skips a prefix warmed in the last 50 minutes. */
export const WARM_AGAIN_MS = 5 * 60 * 1000;

/** The whole chat, newest 150 rows, and whether Tex is working. */
export function getRequest(): { op: "get" } {
  return { op: "get" };
}

function objectOf(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : null;
}

function nonEmptyString(value: unknown): string | null {
  return typeof value === "string" && value.length > 0 ? value : null;
}

function epochMs(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : null;
}

const KINDS: readonly AppChatRow["kind"][] = ["text", "link", "picture", "file"];

const HEX32 = /^[0-9a-f]{32}$/;
const EMOJI_MAX = 8;

/**
 * Picture ids, all or nothing: one id that is not 32 hex characters drops the
 * field, so a row never shows a picture list the server did not send.
 */
function pictureIdsOf(value: unknown): string[] | undefined {
  if (!Array.isArray(value)) return undefined;
  if (!value.every((id) => typeof id === "string" && HEX32.test(id))) return undefined;
  return [...(value as string[])];
}

/** The text this one replies to. The id is required; a malformed words field drops only the words. */
function replyToOf(value: unknown): AppChatRow["replyTo"] | undefined {
  const record = objectOf(value);
  const id = nonEmptyString(record?.id);
  if (id === null) return undefined;
  return typeof record?.text === "string" ? { id, text: record.text } : { id };
}

/** Tapbacks, all or nothing, each `me` or `tex` with a short non-empty emoji. */
function reactionsOf(value: unknown): RowReaction[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const out: RowReaction[] = [];
  for (const entry of value) {
    const record = objectOf(entry);
    const emoji = nonEmptyString(record?.emoji);
    if (record === null || (record.who !== "me" && record.who !== "tex") || emoji === null || emoji.length > EMOJI_MAX) {
      return undefined;
    }
    out.push({ who: record.who, emoji });
  }
  return out;
}

/**
 * One row, field by field. `null` when this build cannot draw it, which fails
 * the whole read. Missing required fields fail it; a malformed optional field
 * is dropped, and a malformed `ask` still fails (it decides what the page offers).
 */
export function rowFrom(raw: unknown): AppChatRow | null {
  const record = objectOf(raw);
  if (record === null) return null;
  const id = nonEmptyString(record.id);
  const at = epochMs(record.at);
  const who = record.who === "me" || record.who === "tex" ? record.who : null;
  const kind = KINDS.find((k) => k === record.kind) ?? null;
  const text = typeof record.text === "string" ? record.text : null;
  if (id === null || at === null || who === null || kind === null || text === null) return null;
  const row: AppChatRow = { id, who, text, at, kind };
  if (record.ask !== undefined) {
    const askRecord = objectOf(record.ask);
    const askId = nonEmptyString(askRecord?.id);
    if (askId === null || typeof askRecord?.open !== "boolean") return null;
    row.ask = { id: askId, open: askRecord.open };
  }
  const pics = pictureIdsOf(record.pics);
  if (pics !== undefined) row.pics = pics;
  const replyTo = replyToOf(record.replyTo);
  if (replyTo !== undefined) row.replyTo = replyTo;
  if (record.edited === true) row.edited = true;
  if (record.unsent === true) row.unsent = true;
  if (record.editable === true) row.editable = true;
  if (record.unsendable === true) row.unsendable = true;
  const reactions = reactionsOf(record.reactions);
  if (reactions !== undefined) row.reactions = reactions;
  return row;
}

/** What a chat read answers with: the rows and Tex's typing mark, or a sentence for why not. */
export type ChatRead = { kind: "listed"; rows: AppChatRow[]; typing: boolean } | { kind: "failed"; sentence: string };

/** What a send answers with: the server's id for the text, or a sentence. */
export type SendRead = { kind: "sent"; msgId: string } | { kind: "failed"; sentence: string };

/** What a reaction answers with. */
export type ReactRead = { kind: "reacted" } | { kind: "failed"; sentence: string };

/** The sentence for an error answer, from the server's own `error` when it is one a person can read. */
function errorSentence(status: number, body: unknown, fallback: string): string {
  if (status === 401 || status === 403) {
    return "This app's connection to your context expired. Reload to keep chatting.";
  }
  const message = objectOf(body)?.error;
  // The gateway writes these for a person, at 400, 429 and 502/503. Anything else
  // is an internal word, so it is not shown.
  if ((status === 400 || status === 429 || status === 502 || status === 503) && typeof message === "string" && message.length > 0 && message.length <= 200) {
    return message;
  }
  return fallback;
}

/** The sentence for a chat read that failed. */
export function chatSentence(status: number, body: unknown): string {
  return errorSentence(status, body, "I could not load your chat with Tex. Try again in a moment.");
}

/** The sentence for a request that never reached the gateway at all. */
export const UNREACHABLE_SENTENCE = "I could not reach Tex. Try again in a moment.";

/** Read one `get` answer: every row, or a failure. One unreadable row fails the read. */
export function readChat(status: number, body: unknown): ChatRead {
  if (status !== 200) return { kind: "failed", sentence: chatSentence(status, body) };
  const record = objectOf(body);
  const list = record?.rows;
  if (!Array.isArray(list)) return { kind: "failed", sentence: chatSentence(200, null) };
  const rows: AppChatRow[] = [];
  for (const raw of list) {
    const row = rowFrom(raw);
    if (row === null) return { kind: "failed", sentence: chatSentence(200, null) };
    rows.push(row);
  }
  return { kind: "listed", rows, typing: record?.typing === true };
}

/** Read one `send` answer. A 200 must name the text's id; without it the page cannot match the row later. */
export function readSend(status: number, body: unknown): SendRead {
  const msgId = nonEmptyString(objectOf(body)?.msgId);
  if (status === 200 && msgId !== null) return { kind: "sent", msgId };
  if (status === 200) {
    return { kind: "failed", sentence: "Tex answered in a way this page cannot read. Try again in a moment." };
  }
  return {
    kind: "failed",
    sentence: errorSentence(status, body, "That text did not go through. Try again in a moment."),
  };
}

/** The sentence for a tapback or an answer the route refused. */
export const REACT_SENTENCE = "That answer did not go through. Nothing changed. Try again in a moment.";
/** The sentence for an edit the route refused. */
export const EDIT_SENTENCE = "That change did not go through. Nothing changed. Try again in a moment.";
/** The sentence for an unsend the route refused. */
export const UNSEND_SENTENCE = "That text could not be taken back. Nothing changed. Try again in a moment.";

/**
 * Read one `react`, `edit` or `unsend` answer. Only a 200 says it went through.
 * `fallback` is the sentence for a failure the route did not word itself.
 */
export function readReact(status: number, body: unknown, fallback: string = REACT_SENTENCE): ReactRead {
  if (status === 200) return { kind: "reacted" };
  return { kind: "failed", sentence: errorSentence(status, body, fallback) };
}

/** Read one `picture` answer's status and content type. Only an image is accepted; the bytes are read by the caller. */
export function readPictureHead(status: number, contentType: string | null): { kind: "image" } | { kind: "failed"; sentence: string } {
  if (status === 200 && contentType !== null && contentType.toLowerCase().startsWith("image/")) return { kind: "image" };
  return { kind: "failed", sentence: "That picture could not be loaded. Try again in a moment." };
}

/** The page's order: by time, a pending line after a server row that shares its moment, then by id. */
function orderOf(a: ChatLine, b: ChatLine): number {
  if (a.at !== b.at) return a.at - b.at;
  const pendingA = isPending(a) ? 1 : 0;
  const pendingB = isPending(b) ? 1 : 0;
  if (pendingA !== pendingB) return pendingA - pendingB;
  const idA = isPending(a) ? a.localId : a.id;
  const idB = isPending(b) ? b.localId : b.id;
  return idA < idB ? -1 : idA > idB ? 1 : 0;
}

/** The same text, ignoring the spaces the server does not keep either. */
function sameText(a: string, b: string): boolean {
  return a.trim() === b.trim();
}

/**
 * Put a fresh read of the chat over what the page already shows.
 *
 * - A row is one line, keyed by its id: a fresh copy replaces the old one, so
 *   an approval that closed since the last read shows closed.
 * - A row the fresh read does not mention stays. A read returns the newest 150
 *   rows, and the page should not lose the older ones it already drew.
 * - A pending line the send answered with an id (`msgId`) is replaced by the
 *   row with that id, and only by it. A pending line with no id yet is matched
 *   by text and by order, so two identical texts replace two pending lines, one
 *   each. A pending line with no match stays, sending or failed.
 */
export function mergeRows(old: readonly ChatLine[], fresh: readonly AppChatRow[]): ChatLine[] {
  const oldIds = new Set<string>();
  const byId = new Map<string, ChatLine>();
  for (const line of old) {
    if (isPending(line)) continue;
    oldIds.add(line.id);
    byId.set(line.id, line);
  }
  // A fresh row is new when the page did not already hold it as a server row.
  const claimed = new Set<string>();
  const kept: PendingLine[] = [];
  // Lines with an id go first, so a text match cannot take the row one of them names.
  const pendings = old.filter(isPending).sort((a, b) => (a.msgId !== undefined ? 0 : 1) - (b.msgId !== undefined ? 0 : 1));
  for (const line of pendings) {
    // The route answers its own `app:` id when the chat object kept no event id for the text: match those by words.
    if (line.msgId !== undefined && !line.msgId.startsWith("app:")) {
      // Already on the page as a server row, or arriving now: either way the pending line goes.
      if (oldIds.has(line.msgId) || fresh.some((row) => row.id === line.msgId)) {
        claimed.add(line.msgId);
      } else {
        kept.push(line);
      }
      continue;
    }
    // Words match by words; a pictures-only line by the first new picture row of the person's.
    const pictureOnly = line.text.trim() === "" && (line.previews?.length ?? 0) > 0;
    const match = fresh.find(
      (row) =>
        row.who === "me" &&
        !oldIds.has(row.id) &&
        !claimed.has(row.id) &&
        (pictureOnly ? row.kind === "picture" && row.text.trim() === "" : sameText(row.text, line.text)),
    );
    if (match) {
      claimed.add(match.id);
    } else {
      kept.push(line);
    }
  }
  for (const row of fresh) byId.set(row.id, row);
  return [...byId.values(), ...kept].sort(orderOf);
}

/**
 * The Tex text an approval is waiting on, or `null`.
 *
 * The newest Tex text whose ask is still open. Only that one takes the Approve
 * and Don't buttons: an older open ask was overtaken by the newer one in the
 * same chat, and a 👍 on the wrong text would approve the wrong thing.
 */
export function openAskRow(rows: readonly ChatLine[]): AppChatRow | null {
  for (let i = rows.length - 1; i >= 0; i -= 1) {
    const line = rows[i]!;
    if (isPending(line)) continue;
    if (line.who === "tex" && line.ask?.open === true) return line;
  }
  return null;
}
