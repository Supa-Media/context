/**
 * A task's own properties as a project list reads them: priority, owners,
 * tags and due. Pure — no React, no storage — and every one of them is a
 * frontmatter line anybody can write by hand:
 *
 *     priority: p1
 *     owner: [@sayo, Claude]
 *     tags: [kitchen, setup]
 *     due: 2026-10-03
 *
 * - **Priority** is a fixed scale, like the three status groups: `p0` to
 *   `p3`, said as Urgent, High, Medium and Low. Anything else is no priority
 *   rather than a guess. The words are the only thing the page ever shows;
 *   `p0` is how the file says it.
 * - **Owner** may name several. One is still the usual case and still one
 *   line; a list is read in order, and the first is the one a row shows.
 * - **Tags** are free words; kinds of work (bug, feature) are tags.
 * - **Due** is a calendar day, never a time: it is read and shown in the
 *   reader's own calendar, so a task due Friday is due Friday everywhere.
 *
 * See "Priority, tags, due and several owners" in
 * `docs/decisions/folder-lists.md`.
 */

import type { PropertyValue } from "../listBlock/model";

export type Priority = 0 | 1 | 2 | 3;

const PRIORITY_WORDS: Readonly<Record<Priority, string>> = { 0: "Urgent", 1: "High", 2: "Medium", 3: "Low" };
export const NO_PRIORITY = "No priority";

type Properties = Readonly<Record<string, PropertyValue>>;

function firstText(value: PropertyValue | undefined): string {
  const raw = Array.isArray(value) ? value[0] : value;
  return typeof raw === "string" ? raw.trim() : "";
}

function words(value: PropertyValue | undefined, split: boolean): string[] {
  const raw = Array.isArray(value) ? value : typeof value === "string" ? (split ? value.split(",") : [value]) : [];
  const seen = new Set<string>();
  const out: string[] = [];
  for (const item of raw) {
    const word = typeof item === "string" ? item.trim() : "";
    if (word === "" || seen.has(word.toLowerCase())) continue;
    seen.add(word.toLowerCase());
    out.push(word);
  }
  return out;
}

/** `p0`…`p3` in any case; null for none or anything else. */
export function priorityOf(properties: Properties): Priority | null {
  const match = /^p([0-3])$/i.exec(firstText(properties.priority));
  return match === null ? null : (Number(match[1]) as Priority);
}

/** Urgent, High, Medium, Low, or No priority. */
export function priorityWord(priority: Priority | null): string {
  return priority === null ? NO_PRIORITY : PRIORITY_WORDS[priority];
}

/** Urgent first, no priority last. */
export function comparePriority(a: Priority | null, b: Priority | null): number {
  return (a ?? 4) - (b ?? 4);
}

/**
 * Who owns a task, in the order written, nobody twice. A single line is one
 * owner even with a comma in it: an owner line has always been one value, and
 * splitting it would turn a name into two strangers.
 */
export function ownersOf(properties: Properties): string[] {
  return words(properties.owner, false);
}

/** Free words, as a list or one comma-separated line; each once. */
export function tagsOf(properties: Properties): string[] {
  return words(properties.tags, true);
}

export interface Due {
  readonly year: number;
  /** 1 to 12. */
  readonly month: number;
  readonly day: number;
}

/** `due: 2026-10-03` as a day of the calendar; null for anything that is not one. */
export function dueOf(properties: Properties): Due | null {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(firstText(properties.due));
  if (match === null) return null;
  const [year, month, day] = [Number(match[1]), Number(match[2]), Number(match[3])];
  const date = new Date(year, month - 1, day);
  if (date.getFullYear() !== year || date.getMonth() !== month - 1 || date.getDate() !== day) return null;
  return { year, month, day };
}

const DAY = 24 * 60 * 60 * 1000;

/**
 * Short: "Today", a weekday for the six days after it ("Fri"), and otherwise
 * the date ("Oct 3", with the year when it is not this one). A day already
 * gone is never a weekday, which would read as next week's.
 */
export function dueWord(due: Due, now: number): string {
  const date = new Date(due.year, due.month - 1, due.day);
  const today = new Date(now);
  const start = new Date(today.getFullYear(), today.getMonth(), today.getDate());
  const days = Math.round((date.getTime() - start.getTime()) / DAY);
  if (days === 0) return "Today";
  if (days > 0 && days < 7) return date.toLocaleString("en-US", { weekday: "short" });
  const month = date.toLocaleString("en-US", { month: "short" });
  return date.getFullYear() === today.getFullYear() ? `${month} ${due.day}` : `${month} ${due.day}, ${due.year}`;
}

/** Two letters for a round face: a one-word name's first two, else two words' first letters. */
export function initialsOf(name: string): string {
  const parts = name.replace(/^@/, "").trim().split(/\s+/).filter((part) => part !== "");
  if (parts.length === 0) return "?";
  const letters = parts.length === 1 ? [...parts[0]].slice(0, 2) : [[...parts[0]][0], [...parts[1]][0]];
  return letters.join("").toUpperCase();
}
