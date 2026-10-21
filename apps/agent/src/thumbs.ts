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
const ASK = /(?:Give (?:this|it) a 👍|^(?:Here's the (?:bug report|email|change) I'd|Here are the emails I'd|Before I (?:pay|do th)))/u;

/** Whether a tapback is a yes to hold: a like or a love on an ask. */
export function holdsAsYes(reaction: Reaction): boolean {
  return !reaction.removed && (reaction.how === "Liked" || reaction.how === "Loved") && ASK.test(reaction.words);
}

/** Whether a taken-back tapback could be one being held. */
export function takesBackYes(reaction: Reaction): boolean {
  return reaction.removed === true && ASK.test(reaction.words);
}

type Held<T> = { item: T; words: string; at: number };

/*
  A 👍 on any text of the reply that carried an ask is a 👍 on the ask (Dev2,
  2026-10-21: "a thumbs up should always be seen as an approval"). The ask
  goes out as its own text, and the model's line above it as another, so a 👍
  on that line used to be a tapback on nothing. The reply's texts are kept
  with its ask, and a like on one of them is taken as a like on the ask,
  whose words the gateway still checks against what is waiting.
*/
const ASK_REPLY_KEY = "askReply";
/** As long as a held ask stays armed (`apps/mcp/src/tools/approvals.js`). */
const ASK_REPLY_FOR_MS = 12 * 60 * 60 * 1000;
type AskReply = { ask: string; texts: string[]; at: number };

/** Keep the texts of a reply that carried an ask, or forget the last one when this reply carried none. */
export async function rememberAskReply(storage: InboxStorage, texts: readonly string[], now: number): Promise<void> {
  try {
    const ask = texts.find((text) => ASK.test(text));
    if (ask === undefined) await storage.delete(ASK_REPLY_KEY);
    else await storage.put<AskReply>(ASK_REPLY_KEY, { ask, texts: texts.slice(0, 8).map((text) => text.slice(0, 2_000)), at: now });
  } catch {
    // Unkept, a 👍 on the line above an ask is a tapback on that line, as before.
  }
}

/** A like or love on a text of the last reply that carried an ask, as a like on that ask; anything else as it was. */
export async function onTheAsk(storage: InboxStorage, reaction: Reaction, now: number): Promise<Reaction> {
  if (reaction.removed || (reaction.how !== "Liked" && reaction.how !== "Loved") || ASK.test(reaction.words)) return reaction;
  const kept = await storage.get<AskReply>(ASK_REPLY_KEY);
  if (kept === undefined || now - kept.at > ASK_REPLY_FOR_MS) return reaction;
  return kept.texts.some((text) => sameWords(text, reaction.words)) ? { ...reaction, words: kept.ask } : reaction;
}

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
