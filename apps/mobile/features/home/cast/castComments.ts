import type { CastSaid } from "./castRun";

/**
 * The comments a phone's Context window shows (Dev2, 2026-10-01): the one
 * being written or just written, and the one before it as a faded "ghost",
 * so a reply reads as an answer to something.
 */
export interface CastComments {
  current: CastSaid | null;
  ghost: CastSaid | null;
}

export const NO_COMMENTS: CastComments = { current: null, ghost: null };

/**
 * After `said`. A finished comment that something new starts after becomes
 * the ghost; a comment's own keystrokes and its finishing replace it in place.
 */
export function commentsAfter(shown: CastComments, said: CastSaid): CastComments {
  const before = shown.current;
  const sameComment = before !== null && before.draft === true && before.who === said.who;
  if (sameComment) return { current: said, ghost: shown.ghost };
  return { current: said, ghost: before !== null && before.draft !== true ? before : shown.ghost };
}

/** The key the last character was typed on: a letter, `space`, or `null` for one the keyboard does not draw. */
export function pressedKey(text: string): string | null {
  const last = text.slice(-1);
  if (last === " ") return "space";
  return /^[a-z]$/i.test(last) ? last.toLowerCase() : null;
}
