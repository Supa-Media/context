/**
 * When Tex speaks up in a group without being named: the group's style
 * (`textGroups.engagement`, CONTRACT.md section 4), chosen by a member the
 * first time Tex answers there. It is the one judge's to read, never a gate in
 * code (Dev2, 2026-11-11): every message reaches the judge, which is told the
 * level (`textDecide.cjs` `STYLE_RULES`):
 * - quiet: only what is for Tex (a tag, its name, a reply to it, an answer to its question);
 * - attentive: also the asker's follow-ups while Tex waits on their ask;
 * - followAlong (the default, and until a style is chosen): also follow-ups to what Tex just said;
 * - helpful: also where Tex can genuinely help, and a react to news.
 *
 * What it keeps, never text: `gstyle` the style and whether it was chosen,
 * as the control plane last said; `gengask` while the style question is open,
 * the message it held back (answered once someone chooses, or when half an
 * hour passes with no choice).
 */

import type { GroupStyle } from "./decide";
import { armBy } from "./events";
import type { InboxStorage } from "./inbox";

const STYLE_KEY = "gstyle";
const QUESTION_KEY = "gengask";
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



export type HeldOriginal<T> = { item: T; at: number };

/** The style question went: open for a choice, holding the message it was asked before, and woken when it closes unanswered. */
export async function openQuestion<T>(storage: InboxStorage, now: number, original?: T): Promise<void> {
  await storage.put(QUESTION_KEY, { at: now, ...(original !== undefined ? { original } : {}) });
  if (original !== undefined) await armBy(storage, now + QUESTION_OPEN_MS, now);
}

/**
 * The alarm for a question still holding a message stays set, whatever set a
 * sooner one since (a burst decide held, `chatState.ts`): a Durable Object
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
