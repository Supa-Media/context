/**
 * A goal's shape, split from its number so the side panel picks it from a
 * dropdown and never has it typed (the owner, 2026-11-26, on Failed deploys:
 * "there should just be a dropdown for the different shapes a metric can
 * take", "it shouldnt be typed out").
 *
 * A target is still one line of text in the area's `about.md`
 * (`Failed deploys · target at most 2`); this only reads it as a shape and
 * the rest, and writes the two back as one line. The shapes are At least, At
 * most, More than and Less than (`under $500` reads as Less than). A bare number is a goal to reach (`At least`), a bare zero a
 * limit (`At most`), as `verdict.ts` reads them.
 *
 * Pure, so every split and join is tested without drawing anything.
 */

import { directedTarget, leadingNumber } from "./readings";

export type GoalWord = "At least" | "At most" | "More than" | "Less than";

/** Every shape, in the dropdown's order, with what it means in a few words. */
export const GOAL_SHAPES: ReadonlyArray<{ readonly word: GoalWord; readonly detail: string }> = [
  { word: "At least", detail: "More is better" },
  { word: "At most", detail: "Fewer is better" },
  { word: "More than", detail: "Must pass it" },
  { word: "Less than", detail: "Must stay below it" },
];

export interface GoalParts {
  readonly word: GoalWord;
  /** The rest as written: `2`, `$500`, `100 by Dec 31`. */
  readonly bar: string;
}

const LEADING = /^(under|below|less than|at most|<=|<|≤|over|above|more than|at least|>=|>|≥)\s*/i;

function wordOf(said: string): GoalWord {
  const w = said.toLowerCase();
  if (/^(at most|<=|≤)$/.test(w)) return "At most";
  if (/^(at least|>=|≥)$/.test(w)) return "At least";
  if (/^(under|below|less than|<)$/.test(w)) return "Less than";
  return "More than";
}

/** The direction word and the rest of a target; a target with no number keeps `At least` and its words as the bar. */
export function goalParts(target: string | null): GoalParts {
  const said = directedTarget((target ?? "").trim()).trim();
  const word = LEADING.exec(said);
  if (word !== null) return { word: wordOf(word[1]!), bar: said.slice(word[0].length).trim() };
  const bar = said.replace(/\s+by\s+.+$/i, "");
  return { word: leadingNumber(bar) === 0 ? "At most" : "At least", bar: said };
}

/**
 * The one line a shape and a bar write: `At most` and `2` → `at most 2`. A bar
 * typed with its own direction word is taken as written (an older habit), and
 * an empty bar is no target at all.
 */
export function goalTarget(word: GoalWord, bar: string): string | null {
  const typed = bar.trim();
  if (typed === "") return null;
  if (LEADING.test(directedTarget(typed))) return typed;
  return `${word.toLowerCase()} ${typed}`;
}
