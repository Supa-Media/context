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

/** Where the gateway files a chat's events: the person's own texts, or a group's chat by its chat key (the group id). */
export type Conversation = "texts" | { group: string };

type Kept = { e: TexEvent; w?: true };

const PREFIX = "ev:";
const SEQ = "evseq";
export const MAX_EVENT_TEXT = 3000;
export const MAX_KEPT_EVENTS = 60;
export const MAX_KEPT_CHARS = 24_000;
export const KEEP_EVENTS_MS = 24 * 60 * 60 * 1000;
/** The gateway takes an event only within a day of now: one this old is dropped before it is sent, never refused there. */
export const SEND_WITHIN_MS = 23 * 60 * 60 * 1000;
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
/** Names decide's transcript already uses for its own speakers: someone named one could pass as Tex, the system or the person. */
const RESERVED_NAMES = new Set(["you", "tex", "context", "system", "them"]);

/** A display name as the gateway takes one: letters, digits and ` ._-'@`, at most 64; none when nothing is left or it is reserved. */
export function displayName(name: string | undefined): string | undefined {
  const kept = (name ?? "").replace(/[^\p{L}\p{N} ._\-'@]/gu, "").trim().slice(0, 64);
  return kept === "" || RESERVED_NAMES.has(kept.toLowerCase()) ? undefined : kept;
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
  // Words held outside the customer's bucket never outlive the day, even in a chat that goes quiet.
  await armBy(storage, at + KEEP_EVENTS_MS, at);
  return id;
}

/**
 * Wake no later than `at`: any alarm already set for sooner, a due one
 * included, is kept (a Durable Object has one alarm, and `setAlarm` replaces
 * it). A due one is a text that arrived while a drain was running and set
 * the alarm to answer it; replacing it pushed that answer back a day. The
 * alarm firing now is cleared before its handler runs, so it reads as none.
 */
export async function armBy(storage: InboxStorage, at: number, _now: number): Promise<void> {
  // A storage that cannot say which alarm is set (some tests' fakes) is left alone rather than overwritten.
  if (storage.getAlarm === undefined) return;
  const current = await storage.getAlarm();
  if (current === null || current > at) await storage.setAlarm(at);
}

/** Called from the alarm: events past the day go, and the alarm stays set for the oldest left. */
export async function pruneEvents(storage: InboxStorage, now: number): Promise<void> {
  await prune(storage, now);
  const [oldest] = (await storage.list<Kept>({ prefix: PREFIX })).values();
  if (oldest !== undefined) await armBy(storage, oldest.e.at + KEEP_EVENTS_MS, now);
}

/** The events kept for one chat, oldest first. */
export async function keptEvents(storage: InboxStorage, chat: string): Promise<TexEvent[]> {
  return [...(await storage.list<Kept>({ prefix: PREFIX })).values()].map((kept) => kept.e).filter((event) => event.chat === chat);
}

/** This chat's kept events, oldest first, written or not: what a turn is handed beside the warm copy (`warm.ts`). */
export async function recentEvents(storage: InboxStorage, chat: string): Promise<TexEvent[]> {
  return [...(await storage.list<Kept>({ prefix: PREFIX })).values()].map((kept) => kept.e).filter((event) => event.chat === chat).sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
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
  deps: { fetch: Fetch; gatewayOrigin: string; now: () => number },
  accessToken: string,
  conversation: Conversation,
  chat?: string,
): Promise<void> {
  await prune(storage, deps.now(), SEND_WITHIN_MS);
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

async function prune(storage: InboxStorage, now: number, within = KEEP_EVENTS_MS): Promise<void> {
  const kept = [...(await storage.list<Kept>({ prefix: PREFIX }))];
  let chars = kept.reduce((sum, [, { e }]) => sum + (e.text?.length ?? 0), 0);
  let count = kept.length;
  for (const [key, { e }] of kept) {
    if (count <= MAX_KEPT_EVENTS && chars <= MAX_KEPT_CHARS && now - e.at <= within) break;
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
/** `id` the ask event's id, `record` the approval record it stands for, `who` the hash of the person it asks. */
type Ask = { id: string; record: string; at: number; who: string };
/** A record owed to the gateway to disarm, and whose ask it is: only that person's session disarms it. */
type Owed = { record: string; who: string };

/** Log one ask Tex sent (`kind: "ask"`) to the person hashed `who`, with the ask line it showed (`text`), and keep it waiting for their yes. */
export async function logAsk(storage: InboxStorage, event: Omit<TexEvent, "id" | "kind" | "ask">, record: string, who: string, text: string): Promise<void> {
  const id = await addEvent(storage, { ...event, kind: "ask", ask: record, text: oneLine(text).slice(0, MAX_EVENT_TEXT) });
  const asks = ((await storage.get<Ask[]>(ASKS_KEY)) ?? []).filter((ask) => event.at - ask.at < ASK_ARMED_MS);
  await storage.put<Ask[]>(ASKS_KEY, [...asks, { id, record, at: event.at, who }].slice(-MOST_ASKS));
}

/** The asks still waiting for a yes from the person hashed `who`: nobody else's words can make their ask stale. */
export async function waitingAsks(storage: InboxStorage, now: number, who: string): Promise<string[]> {
  return ((await storage.get<Ask[]>(ASKS_KEY)) ?? []).filter((ask) => now - ask.at < ASK_ARMED_MS && ask.who === who).map((ask) => ask.id);
}

/** Decide named these asks stale: forgotten here, owed to the gateway to disarm. */
export async function markStale(storage: InboxStorage, ids: readonly string[]): Promise<void> {
  if (ids.length === 0) return;
  const asks = (await storage.get<Ask[]>(ASKS_KEY)) ?? [];
  await storage.put<Ask[]>(ASKS_KEY, asks.filter((ask) => !ids.includes(ask.id)));
  // The gateway disarms by approval record, never by event id.
  const records = asks.filter((ask) => ids.includes(ask.id)).map(({ record, who }) => ({ record, who }));
  await storage.put<Owed[]>(STALE_KEY, [...(await owedStale(storage)), ...records].slice(-MOST_ASKS));
}

async function owedStale(storage: InboxStorage): Promise<Owed[]> {
  const owed = (await storage.get<unknown[]>(STALE_KEY)) ?? [];
  return owed.filter((entry): entry is Owed => typeof (entry as Owed)?.record === "string" && typeof (entry as Owed).who === "string");
}

/**
 * Everything owed to the gateway for this chat, sent with a session's token:
 * the buffered events, then the stale asks of `who` (the hash of the person
 * whose session it is), never anyone else's.
 */
/** One flush at a time per object: a turn's flush runs beside it now (`warm.ts`), and two at once would send the same stale asks twice. */
const flushing = new WeakMap<InboxStorage, Promise<void>>();

export function flushChat(...args: Parameters<typeof flushChatNow>): Promise<void> {
  const [storage] = args;
  const next = (flushing.get(storage) ?? Promise.resolve()).catch(() => {}).then(() => flushChatNow(...args));
  flushing.set(storage, next);
  return next;
}

async function flushChatNow(
  storage: InboxStorage,
  deps: { fetch: Fetch; gatewayOrigin: string; now: () => number },
  accessToken: string,
  conversation: Conversation,
  chat: string | undefined,
  whoOf: () => Promise<string>,
): Promise<void> {
  await flushEvents(storage, deps, accessToken, conversation, chat);
  const owed = await owedStale(storage);
  if (owed.length === 0) return;
  const who = await whoOf();
  const theirs = [...new Set(owed.filter((entry) => entry.who === who).map((entry) => entry.record))];
  if (theirs.length === 0) return;
  if (await staleAsks(deps, accessToken, theirs)) await storage.put<Owed[]>(STALE_KEY, owed.filter((entry) => entry.who !== who));
}

const NOT_DELIVERED: Record<EventReason, string> = {
  upload_failed: "the picture didn't reach them",
  send_refused: "the line refused it",
  held_newcomer: "held, someone joined",
  failed: "the answer failed",
  timed_out: "the answer took too long",
  too_long: "too long to send",
};

/** Words as one line: a line break or control character in someone's words never forges a line (`apps/mcp/src/agent/logRender.js` `oneLine`). */
const BREAKS = /[\u0000-\u001f\u007f-\u009f\u2028\u2029]+/g;
export const oneLine = (text: string): string => text.replace(BREAKS, " \u23ce ");

/** A fixed Worker text (`told.ts`) as decide reads it: the gist of the gateway's words for it (`apps/mcp/src/agent/conversation.js` `TOLD`). */
const TOLD_WORDS: Record<string, string> = {
  setup: "Set them up by text and told them their notes would be ready in a couple of minutes.",
  ready: "Told them their notes are ready and asked them to connect their Gmail.",
  ready_late: "Told them their notes were taking longer than usual, so to text again in a few minutes.",
  gmail_main: "Told them their Gmail connected and is now their main email.",
  gmail: "Told them their Gmail connected.",
};

/**
 * A person as decide reads them: always "@" and a name, "@someone" with none,
 * so no name (a look-alike of "You" included) can read as Tex or the system.
 */
const speaker = (name: string | undefined): string => `@${oneLine(name ?? "").replace(/^@+/, "").trim() || "someone"}`;

/**
 * The transcript decide is shown (section 5), newest last, at most `limit`
 * characters: oldest lines go first. "You" is Tex, "Context" the system, and every person "@name" (`speaker`). A person's event no
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
    const who = event.from.kind === "tex" ? "You" : event.from.kind === "system" ? "Context" : speaker(event.from.name);
    const said = event.told ? (TOLD_WORDS[event.told] ?? "") : oneLine(event.text ?? "").trim();
    const words = said || (event.kind === "picture" ? "(a picture)" : event.kind === "file" ? "(a file)" : event.kind === "reaction" ? "(a tapback)" : "");
    const unanswered = event.from.kind === "person" && !answered.has(event.id) ? "   (not answered)" : "";
    // Each line carries its event id, so what decide is asked about by id is grounded in the line it reads.
    lines.push(`<${event.id}> [${time(event.at)}] ${who}: ${words}${unanswered}`);
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
