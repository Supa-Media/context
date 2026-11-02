/**
 * What a group chat says between Tex's answers, so a tag can lean on it
 * ("Tex, go schedule this" after a back-and-forth about when to meet). The
 * owner chose the whole chat over a tagged-message-only Tex (2026-10-21:
 * "Why can't we give it the entire history like a regular chat"); see
 * docs/decisions/texting-assistant/groups.md.
 *
 * Kept only while the chat is bound to a shared workspace, not muted, and has
 * the same people as when Tex last answered (anyone joining or leaving stops
 * it until a tag resolves the chat again), and only here until the next
 * tagged message: that turn hands the lines to the
 * gateway, which files them in the chat's memory in the bound workspace, and
 * they are deleted from this object. Lines nobody tags Tex after age out in a
 * week, the oldest go first past four hundred, and "Tex, stop" drops them.
 *
 * Each line carries a hash of who was in the chat when it was said, and a turn
 * is handed only the lines said in front of exactly the people it answers:
 * somebody added later never gets what was said before they joined.
 *
 * `gwipe` is the chat's forget point as the control plane last said it
 * ("Tex, forget this chat", Dev2, 2026-11-02): a line said before it is never
 * handed to a turn, nor shown to decide (`groupTurn.ts`), and is not deleted,
 * so "Tex, undo the wipe" brings it back.
 */

import type { InboxStorage } from "./inbox";
import type { InboundAttachment } from "./inbound";
import type { GroupMessage } from "./sendblueGroups";

/** `attachments`: a picture or file sent in the chat, by Sendblue's address, read only if a tag follows (`groupInbox.ts`). */
export type ChatLine = { at: number; from: string; text: string; people: string; attachments?: InboundAttachment[] };

const CHAT_PREFIX = "gchat:";
const CHAT_SEQ = "gchatseq";
/** Who was in the chat, hashed, when it last resolved to a workspace; nothing is kept without it, or for anyone else. */
const BOUND_KEY = "gbound";
export const MAX_CHAT_LINES = 400;
export const CHAT_FOR_MS = 7 * 24 * 60 * 60 * 1000;

const WIPE_KEY = "gwipe";

/** The forget point the control plane named (`ControlAnswer` `wipedAt`); none, nothing is cut. */
export async function keepWipe(storage: InboxStorage, at: number | undefined): Promise<void> {
  if (at === undefined) await storage.delete(WIPE_KEY);
  else await storage.put(WIPE_KEY, at);
}
export const wipedAt = async (storage: InboxStorage): Promise<number> => (await storage.get<number>(WIPE_KEY)) ?? 0;

/** A message's own id and the one it replies to or is threaded under, hashed (`events.ts` `ref`, `replyRef`); none without one. */
export async function threadRefs(messageId: string, replyTo?: string): Promise<{ ref?: string; replyRef?: string }> {
  return { ...(messageId ? { ref: await sha256Hex(messageId) } : {}), ...(replyTo ? { replyRef: await sha256Hex(replyTo) } : {}) };
}

const chatKey = (seq: number) => `${CHAT_PREFIX}${String(seq).padStart(12, "0")}`;

export async function sha256Hex(value: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value));
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

/** The people in the chat, without Tex's own line, in one order. */
export function peopleOf(line: string, ...lists: (readonly string[] | null)[]): string[] {
  return [...new Set(lists.flatMap((list) => list ?? []).filter((entry) => entry !== line))].sort();
}

/**
 * The one hash of a chat's people (`peopleOf`), used everywhere one is: the
 * members a turn, a job or a review names to the gateway, Tex's events and
 * the chat's inbound events (`eventPeople`), and the chat's lines.
 */
export async function peopleHash(line: string, ...lists: (readonly string[] | null)[]): Promise<string> {
  return await sha256Hex(peopleOf(line, ...lists).join(","));
}

