/**
 * Which earlier text a check-in goes under (Dev, 2026-10-19: nudged at 3:02
 * about a hold Tex had flagged at 1:12 and talked through at 1:23 — "even if
 * it should be in the same thread, why isn't there continuity in the chat").
 *
 * The gateway's look says which text with them its check-in continues, as
 * that text's words (`continues`, `apps/mcp/src/agent/heartbeat.js`). Sendblue
 * threads a message under another by its `message_handle`, so the inbox keeps
 * the handles of the last few texts in the chat, theirs and Tex's, each with a
 * salted hash of its opening words, never the words: enough to find
 * "the text that starts like this" and nothing more. A check-in whose text is
 * found goes as a reply under it; one that is not goes plain, as before.
 *
 * Only Sendblue chats are kept: Linq has no threaded send (`line.ts`).
 */

import { textsFromAnswer } from "./format";
import type { InboxStorage } from "./inbox";
import { isSendblueChat } from "./sendblue";

export const THREADS_KEY = "threads";
const SALT_KEY = "threads-salt";
/** The most texts remembered; the look is shown ten turns, which can be a few texts each. */
export const MAX_THREADS = 30;
/** How much of a text's opening words is hashed. */
export const OPENING_CHARS = 64;
const HANDLE = /^[A-Za-z0-9_.:-]{1,128}$/;

/** `h`: the salted hash of the first `n` characters of the text's opening words. Never the words. */
type Kept = { id: string; chat: string; h: string; n: number; at: number };

/** A text's opening words as both sides see them: as it is texted (`textsFromAnswer`), whitespace folded, clipped. */
export function opening(text: string): string {
  const first = textsFromAnswer(text)[0] ?? "";
  return first.replace(/\s+/g, " ").trim().slice(0, OPENING_CHARS);
}

async function saltOf(storage: InboxStorage): Promise<string> {
  const kept = await storage.get<string>(SALT_KEY);
  if (typeof kept === "string" && kept !== "") return kept;
  const bytes = crypto.getRandomValues(new Uint8Array(16));
  const salt = [...bytes].map((b) => b.toString(16).padStart(2, "0")).join("");
  await storage.put(SALT_KEY, salt);
  return salt;
}

async function hashOf(salt: string, words: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(`${salt}\n${words}`));
  return [...new Uint8Array(digest)].slice(0, 12).map((b) => b.toString(16).padStart(2, "0")).join("");
}

/** Keep a text's handle (theirs, or one Tex sent) so a later check-in can go under it. Best effort: never throws. */
export async function rememberText(storage: InboxStorage, chatId: string, id: string | undefined, text: string, now: number): Promise<void> {
  try {
    if (!isSendblueChat(chatId) || typeof id !== "string" || !HANDLE.test(id)) return;
    const words = opening(text);
    if (words === "") return;
    const h = await hashOf(await saltOf(storage), words);
    const kept = (await storage.get<Kept[]>(THREADS_KEY)) ?? [];
    const next = [...kept.filter((item) => item.id !== id), { id, chat: chatId, h, n: words.length, at: now }];
    await storage.put<Kept[]>(THREADS_KEY, next.slice(-MAX_THREADS));
  } catch {
    // A text not remembered costs a later check-in its thread, never this text.
  }
}

/**
 * The handle of the newest remembered text in this chat that `continues`
 * begins like: the same opening words, or else the longest one `continues`
 * runs on past at a word's end (their text, kept with its attachments line
 * after it).
 * Undefined when none is, and the check-in goes plain.
 */
export async function threadUnder(storage: InboxStorage, chatId: string, continues: string | undefined): Promise<string | undefined> {
  if (typeof continues !== "string" || !isSendblueChat(chatId)) return undefined;
  const words = opening(continues);
  if (words === "") return undefined;
  const kept = (await storage.get<Kept[]>(THREADS_KEY)) ?? [];
  if (kept.length === 0) return undefined;
  const salt = await saltOf(storage);
  const hashes = new Map<number, string>();
  const matches = async (item: Kept): Promise<boolean> => {
    if (!hashes.has(item.n)) hashes.set(item.n, await hashOf(salt, words.slice(0, item.n)));
    return hashes.get(item.n) === item.h;
  };
  const mine = [...kept].reverse().filter((item) => item.chat === chatId && item.n <= words.length);
  // The same opening words first; then the longest shorter text that `continues` runs on past, at a word's end.
  for (const item of mine) {
    if ((item.n === OPENING_CHARS || item.n === words.length) && (await matches(item))) return item.id;
  }
  for (const item of [...mine].sort((a, b) => b.n - a.n)) {
    if (item.n < words.length && words[item.n] === " " && (await matches(item))) return item.id;
  }
  return undefined;
}
