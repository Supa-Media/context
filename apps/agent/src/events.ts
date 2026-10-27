/**
 * The chat's event log, Worker side (docs/design/tex-event-log/CONTRACT.md,
 * sections 1, 2 and 5). Every message in and every part Tex sends out is one
 * `TexEvent`. The log itself lives in the customer's bucket, written by the
 * gateway (`POST /agent/events`); this object only buffers events until the
 * gateway has them, and keeps a short window of recent ones so the decision
 * on the next text (`decide.ts`) can be shown what was just said.
 *
 * What it keeps, bounded on purpose since it is customer text held outside
 * the customer's bucket:
 * - `ev:<id>` one event, its words capped at 3,000 characters, flagged once
 *   the gateway wrote it. At most `MAX_KEPT_EVENTS`, at most
 *   `MAX_KEPT_CHARS` of words in all, none older than a day: the oldest go
 *   first, written or not.
 */

import { post, record, type Fetch } from "./clients";
import { staleAsks } from "./decide";
import type { InboxStorage } from "./inbox";

export type EventKind = "text" | "picture" | "file" | "link" | "reaction" | "ask" | "ask_settled" | "delivery";
export type EventReason = "upload_failed" | "send_refused" | "held_newcomer" | "failed" | "timed_out" | "too_long";

export type TexEvent = {
  id: string;
  at: number;
  chat: string;
  from: { kind: "person" | "tex" | "system"; who?: string; name?: string };
  kind: EventKind;
  text?: string;
  replyTo?: string;
  delivered?: boolean;
  reason?: EventReason;
  turn?: string;
  covers?: string[];
  people?: string;
  told?: string;
  /** On kind "ask" only: the approval record the gateway armed. */
  ask?: string;
};

/** Where the gateway files a chat's events: the person's own texts, or a group's chat. */
export type Conversation = "texts" | { group: { key: string; members: string } };

type Kept = { e: TexEvent; w?: true };

const PREFIX = "ev:";
const SEQ = "evseq";
export const MAX_EVENT_TEXT = 3000;
export const MAX_KEPT_EVENTS = 60;
export const MAX_KEPT_CHARS = 24_000;
export const KEEP_EVENTS_MS = 24 * 60 * 60 * 1000;
/** The gateway takes at most this many per call. */
export const EVENTS_PER_POST = 50;
const FLUSH_TIMEOUT_MS = 5_000;

const WEB_ADDRESS_ONLY = /^\s*https?:\/\/\S+\s*$/i;
const PICTURE_FILE = /\.(png|jpe?g|gif|heic|heif|webp)$/i;

/** What kind of part some words and files are: a picture, a file, a link alone, or text. */
export function kindOf(text: string, attachments: readonly { filename: string; mimeType: string }[] = []): EventKind {
  if (attachments.length > 0) {
    return attachments.every(({ filename, mimeType }) => mimeType.startsWith("image/") || PICTURE_FILE.test(filename)) ? "picture" : "file";
  }
  return WEB_ADDRESS_ONLY.test(text) ? "link" : "text";
}

