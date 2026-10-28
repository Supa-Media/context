/**
 * When Tex speaks in a group: the reply rules in one place (Dev2, 2026-10-28).
 * Pure functions over the waiting messages; the callers (`groupInbox.ts`,
 * `groupTurn.ts`, `groupStyle.ts`) read storage and act on the answer.
 *
 * - Addressed (its name, a reply the menu reads, a command): code's floor,
 *   always answered, never waited on (`groupWords.ts` reads the words).
 * - Untagged: the chat's style says whether decide reads it (`styleReaches`).
 * - Decide down: an untagged question that reached decide is answered
 *   (`decideDownAnswer`), so a follow-up is never dropped silently.
 * - Decide's `wait` is believed only on a real burst, at most `MAX_WAITS` in
 *   a row (`honoursWait`).
 *
 * The privacy rails (canSee, the asker's yes, newcomers, guests never
 * approving) are not here: they stay where the turn runs.
 */

import type { GroupStyle } from "./decide";

/** How long a waiting burst is decided again after the wait began, or after its sender's newest message (Dev2, 2026-10-28: 20s felt slow). */
export const WAIT_MS = 8_000;
/** Waits in a row before Tex answers anyway: one (Dev2, 2026-10-28). */
export const MAX_WAITS = 1;
/** Another message from the same sender this close before the newest makes it a burst. */
export const BURST_WINDOW_MS = 20_000;

/** One waiting message as the rules see it. */
export type Waiting = { message: { from: string; text: string }; at?: number };

/** Whether an untagged message reaches decide in this style; `asker`: its sender's ask is open; `following`: followAlong still reads. */
export function styleReaches(style: GroupStyle, asker: boolean, following: () => Promise<boolean>): Promise<boolean> | boolean {
  if (style === "helpful") return true;
  if (style === "quiet") return false;
  if (asker) return true;
  return style === "followAlong" && following();
}

/** Words that read as cut off: a trailing comma, a joining word, an ellipsis, or a short fragment with no end punctuation. */
export function looksUnfinished(text: string): boolean {
  const words = text.trim();
  if (words === "") return false;
  if (/(,|\.\.\.|…)$/.test(words) || /\b(and|but|so|or)$/i.test(words)) return true;
  return words.split(/\s+/).length < 4 && !/[.!?)]$/.test(words) && !/\p{Extended_Pictographic}️?$/u.test(words);
}

/**
 * Whether the burst is still being typed (Dev2, 2026-10-28): the newest message's sender sent another within
 * `BURST_WINDOW_MS`, or the newest looks unfinished. A single complete message never is.
 */
export function burstStillTyped(waiting: readonly Waiting[]): boolean {
  const newest = waiting.at(-1);
  if (newest === undefined) return false;
  const at = newest.at ?? 0;
  const others = waiting.slice(0, -1).filter((item) => item.message.from === newest.message.from && at - (item.at ?? 0) <= BURST_WINDOW_MS);
  return others.length > 0 || looksUnfinished(newest.message.text);
}

/** Whether decide's `wait` holds: a real burst that has waited fewer than `MAX_WAITS` times. Otherwise it is an answer. */
export function honoursWait(untagged: readonly Waiting[], waited: number): boolean {
  return waited < MAX_WAITS && burstStillTyped(untagged);
}

/** Decide down, nothing addressed: the newest untagged question (ends with "?") is answered; -1 when there is none. */
export function decideDownAnswer(waiting: readonly Waiting[]): number {
  return waiting.map((item) => item.message.text.trim().endsWith("?")).lastIndexOf(true);
}