/** Who the webhook says was in the chat when a message was sent, hashed. */
export async function peopleKey(message: GroupMessage): Promise<string> {
  return await peopleHash(message.line, message.participants);
}

/** The webhook's people hash at the last turn, and the full one that turn used (the webhook's list and the app's members together). */
const PEOPLE_KEY = "gpeople";
type SeenPeople = { webhook: string; full: string };

/** A turn read the app's members too: what it named the gateway, for the events that follow while the webhook's list is the same. */
export async function notePeople(storage: InboxStorage, message: GroupMessage, full: string): Promise<void> {
  await storage.put<SeenPeople>(PEOPLE_KEY, { webhook: await peopleKey(message), full });
}

/**
 * The people hash an inbound event is filed under: the one the last turn
 * named the gateway, while the webhook lists the same people it did then,
 * so the gateway (which starts a reader's transcript at the first event
 * filed under the chat's current members) and decide read the same set.
 * Anything else changed, the webhook's own: less, never more.
 */
export async function eventPeople(storage: InboxStorage, message: GroupMessage): Promise<string> {
  const webhook = await peopleKey(message);
  const seen = await storage.get<SeenPeople>(PEOPLE_KEY);
  return seen?.webhook === webhook ? seen.full : webhook;
}

/** Whether `message` was said in front of the people the chat is bound for. */
export async function isBound(storage: InboxStorage, message: GroupMessage): Promise<boolean> {
  return (await storage.get<string>(BOUND_KEY)) === (await peopleKey(message));
}

/** Keep one untagged message, when the chat is bound. Whether it was kept. */
export async function keepChatLine(storage: InboxStorage, message: GroupMessage, now: number): Promise<boolean> {
  if (message.sms) return false;
  if (!(await isBound(storage, message))) return false;
  const people = await peopleKey(message);
  const seq = ((await storage.get<number>(CHAT_SEQ)) ?? 0) + 1;
  await storage.put(CHAT_SEQ, seq);
  const files = message.attachments?.length ? { attachments: message.attachments } : {};
  await storage.put<ChatLine>(chatKey(seq), { at: now, from: message.from, text: message.text, people, ...files });
  await pruneChat(storage, now);
  return true;
}

/** The lines kept before `before`, said in front of the same people as `message`, oldest first, with their keys. */
export async function chatBefore(storage: InboxStorage, message: GroupMessage, before: number, now: number): Promise<{ keys: string[]; lines: ChatLine[] }> {
  const people = await peopleKey(message);
  const since = await wipedAt(storage);
  const keys: string[] = [];
  const lines: ChatLine[] = [];
  for (const [key, line] of await storage.list<ChatLine>({ prefix: CHAT_PREFIX })) {
    // Said before the forget point: kept for an undo, never handed on, so never dropped as handed either.
    if (line.at > before || line.at < since) continue;
    keys.push(key);
    if (line.people === people && now - line.at <= CHAT_FOR_MS) lines.push(line);
  }
  return { keys, lines };
}

export async function dropChatLines(storage: InboxStorage, keys: readonly string[]): Promise<void> {
  for (const key of keys) await storage.delete(key);
}

/** Bound and answering for the people `message` was sent in front of, or not: unbinding drops every line kept. */
export async function setChatBound(storage: InboxStorage, bound: GroupMessage | null): Promise<void> {
  if (bound !== null) return void (await storage.put(BOUND_KEY, await peopleKey(bound)));
  await storage.delete(BOUND_KEY);
  await dropChatLines(storage, [...(await storage.list<ChatLine>({ prefix: CHAT_PREFIX })).keys()]);
}

async function pruneChat(storage: InboxStorage, now: number): Promise<void> {
  const kept = [...(await storage.list<ChatLine>({ prefix: CHAT_PREFIX }))];
  const over = kept.length - MAX_CHAT_LINES;
  for (const [index, [key, line]] of kept.entries()) if (index < over || now - line.at > CHAT_FOR_MS) await storage.delete(key);
}