/** Append one event; its id, which sorts by time. */
/** A display name as the gateway takes one: letters, digits and ` ._-'@`, at most 64; none when nothing is left. */
export function displayName(name: string | undefined): string | undefined {
  const kept = (name ?? "").replace(/[^\p{L}\p{N} ._\-'@]/gu, "").trim().slice(0, 64);
  return kept === "" ? undefined : kept;
}

export async function addEvent(storage: InboxStorage, event: Omit<TexEvent, "id">): Promise<string> {
  const seq = ((await storage.get<number>(SEQ)) ?? 0) + 1;
  await storage.put(SEQ, seq);
  const at = Math.max(0, Math.floor(event.at));
  const id = `${String(at).padStart(13, "0")}-${String(seq % 1_000_000).padStart(6, "0")}`;
  const text = event.text === undefined ? {} : { text: event.text.slice(0, MAX_EVENT_TEXT) };
  const name = displayName(event.from.name);
  const from = { kind: event.from.kind, ...(event.from.who ? { who: event.from.who } : {}), ...(name ? { name } : {}) };
  await storage.put<Kept>(`${PREFIX}${id}`, { e: { ...event, ...text, from, at, id } });
  await prune(storage, event.at);
  return id;
}

/** The events kept for one chat, oldest first. */
export async function keptEvents(storage: InboxStorage, chat: string): Promise<TexEvent[]> {
  return [...(await storage.list<Kept>({ prefix: PREFIX })).values()].map((kept) => kept.e).filter((event) => event.chat === chat);
}

/** Whether the gateway has written it; kept for the window either way. */
export async function unwritten(storage: InboxStorage): Promise<TexEvent[]> {
  return [...(await storage.list<Kept>({ prefix: PREFIX })).values()].filter((kept) => !kept.w).map((kept) => kept.e);
}

/**
 * Send every event the gateway has not written, at most 50 a call, with the
 * chat's own access token (the one `/agent` takes). What it wrote is marked;
 * anything else waits for the next token. Never throws: the log is never the
 * reason an answer did not go.
 */
export async function flushEvents(
  storage: InboxStorage,
  deps: { fetch: Fetch; gatewayOrigin: string },
  accessToken: string,
  conversation: Conversation,
  chat?: string,
): Promise<void> {
  const waiting = (await unwritten(storage)).filter((event) => chat === undefined || event.chat === chat);
  // Every event in one call is the same chat's.
  const batches: TexEvent[][] = [];
  for (const key of new Set(waiting.map((event) => event.chat))) {
    const ofChat = waiting.filter((event) => event.chat === key);
    for (let start = 0; start < ofChat.length; start += EVENTS_PER_POST) batches.push(ofChat.slice(start, start + EVENTS_PER_POST));
  }
  for (const events of batches) {
    let written: string[];
    try {
      const { status, json } = await post(deps.fetch, "gateway", `${deps.gatewayOrigin}/agent/events`, accessToken, { conversation, events }, FLUSH_TIMEOUT_MS);
      if (status === 400) {
        // Refused as malformed: retrying the same batch would be refused forever, so it is dropped from the queue (kept for the window).
        const field = record(json).error_description;
        console.log(JSON.stringify({ event: "tex_events", outcome: "refused", ...(typeof field === "string" && /^[\w.\[\]-]{1,64}$/.test(field) ? { field } : {}) }));
        written = events.map((event) => event.id);
      } else if (status !== 200) return;
      else {
        const list = record(json).written;
        written = Array.isArray(list) ? list.filter((id): id is string => typeof id === "string") : [];
      }
    } catch {
      return;
    }
    for (const id of written) {
      const kept = await storage.get<Kept>(`${PREFIX}${id}`);
      if (kept !== undefined) await storage.put<Kept>(`${PREFIX}${id}`, { ...kept, w: true });
    }
  }
}

async function prune(storage: InboxStorage, now: number): Promise<void> {
  const kept = [...(await storage.list<Kept>({ prefix: PREFIX }))];
  let chars = kept.reduce((sum, [, { e }]) => sum + (e.text?.length ?? 0), 0);
  let count = kept.length;
  for (const [key, { e }] of kept) {
    if (count <= MAX_KEPT_EVENTS && chars <= MAX_KEPT_CHARS && now - e.at <= KEEP_EVENTS_MS) break;
    await storage.delete(key);
    count -= 1;
    chars -= e.text?.length ?? 0;
  }
}

/*
  The asks still waiting for a yes, by event id only, so decide can say which
  nobody is answering any more (`stale`). A stale one is sent to the gateway
  to disarm (`POST /agent/stale`) the next time a session is at hand, and
  forgotten here; an ask is never extended from here.
*/
const ASKS_KEY = "ev-asks";
const STALE_KEY = "ev-stale";
/** As long as a held ask stays armed (`apps/mcp/src/tools/approvals.js`). */
export const ASK_ARMED_MS = 12 * 60 * 60 * 1000;
const MOST_ASKS = 8;
/** `id` the ask event's id, `record` the approval record it stands for. */
type Ask = { id: string; record: string; at: number };

/** Log one ask Tex sent (`kind: "ask"`), and keep it waiting for a yes. */
export async function logAsk(storage: InboxStorage, event: Omit<TexEvent, "id" | "kind" | "ask">, record: string): Promise<void> {
  const id = await addEvent(storage, { ...event, kind: "ask", ask: record });
  const asks = ((await storage.get<Ask[]>(ASKS_KEY)) ?? []).filter((ask) => event.at - ask.at < ASK_ARMED_MS);
  await storage.put<Ask[]>(ASKS_KEY, [...asks, { id, record, at: event.at }].slice(-MOST_ASKS));
}

export async function waitingAsks(storage: InboxStorage, now: number): Promise<string[]> {
  return ((await storage.get<Ask[]>(ASKS_KEY)) ?? []).filter((ask) => now - ask.at < ASK_ARMED_MS).map((ask) => ask.id);
}

/** Decide named these asks stale: forgotten here, owed to the gateway to disarm. */
export async function markStale(storage: InboxStorage, ids: readonly string[]): Promise<void> {
  if (ids.length === 0) return;
  const asks = (await storage.get<Ask[]>(ASKS_KEY)) ?? [];
  await storage.put<Ask[]>(ASKS_KEY, asks.filter((ask) => !ids.includes(ask.id)));
  // The gateway disarms by approval record, never by event id.
  const records = asks.filter((ask) => ids.includes(ask.id)).map((ask) => ask.record);
  const owed = (await storage.get<string[]>(STALE_KEY)) ?? [];
  await storage.put<string[]>(STALE_KEY, [...new Set([...owed, ...records])].slice(-MOST_ASKS));
}

/** Everything owed to the gateway for this chat, sent with a session's token: the buffered events, then stale asks. */
export async function flushChat(
  storage: InboxStorage,
  deps: { fetch: Fetch; gatewayOrigin: string },
  accessToken: string,
  conversation: Conversation,
  chat?: string,
): Promise<void> {
  await flushEvents(storage, deps, accessToken, conversation, chat);
  const owed = (await storage.get<string[]>(STALE_KEY)) ?? [];
  if (owed.length === 0) return;
  if (await staleAsks(deps, accessToken, owed)) await storage.delete(STALE_KEY);
}

const NOT_DELIVERED: Record<EventReason, string> = {
  upload_failed: "the picture didn't reach them",
  send_refused: "the line refused it",
  held_newcomer: "held, someone joined",
  failed: "the answer failed",
  timed_out: "the answer took too long",
  too_long: "too long to send",
};

/**
 * The transcript decide is shown (section 5), newest last, at most `limit`
 * characters: oldest lines go first. "You" is Tex. A person's event no
 * delivered answer of Tex's covers is "(not answered)". With `people`, only
 * events said in front of exactly those people: a newcomer never sees what
 * came before they joined.
 */
export function renderTranscript(events: readonly TexEvent[], options: { timeZone?: string; people?: string; limit?: number } = {}): string {
  const shown = options.people === undefined ? events : events.filter((event) => event.people === options.people);
  const answered = new Set(shown.filter((event) => event.from.kind === "tex" && event.delivered !== false).flatMap((event) => event.covers ?? []));
  const zone = options.timeZone ?? "UTC";
  const day = (at: number) => new Intl.DateTimeFormat("en-US", { timeZone: zone, weekday: "long", month: "short", day: "numeric" }).format(at);
  const time = (at: number) => new Intl.DateTimeFormat("en-US", { timeZone: zone, hour: "numeric", minute: "2-digit" }).format(at);
  const lines: string[] = [];
  let lastDay = "";
  for (const event of shown) {
    if (event.kind === "delivery" || event.kind === "ask_settled") continue;
    const today = day(event.at);
    if (today !== lastDay) lines.push(`--- ${today} ---`);
    lastDay = today;
    const who = event.from.kind === "tex" ? "You" : event.from.kind === "system" ? "System" : (event.from.name ?? "Them");
    const words = event.text?.trim() || (event.kind === "picture" ? "(a picture)" : event.kind === "file" ? "(a file)" : event.kind === "reaction" ? "(a tapback)" : "");
    const unanswered = event.from.kind === "person" && !answered.has(event.id) ? "   (not answered)" : "";
    lines.push(`[${time(event.at)}] ${who}: ${words}${unanswered}`);
    if (event.from.kind === "tex" && event.delivered === false) lines.push(`           (not delivered: ${NOT_DELIVERED[event.reason ?? "failed"]})`);
  }
  const limit = options.limit ?? MAX_KEPT_CHARS;
  let out = lines.join("\n");
  while (out.length > limit && lines.length > 1) {
    lines.shift();
    out = lines.join("\n");
  }
  return out.slice(-limit);
}
