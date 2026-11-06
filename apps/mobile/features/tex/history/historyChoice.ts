/**
 * Which day and kinds a history view reads with, carried in the address so
 * the hub's mini history opens the full History page as it was (Dev, 2026-11-04:
 * "still have the filter, still a button to go to the full page"). Pure.
 *
 *   …/history?day=yesterday&show=texts,tools
 *
 * Only what differs from the defaults is written; anything unknown reads as
 * the default, so a hand-edited address lands on today with the usual kinds.
 */

import { DEFAULT_SHOWN, SHOWS, type DayChoice, type Show } from "./historyLines";

export interface HistoryChoice {
  day: DayChoice;
  /** The typed day, `YYYY-MM-DD`, when `day` is `pick`. */
  picked: string;
  shown: Record<Show, boolean>;
}

const DAY_WORDS: readonly DayChoice[] = ["today", "yesterday", "all"];
const PICKED = /^\d{4}-\d{2}-\d{2}$/;

const sameShown = (a: Record<Show, boolean>, b: Record<Show, boolean>) => SHOWS.every((s) => a[s] === b[s]);

/** The query a choice writes: nothing for today with the usual kinds. `show=` with nothing after it is every kind off. */
export function choiceQuery(choice: HistoryChoice): Record<string, string> {
  const query: Record<string, string> = {};
  if (choice.day === "pick" && PICKED.test(choice.picked.trim())) query.day = choice.picked.trim();
  else if (choice.day === "yesterday" || choice.day === "all") query.day = choice.day;
  if (!sameShown(choice.shown, DEFAULT_SHOWN)) query.show = SHOWS.filter((s) => choice.shown[s]).join(",");
  return query;
}

/** The choice an address names, or undefined when it names none (the page's own defaults). */
export function readChoice(day: string | undefined, show: string | undefined): HistoryChoice | undefined {
  if (day === undefined && show === undefined) return undefined;
  const choice: HistoryChoice = { day: "today", picked: "", shown: { ...DEFAULT_SHOWN } };
  if (day !== undefined) {
    if ((DAY_WORDS as readonly string[]).includes(day)) choice.day = day as DayChoice;
    else if (PICKED.test(day)) {
      choice.day = "pick";
      choice.picked = day;
    }
  }
  if (show !== undefined) {
    const on = new Set(show.split(",").map((s) => s.trim()));
    // Words that are not kinds are ignored; a list naming no kind at all but not empty keeps the defaults.
    const known = SHOWS.filter((s) => on.has(s));
    if (known.length > 0 || show.trim() === "") choice.shown = Object.fromEntries(SHOWS.map((s) => [s, on.has(s)])) as Record<Show, boolean>;
  }
  return choice;
}
