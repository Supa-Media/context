/**
 * The chat as this Worker reads it: the gateway's ledger, which holds every
 * text the chat has had, with this object's outbox (the events not posted yet)
 * on top (Dev, 2026-11-02: "Outbox only, read the ledger";
 * `docs/decisions/texting-assistant/chat-ledger.md`, "Retiring the old copies").
 *
 * Before this the Worker kept its own copy of the chat's last day beside the
 * ledger. Now it keeps only the events it has not posted (`events.ts`), and
 * every reader that wants the chat (decide, the recheck, a reaction on Tex's
 * own text, a progress line said once, the review watch) asks the gateway for
 * the chat's last day (`POST /agent/chat`, the gateway's `textingRoutes.js`
 * `handleChat`) with the chat's own access token.
 *
 * The token is held in memory only, never in storage, from the last turn that
 * opened a session for the chat. With none (an object that just woke), or when
 * the gateway does not answer in time, the reader gets the outbox alone and
 * the outcome is counted (`tex_chat_read`), never a wait it can't afford.
 */

import { post, record, type Fetch } from "./clients";
import { flushByLedgerInLine, flushEventsInLine, keptEvents, type Conversation, type LedgerWrite, type TexEvent } from "./events";
import type { InboxStorage } from "./inbox";

/** The longest a reader waits for the chat: decide waits on it, and decide is on a person's way to their answer. */
export const CHAT_READ_MS = 1_500;
const EVENT_ID = /^\d{13}-\d{6}$/;

/** How to ask the gateway for one chat: its last access token and conversation, and the Worker's fetch. In memory only. */
export type ChatReader = { token: string; conversation: Conversation; fetch: Fetch; gatewayOrigin: string };
const readers = new WeakMap<InboxStorage, Map<string, ChatReader>>();

/** What a turn opened for `chat` (its session's token), so the next read of that chat can ask the gateway. */
export function rememberChatReader(storage: InboxStorage, chat: string, reader: ChatReader): void {
  if (chat === "" || reader.token === "" || !reader.gatewayOrigin) return;
  const held = readers.get(storage) ?? new Map<string, ChatReader>();
  held.set(chat, reader);
  readers.set(storage, held);
}

/** An event as the gateway answered it, checked enough to read: its id, time, chat and who. */
function readEvent(value: unknown, chat: string): TexEvent | null {
  const event = record(value);
  const from = record(event.from);
  if (typeof event.id !== "string" || !EVENT_ID.test(event.id) || typeof event.at !== "number" || !Number.isFinite(event.at)) return null;
  if (event.chat !== chat || (from.kind !== "person" && from.kind !== "tex" && from.kind !== "system") || typeof event.kind !== "string") return null;
  return event as unknown as TexEvent;
}

/**
 * The chat's last day, oldest first: the gateway's ledger with this object's
 * outbox on top, one event per id. The outbox alone when no turn has opened
 * the chat since this object woke, or the gateway did not answer in time.
 */
export async function chatEvents(storage: InboxStorage, chat: string, timeoutMs = CHAT_READ_MS, byLedger?: LedgerRead): Promise<TexEvent[]> {
  const outbox = await keptEvents(storage, chat);
  const reader = readers.get(storage)?.get(chat);
  // No token since this object woke: a group's judge asks the gateway by the chat's ledger key over the binding, so it
  // never reads the newest texts alone (34 of 53 reads did, 2026-11-10 to 11-12).
  const read = reader !== undefined ? await fromGateway(reader, chat, timeoutMs) : byLedger !== undefined ? await fromLedgerKey(byLedger, chat, timeoutMs) : null;
  const outcome = reader !== undefined ? (read === null ? "failed" : "gateway") : byLedger === undefined ? "no_token" : read === null ? "ledger_failed" : "ledger";
  console.log(JSON.stringify({ event: "tex_chat_read", outcome }));
  const byId = new Map<string, TexEvent>();
  for (const event of [...(read ?? []), ...outbox]) byId.set(event.id, event);
  return [...byId.values()].sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
}

/** A group chat's ledger key and the gateway binding to read it by (`apps/mcp/src/agent/textsDecide.js` `chatForTexts`). */
export type LedgerRead = { binding: { fetch: (input: string, init?: RequestInit) => Promise<Response> }; ledger: string };
export const GATEWAY_CHAT_URL = "https://gateway/texts/chat";

async function fromLedgerKey(by: LedgerRead, chat: string, timeoutMs: number): Promise<TexEvent[] | null> {
  try {
    const { status, json } = await post((input, init) => by.binding.fetch(String(input), init), "gateway", GATEWAY_CHAT_URL, "", { ledger: by.ledger, chat }, timeoutMs);
    if (status !== 200) return null;
    const events = record(json).events;
    if (!Array.isArray(events)) return null;
    return events.map((event) => readEvent(event, chat)).filter((event): event is TexEvent => event !== null);
  } catch {
    return null;
  }
}

async function fromGateway(reader: ChatReader, chat: string, timeoutMs: number): Promise<TexEvent[] | null> {
  try {
    const body = reader.conversation === "texts" ? { conversation: "texts", chat } : { conversation: reader.conversation };
    const { status, json } = await post(reader.fetch, "gateway", `${reader.gatewayOrigin}/agent/chat`, reader.token, body, timeoutMs);
    if (status !== 200) return null;
    const events = record(json).events;
    if (!Array.isArray(events)) return null;
    return events.map((event) => readEvent(event, chat)).filter((event): event is TexEvent => event !== null);
  } catch {
    return null;
  }
}

/**
 * Send what the chat said since the last flush to its ledger now, so the chat's history on the app keeps up with it.
 * Without this a group's chatter between Tex's turns (anything nobody asked Tex) waited in the outbox until somebody
 * next addressed Tex. With the token the chat's last turn opened, when this object holds one; otherwise, for a group
 * Tex is set up in (`byLedger`), by the chat's ledger key over the gateway binding, which needs no token: the token
 * lives only in memory, so after a deploy or an idle hour texts were written to the ledger hours late (Tex Devs,
 * 2026-11-12 and 13). An expired token is refused by the gateway and the events wait for the next turn, as before.
 * Answers how it went: `token`, `ledger`, or `none` when it had neither. Never throws.
 */
export async function flushWithReader(storage: InboxStorage, chat: string, now: () => number, byLedger?: LedgerWrite): Promise<"token" | "ledger" | "none"> {
  const reader = readers.get(storage)?.get(chat);
  try {
    if (reader !== undefined) {
      await flushEventsInLine(storage, { fetch: reader.fetch, gatewayOrigin: reader.gatewayOrigin, now }, reader.token, reader.conversation, chat);
      return "token";
    }
    if (byLedger !== undefined) {
      await flushByLedgerInLine(storage, byLedger, chat, now);
      return "ledger";
    }
  } catch {
    // The outbox keeps them for the next turn's flush.
  }
  return reader !== undefined ? "token" : byLedger !== undefined ? "ledger" : "none";
}
