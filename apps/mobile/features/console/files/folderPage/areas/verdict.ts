/**
 * How an area's one metric stands against its target, in a word a cofounder
 * reads at a glance (the owner, 2026-11-26, simplifying the Areas page):
 *
 * - **Exceeds target**: past the bar (`186` against `at least 100`, `1.8`
 *   against `under 4`).
 * - **On target**: exactly at an inclusive bar (`100%` against `100%`).
 * - **On pace**: a goal still being climbed toward that is at or above a
 *   straight line from its first reading to its goal date.
 * - **Under target**: a goal still being climbed toward that is below that
 *   line, or below its goal when it names no date ("for a metric like this it
 *   should show under target").
 * - **Needs a look**: a limit that is broken (`$1,121` against `under $500`).
 *
 * A target with no direction is a goal to reach (`100` reads as "at least
 * 100"), except a bare `0`, which is a limit ("at most 0": failed deploys,
 * open security items). A goal date follows the target: `100 by 2026-12-31`
 * or `100 by Dec 31`. Times compare across units, as `meetsTarget` does.
 *
 * Pure, so every word is tested without drawing anything.
 */

import { directedTarget, leadingNumber, timeOf } from "./readings";

export type VerdictKind = "exceeds" | "on" | "pace" | "under" | "over";

export interface Verdict {
  readonly kind: VerdictKind;
  /** "Exceeds target", "Under target". */
  readonly words: string;
  /** Good news (exceeds, on target, on pace) draws green; the rest amber. */
  readonly good: boolean;
  /** For a goal with a date: "A straight line from 3 on Oct 1 to 100 by Dec 31 is about 62 by now."; else "". */
  readonly pace: string;
}

const WORDS: Record<VerdictKind, string> = {
  exceeds: "Exceeds target",
  on: "On target",
  pace: "On pace",
  under: "Under target",
  over: "Needs a look",
};

/** The first reading the trend holds, for the pace line's start. */
export interface Start {
  readonly value: number;
  /** Epoch ms. */
  readonly at: number;
}

type Direction = { readonly up: boolean; readonly inclusive: boolean };

interface Goal {
  readonly direction: Direction;
  /** The bar as written, without its direction word or date: `$500`, `30 min`. */
  readonly bar: string;
  /** Epoch ms of the goal date, or null when none is written. */
  readonly by: number | null;
  /** The date as written, for the pace sentence. */
  readonly byWords: string;
}

const DAY = 86_400_000;
const MONTHS = ["jan", "feb", "mar", "apr", "may", "jun", "jul", "aug", "sep", "oct", "nov", "dec"];

/** `2026-12-31`, `Dec 31`, `31 December 2026`: epoch ms at the end of that day (UTC), or null. */
export function goalDate(text: string, now: number): number | null {
  const said = text.trim();
  const iso = /^(\d{4})-(\d{1,2})-(\d{1,2})$/.exec(said);
  if (iso !== null) return Date.UTC(Number(iso[1]), Number(iso[2]) - 1, Number(iso[3])) + DAY - 1;
  const words = said.toLowerCase().replace(/,/g, " ").split(/\s+/).filter((w) => w !== "");
  let month = -1;
  let day = -1;
  let year = -1;
  for (const word of words) {
    const m = MONTHS.indexOf(word.slice(0, 3));
    if (m !== -1 && /^[a-z]+$/.test(word)) month = m;
    else if (/^\d{4}$/.test(word)) year = Number(word);
    else if (/^\d{1,2}(st|nd|rd|th)?$/.test(word)) day = parseInt(word, 10);
  }
  if (month === -1 || day < 1 || day > 31) return null;
  const thisYear = new Date(now).getUTCFullYear();
  const at = (y: number) => Date.UTC(y, month, day) + DAY - 1;
  if (year !== -1) return at(year);
  // No year: the next such date, so "Dec 31" written in November is this December.
  return at(thisYear) >= now - DAY * 31 ? at(thisYear) : at(thisYear + 1);
}

function goalOf(target: string, now: number): Goal | null {
  const byAt = /\s+by\s+(.+)$/i.exec(target);
  const byWords = byAt === null ? "" : byAt[1]!.trim();
  const by = byAt === null ? null : goalDate(byWords, now);
  const said = directedTarget(byAt === null ? target : target.slice(0, byAt.index)).trim();
  const word = /^(under|below|less than|at most|<=|<|≤|over|above|more than|at least|>=|>|≥)\s*/i.exec(said);
  const bar = word === null ? said : said.slice(word[0].length).trim();
  if (leadingNumber(bar) === null) return null;
  if (word === null) {
    // A bare number is a goal to reach; a bare zero is a limit.
    const zero = leadingNumber(bar) === 0;
    return { direction: { up: !zero, inclusive: true }, bar, by, byWords };
  }
  const w = word[1]!.toLowerCase();
  const up = /^(over|above|more than|at least|>=|>|≥)$/.test(w);
  const inclusive = /^(at most|at least|<=|>=|≤|≥)$/.test(w);
  return { direction: { up, inclusive }, bar, by, byWords };
}

