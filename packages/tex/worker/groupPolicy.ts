/**
 * When Tex speaks in a group: the reply rules in one place (Dev2, 2026-10-28).
 * Pure functions over the waiting messages; the callers (`groupInbox.ts`,
 * `groupTurn.ts`, `groupStyle.ts`) read storage and act on the answer.
 *
 * - Code's (a command said to Tex by name, a reply the menu reads, a style
 *   choice): always answered by code, never put to the judge.
 * - Everything else is the one judge's, whatever the speak-up setting.
 * - The judge down: a waiting question is answered (`decideDownAnswer`), so
 *   a follow-up is never dropped silently.
 * - Decide's `wait` is believed only on a real burst (`burstStillTyped`); how
 *   often and how long is the chat's state's to cap (`chatState.ts`).
 *
 * The privacy rails (canSee, the asker's yes, newcomers, guests never
 * approving) are not here: they stay where the turn runs.
 */

/** Another message from the same sender this close before the newest makes it a burst. */
export const BURST_WINDOW_MS = 20_000;

/** One waiting message as the rules see it. */
export type Waiting = { message: { from: string; text: string }; at?: number };

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

/** Decide down, nothing addressed: the newest untagged question (ends with "?") is answered; -1 when there is none. */
export function decideDownAnswer(waiting: readonly Waiting[]): number {
  return waiting.map((item) => item.message.text.trim().endsWith("?")).lastIndexOf(true);
}
