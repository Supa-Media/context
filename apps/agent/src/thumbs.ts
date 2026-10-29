/**
 * A thumbs up on an ask is the yes (Dev2, 2026-10-21: "instead of asking
 * users to say yes, ask them to react like with a thumbs up ... once they have
 * a thumbs up for like 10 seconds, then you're good to go"), for every held
 * action: a bug report, an email, a calendar change, a card at checkout.
 *
 * A 👍 or ❤️ on a text that reads as one of the gateway's asks is handed to
 * the queue here, and goes to the gateway at once as the tapback it is, with
 * the words it was on; the gateway decides whether those words are the ask
 * for exactly what is waiting (`apps/mcp/src/agent/textedApprovals.js`,
 * `thumbsUpIsYes`). Nothing here can release anything.
 *
 * It used to wait ten seconds first, so taking it back could cancel. Dev2
 * removed the wait on 2026-10-22 ("there is just no need"): `THUMB_HOLD_MS`
 * is 0, and a take-back only cancels one that has not gone yet.
 *
 * What it keeps: `thumb` (a phone's chat) or `gthumb` (a group's), the one
 * tapback being held, with the words it was on, until it goes or is taken
 * back. The two never share a key: one object's alarm drains a group's queue
 * and then a phone's (`index.ts`), and while they shared `thumb` the group
 * drain took every one-to-one 👍 as a group's and dropped it (2026-10-22).
 */

import type { InboxStorage } from "./inbox";
import type { Reaction } from "./reactions";

/** How long a 👍 on an ask waits before it goes: none (Dev2, 2026-10-22). */
export const THUMB_HOLD_MS = 0;
/** Where a phone's chat holds its 👍, and where a group's does. */
export const THUMB_KEY = "thumb";
export const GROUP_THUMB_KEY = "gthumb";

/**
 * The openings and the closing line of the gateway's asks (`askLine`). Only a
 * text that reads as one is held; the gateway still checks the words match
 * what is waiting.
 */
const ASK = /(?:Give (?:this|it) a \S+ and I['’]ll|^(?:Here['’]s (?:the (?:bug report|email|change)|what) I['’]d|Here are the emails I['’]d|Before I (?:pay|do th)))/u;

/** Whether a text of Tex's is one of the gateway's asks. */
export function isAsk(text: string): boolean {
  return ASK.test(text);
}

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

/*
  Promoting is a widening, so it is stricter than matching.

  The gateway compares a like's words to the ask for what is armed, and that
  comparison has a floor (`textedApprovals.js`, `MIN_QUOTED`). A promotion
  walks past it: by the time the gateway looks, the words ARE the ask, so
  they are always long enough and always match. The floor therefore has to
  hold here.

  `sameWords` matches a prefix either way, which is right for a take-back —
  a quote is the text it was on, cut short — and wrong for a promotion. A
  gate tells the model to say what it would change "in one short line", so a
  remembered text is often a few words, and either direction would promote a
  like on any other message that happens to share that opening.
*/
/** Fewest characters that tell one message from another, as `MIN_QUOTED` in the gateway. */
const MIN_PROMOTED = 24;

/**
 * Words as two copies of one text are compared: letters and digits only. A
 * tapback's quote comes back through Messages and the line, and the ask it
 * was on reached the person the same way, so quotes, apostrophes, the 👍 in
 * "Give it a 👍" and a cut-off "…" or "..." may each come back changed
 * (2026-10-22: a 👍 on a Slack ask reached nothing). The letters do not.
 */
function folded(value: string): string {
  return value
    .normalize("NFKC")
    .replace(/\s*(?:…|\.\.\.)\s*$/u, "")
    .replace(/[^\p{L}\p{N}]+/gu, " ")
    .trim()
    .toLowerCase();
}

/** Whether `quoted` is `text` as a message quotes it: the same words, or those words cut short. */
function quotesText(text: string, quoted: string): boolean {
  const [whole, part] = [folded(text), folded(quoted)];
  return part.length >= MIN_PROMOTED && whole.startsWith(part);
}

/**
 * A like or love on a text of the last reply that carried an ask, the ask
 * itself included, as a like on that ask in the words it was sent in;
 * anything else as it was. The gateway compares the words exactly, so the
 * copy kept here is what it gets, never the quote as the line returned it.
 */
export async function onTheAsk(storage: InboxStorage, reaction: Reaction, now: number): Promise<Reaction> {
  if (reaction.removed || (reaction.how !== "Liked" && reaction.how !== "Loved")) return reaction;
  const kept = await storage.get<AskReply>(ASK_REPLY_KEY);
  if (kept === undefined || now - kept.at > ASK_REPLY_FOR_MS) return reaction;
  // On a message whose words could not be given (`sendblueTapbacks.ts`): the ask is the one waiting; the gateway still checks it is armed.
  // One read and found not to be Tex's is not that case: it was on somebody else's message, so it names no ask (`reactions.ts` `onOther`).
  if (reaction.words === "") return reaction.onOther === true ? reaction : { ...reaction, words: kept.ask };
  return kept.texts.some((text) => quotesText(text, reaction.words)) ? { ...reaction, words: kept.ask } : reaction;
}

/** The ask of the last reply, while it can still be answered; undefined when that reply carried none. */
export async function keptAsk(storage: InboxStorage, now: number): Promise<string | undefined> {
  const kept = await storage.get<AskReply>(ASK_REPLY_KEY);
  return kept === undefined || now - kept.at > ASK_REPLY_FOR_MS ? undefined : kept.ask;
}

/** Hand a tapback to the next alarm, `THUMB_HOLD_MS` from now; a newer one replaces it. */
export async function holdThumb<T>(storage: InboxStorage, item: T, words: string, now: number, key = THUMB_KEY): Promise<void> {
  await storage.put<Held<T>>(key, { item, words, at: now });
  await storage.setAlarm(now + THUMB_HOLD_MS);
}

/** Drop the held tapback when it was on these words. Whether one was dropped. */
export async function dropThumb(storage: InboxStorage, words: string, key = THUMB_KEY): Promise<boolean> {
  const held = await storage.get<Held<unknown>>(key);
  if (held === undefined || !sameWords(held.words, words)) return false;
  await storage.delete(key);
  return true;
}

/** The held tapback once its `THUMB_HOLD_MS` is up, taken out; or undefined, with the alarm set for when it will have. */
export async function dueThumb<T>(storage: InboxStorage, now: number, key = THUMB_KEY): Promise<T | undefined> {
  const held = await storage.get<Held<T>>(key);
  if (held === undefined) return undefined;
  if (now - held.at < THUMB_HOLD_MS) {
    await storage.setAlarm(held.at + THUMB_HOLD_MS);
    return undefined;
  }
  await storage.delete(key);
  return held.item;
}

/** Messages may quote a long text cut short with an ellipsis; either may be the shorter. */
function sameWords(a: string, b: string): boolean {
  const [x, y] = [folded(a), folded(b)];
  if (x === "" || y === "") return false;
  return x === y || x.startsWith(y) || y.startsWith(x);
}