/** The value and the bar as numbers on one scale: times in ms when both carry a unit. */
function onOneScale(value: string, bar: string): { have: number; limit: number; scale: number } | null {
  const barTime = timeOf(bar);
  const haveTime = timeOf(value);
  if (barTime !== null && haveTime !== null) {
    const have = leadingNumber(value);
    // The readings' own unit per ms, so a pace sentence speaks in the value's unit.
    const scale = have === null || haveTime === 0 ? 1 : have / haveTime;
    return { have: haveTime, limit: barTime, scale };
  }
  const have = leadingNumber(value);
  const limit = leadingNumber(bar);
  if (have === null || limit === null) return null;
  return { have, limit, scale: 1 };
}

function shortDate(at: number): string {
  const d = new Date(at);
  return `${MONTHS[d.getUTCMonth()]!.charAt(0).toUpperCase()}${MONTHS[d.getUTCMonth()]!.slice(1)} ${d.getUTCDate()}`;
}

function round(n: number): string {
  const r = Math.abs(n) >= 10 ? Math.round(n) : Math.round(n * 10) / 10;
  return String(r);
}

const verdict = (kind: VerdictKind, pace = ""): Verdict => ({ kind, words: WORDS[kind], good: kind === "exceeds" || kind === "on" || kind === "pace", pace });

/**
 * The verdict on `value` against `target`; null with no value, no target, or
 * either side without a number. `start` is the trend's first reading, for a
 * goal with a date.
 */
export function verdictOf(value: string | null, target: string | null, start: Start | null, now: number): Verdict | null {
  if (value === null || target === null) return null;
  const goal = goalOf(target, now);
  if (goal === null) return null;
  const both = onOneScale(value, goal.bar);
  if (both === null) return null;
  const { have, limit } = both;
  const { up, inclusive } = goal.direction;
  if (have === limit) return inclusive ? verdict("on") : verdict(up ? "under" : "over");
  const beats = up ? have > limit : have < limit;
  if (beats) return verdict("exceeds");
  if (!up) return verdict("over");
  // A goal still being climbed toward: on pace when at or above the straight line to its date.
  if (goal.by === null || start === null || goal.by <= start.at) return verdict("under");
  const share = Math.min(1, Math.max(0, (now - start.at) / (goal.by - start.at)));
  const startOnScale = start.value / both.scale;
  const expected = startOnScale + (limit - startOnScale) * share;
  const unit = value.replace(/^[^\d.-]*-?\d[\d,]*(?:\.\d+)?/, "").trim();
  const prefix = /^[^\d.-]*/.exec(value)?.[0] ?? "";
  const shown = (n: number) => `${prefix}${round(n * both.scale)}${unit === "" ? "" : unit.startsWith("%") ? unit : ` ${unit}`}`;
  const pace = `A straight line from ${shown(startOnScale)} on ${shortDate(start.at)} to ${goal.bar} by ${goal.byWords} is about ${shown(expected)} by now.`;
  return verdict(have >= expected ? "pace" : "under", pace);
}

/**
 * A target as a row says it in words: `at least 100` → `aim 100+`, `under $500`
 * → `under $500`, `100` → `of 100`, `0` → `aim 0`; a goal date is left to the
 * panel. A target it cannot read is returned as written.
 */
export function goalWords(target: string): string {
  const said = directedTarget(target.replace(/\s+by\s+.+$/i, "")).trim();
  const word = /^(under|below|less than|at most|<=|<|≤|over|above|more than|at least|>=|>|≥)\s*/i.exec(said);
  const bar = word === null ? said : said.slice(word[0].length).trim();
  if (word === null) {
    if (leadingNumber(bar) === null) return said;
    return leadingNumber(bar) === 0 ? `aim ${bar}` : `of ${bar}`;
  }
  const w = word[1]!.toLowerCase();
  if (/^(under|below|less than|<)$/.test(w)) return `under ${bar}`;
  if (/^(at most|<=|≤)$/.test(w)) return `at most ${bar}`;
  if (/^(at least|>=|≥)$/.test(w)) return `aim ${bar}+`;
  return `over ${bar}`;
}
