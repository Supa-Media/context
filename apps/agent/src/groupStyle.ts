/**
 * When Tex speaks up in a group without being named: the group's style
 * (`textGroups.engagement`, CONTRACT.md section 4), chosen by a member the
 * first time Tex is addressed there, and which untagged messages it lets
 * reach decide (`decide.ts`):
 * - quiet: none, only messages `addressesTex` accepts;
 * - attentive: also the asker's texts while their ask (`gask`) is open;
 * - followAlong (the default, and until a style is chosen): also untagged
 *   texts after Tex last spoke, until decide says the chat moved on or 20 went by;
 * - helpful: every text.
 * Whatever does not reach decide stays a chat line (`groupChat.ts`).
 *
 * What it keeps, never text: `gstyle` the style and whether it was chosen,
 * as the control plane last said; `gfollow` how many untagged texts went by
 * since Tex last spoke; `gengask` while the style question is open, the
 * message it held back (answered once someone chooses, or when half an hour
 * passes with no choice).
 */

import type { GroupStyle } from "./decide";
import { armBy } from "./events";
import type { InboxStorage } from "./inbox";
import { styleReaches } from "./groupPolicy";

const STYLE_KEY = "gstyle";
const FOLLOW_KEY = "gfollow";
const QUESTION_KEY = "gengask";
/** Untagged texts after Tex spoke that followAlong still reads. */
export const FOLLOW_TEXTS = 20;
/** How long the style question stays open for a bare "1"-"4". */
export const QUESTION_OPEN_MS = 30 * 60_000;

export const ENGAGEMENT_QUESTION =
  "Before I answer: when should I speak up here?\n\n" +
  '1 Quiet: only when someone says "Tex"\n' +
  '2 Attentive: also when I\'ve asked you to OK something, like an email, and you answer or change it without saying "Tex"\n' +
  '3 Follow-along: also when you ask a follow-up about my last answer without saying "Tex"\n' +
  "4 Helpful: also when I spot a question your notes, calendar or email can answer\n\n" +
  "Reply with 1, 2, 3 or 4.";

export const STYLE_NAMES: Record<GroupStyle, string> = { quiet: "Quiet", attentive: "Attentive", followAlong: "Follow-along", helpful: "Helpful" };

export const engagementSet = (style: GroupStyle, handle: string): string =>
  `Got it, ${STYLE_NAMES[style]} (set by ${handle}). To change it later, text "Tex, settings".`;

const BY_WORD: Record<string, GroupStyle> = {
  "1": "quiet",
  "2": "attentive",
  "3": "followAlong",
  "4": "helpful",
  quiet: "quiet",
  attentive: "attentive",
  "follow-along": "followAlong",
  "follow along": "followAlong",
  followalong: "followAlong",
  helpful: "helpful",
};

/** A reply to the style question: "1"-"4" or a style's name, any case, Tex's name optional before it. */
export function engagementChoice(text: string): GroupStyle | null {
  const words = text
    .trim()
    .replace(/^["“”'‘’`]+|["“”'‘’`]+$/g, "")
    .replace(/^(?:(?:hey|hi|ok|okay)\s+)?@?(?:tex|context)(?![\w-])[\s,:!.-]*/i, "")
    .replace(/[.!)]+$/, "")
    .trim()
    .toLowerCase();
  return BY_WORD[words] ?? null;
}

type Kept = { style: GroupStyle; chosen: boolean };

/** The style decide is told, and whether a member ever chose it; followAlong until the control plane says otherwise. */
export async function groupStyle(storage: InboxStorage): Promise<Kept> {
  return (await storage.get<Kept>(STYLE_KEY)) ?? { style: "followAlong", chosen: true };
}

export async function keepStyle(storage: InboxStorage, style: GroupStyle, chosen: boolean): Promise<void> {
  // Until it is chosen, Tex behaves as followAlong whatever the row holds.
  await storage.put<Kept>(STYLE_KEY, { style: chosen ? style : "followAlong", chosen });
}

/** Tex just answered: followAlong reads the next texts again. */
export async function texSpoke(storage: InboxStorage): Promise<void> {
  await storage.put(FOLLOW_KEY, { count: 0 });
}

/** Decide said the chat moved on from Tex's last answer. */
export async function movedOn(storage: InboxStorage): Promise<void> {
  await storage.put(FOLLOW_KEY, { count: FOLLOW_TEXTS });
}

/** Whether followAlong still reads untagged texts, counting this one. */
export async function followingAlong(storage: InboxStorage): Promise<boolean> {
  const follow = await storage.get<{ count: number }>(FOLLOW_KEY);
  if (follow === undefined || follow.count >= FOLLOW_TEXTS) return false;
  await storage.put(FOLLOW_KEY, { count: follow.count + 1 });
  return true;
}

/** Whether an untagged message reaches decide in this style; `asker`: it is from the person whose ask is open. */
export async function reachesDecide(storage: InboxStorage, style: GroupStyle, asker: boolean): Promise<boolean> {
  return await styleReaches(style, asker, () => followingAlong(storage));
}

export type HeldOriginal<T> = { item: T; at: number };

/** The style question went: open for a choice, holding the message it was asked before, and woken when it closes unanswered. */
export async function openQuestion<T>(storage: InboxStorage, now: number, original?: T): Promise<void> {
  await storage.put(QUESTION_KEY, { at: now, ...(original !== undefined ? { original } : {}) });
  if (original !== undefined) await armBy(storage, now + QUESTION_OPEN_MS, now);
}

/**
 * The alarm for a question still holding a message stays set, whatever set a
 * sooner one since (a message waiting `GROUP_TEXT_WAIT_MS`): a Durable Object
 * has one alarm, so it is put back after each drain.
 */
export async function keepQuestionAlarm(storage: InboxStorage, now: number): Promise<void> {
  const open = await storage.get<{ at: number; original?: unknown }>(QUESTION_KEY);
  if (open?.original !== undefined) await armBy(storage, open.at + QUESTION_OPEN_MS, now);
}

/** A question nobody answered in time is closed; the message it held, to answer anyway. */
export async function expiredQuestion<T>(storage: InboxStorage, now: number): Promise<T | undefined> {
  const open = await storage.get<{ at: number; original?: T }>(QUESTION_KEY);
  if (open === undefined || now - open.at < QUESTION_OPEN_MS) return undefined;
  await storage.delete(QUESTION_KEY);
  return open.original;
}

/** Whether the style question is still open. */
export async function questionOpen(storage: InboxStorage, now: number): Promise<boolean> {
  const open = await storage.get<{ at: number }>(QUESTION_KEY);
  return open !== undefined && now - open.at < QUESTION_OPEN_MS;
}

/** Close the question; the message it held, to answer now. */
export async function closeQuestion<T>(storage: InboxStorage): Promise<T | undefined> {
  const open = await storage.get<{ at: number; original?: T }>(QUESTION_KEY);
  await storage.delete(QUESTION_KEY);
  return open?.original;
}
