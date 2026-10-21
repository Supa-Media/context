/**
 * A thumbs up on an ask is the yes (Dev2, 2026-10-21: "instead of asking
 * users to say yes, ask them to react like with a thumbs up ... once they have
 * a thumbs up for like 10 seconds, then you're good to go"), for every held
 * action: a bug report, an email, a calendar change, a card at checkout.
 *
 * A 👍 or ❤️ on a text that reads as one of the gateway's asks is held here
 * for `THUMB_HOLD_MS`; taking it back in that time drops it. Once it has
 * stayed, it goes to the gateway as the tapback it is, with the words it was
 * on, and the gateway decides whether those words are the ask for exactly
 * what is waiting (`apps/mcp/src/agent/textedApprovals.js`, `thumbsUpIsYes`).
 * Nothing here can release anything: it only waits.
 *
 * What it keeps: `thumb`, the one tapback being held, with the words it was
 * on, until it goes or is taken back.
 */

import type { InboxStorage } from "./inbox";
import type { Reaction } from "./reactions";

export const THUMB_HOLD_MS = 10_000;
const THUMB_KEY = "thumb";

/**
 * The openings and the closing line of the gateway's asks (`askLine`). Only a
 * text that reads as one is held; the gateway still checks the words match
 * what is waiting.
 */
const ASK = /(?:Give this a 👍 or (?:say|reply) yes|^(?:Here's the (?:bug report|email|change) I'd|Here are the emails I'd|Before I (?:pay|do th)))/u;

/** Whether a tapback is a yes to hold: a like or a love on an ask. */
export function holdsAsYes(reaction: Reaction): boolean {
  return !reaction.removed && (reaction.how === "Liked" || reaction.how === "Loved") && ASK.test(reaction.words);
}

/** Whether a taken-back tapback could be one being held. */
export function takesBackYes(reaction: Reaction): boolean {
  return reaction.removed === true && ASK.test(reaction.words);
}

type Held<T> = { item: T; words: string; at: number };

/** Hold a tapback for its ten seconds; a newer one replaces it. */
export async function holdThumb<T>(storage: InboxStorage, item: T, words: string, now: number): Promise<void> {
  await storage.put<Held<T>>(THUMB_KEY, { item, words, at: now });
  await storage.setAlarm(now + THUMB_HOLD_MS);
}

/** Drop the held tapback when it was on these words. Whether one was dropped. */
export async function dropThumb(storage: InboxStorage, words: string): Promise<boolean> {
  const held = await storage.get<Held<unknown>>(THUMB_KEY);
  if (held === undefined || !sameWords(held.words, words)) return false;
  await storage.delete(THUMB_KEY);
  return true;
}

/** The held tapback once it has stayed its ten seconds, taken out; or undefined, with the alarm set for when it will have. */
export async function dueThumb<T>(storage: InboxStorage, now: number): Promise<T | undefined> {
  const held = await storage.get<Held<T>>(THUMB_KEY);
  if (held === undefined) return undefined;
  if (now - held.at < THUMB_HOLD_MS) {
    await storage.setAlarm(held.at + THUMB_HOLD_MS);
    return undefined;
  }
  await storage.delete(THUMB_KEY);
  return held.item;
}

/** Messages may quote a long text cut short with an ellipsis; either may be the shorter. */
function sameWords(a: string, b: string): boolean {
  const fold = (text: string) => text.replace(/\s+/g, " ").replace(/\s*…\s*$/u, "").trim();
  const [x, y] = [fold(a), fold(b)];
  return x === y || x.startsWith(y) || y.startsWith(x);
}
