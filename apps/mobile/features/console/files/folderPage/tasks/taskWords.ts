/**
 * The words a task is described in, as data: its priority, its due date, its
 * tags, and an `@name` typed into its title.
 *
 * On disk these are frontmatter lines (`priority: p1`, `due: 2026-10-03`,
 * `tags: [bug, kitchen]`); on screen they are never that. A priority is
 * Urgent, High, Medium or Low — nobody is shown "P0" — and a due date is
 * "Today", "Fri" or "Oct 3". Pure: no React, no storage.
 */

import { knownAgent } from "../../agentOwners";
import type { ListNote, PropertyValue } from "../../listBlock/model";
import type { OwnerResults } from "../../owners";

/** `priority:` values, most urgent first: a fixed scale, like the three status groups. */
export const PRIORITIES = ["p0", "p1", "p2", "p3"] as const;
export type Priority = (typeof PRIORITIES)[number];

/** What each priority is called on screen. */
export const PRIORITY_LABELS: Readonly<Record<Priority, string>> = {
  p0: "Urgent",
  p1: "High",
  p2: "Medium",
  p3: "Low",
};
export const NO_PRIORITY_LABEL = "No priority";

/** A `priority:` value as written, read as a priority; null for anything else. */
export function priorityOf(value: PropertyValue | undefined): Priority | null {
  const raw = Array.isArray(value) ? value[0] : value;
  const folded = typeof raw === "string" ? raw.trim().toLowerCase() : "";
  return (PRIORITIES as readonly string[]).includes(folded) ? (folded as Priority) : null;
}

export function priorityLabel(priority: Priority | null): string {
  return priority === null ? NO_PRIORITY_LABEL : PRIORITY_LABELS[priority];
}

/* --------------------------------- due --------------------------------- */

const ISO = /^(\d{4})-(\d{2})-(\d{2})$/;
const MONTHS = ["jan", "feb", "mar", "apr", "may", "jun", "jul", "aug", "sep", "oct", "nov", "dec"];
const MONTH_LABELS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
const DAY_LABELS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];

const pad = (value: number) => String(value).padStart(2, "0");

/** A day on the device's calendar as `YYYY-MM-DD`. */
export function isoDay(date: Date): string {
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
}

/** A `YYYY-MM-DD` that names a real day, as a local midnight; null otherwise. */
export function parseIsoDay(text: string): Date | null {
  const match = ISO.exec(text.trim());
  if (match === null) return null;
  const [year, month, day] = [Number(match[1]), Number(match[2]), Number(match[3])];
  const date = new Date(year, month - 1, day);
  return date.getFullYear() === year && date.getMonth() === month - 1 && date.getDate() === day ? date : null;
}

function addDays(date: Date, days: number): Date {
  return new Date(date.getFullYear(), date.getMonth(), date.getDate() + days);
}

export type DuePreset = "today" | "tomorrow" | "next-week";
export const DUE_PRESET_LABELS: Readonly<Record<DuePreset, string>> = {
  today: "Today",
  tomorrow: "Tomorrow",
  "next-week": "Next week",
};

/** The day a preset names from `now`: next week is the coming Monday. */
export function duePreset(preset: DuePreset, now: Date): string {
  if (preset === "today") return isoDay(now);
  if (preset === "tomorrow") return isoDay(addDays(now, 1));
  const toMonday = ((8 - now.getDay()) % 7) || 7;
  return isoDay(addDays(now, toMonday));
}

/**
 * A date somebody typed: `2026-10-03`, `Oct 3`, `3 Oct` or `October 3`,
 * as `YYYY-MM-DD`. A month and day with no year is the next one on or after
 * today. Null when it is not a day.
 */
export function parseDueText(text: string, now: Date): string | null {
  const trimmed = text.trim();
  const iso = parseIsoDay(trimmed);
  if (iso !== null) return isoDay(iso);
  const words = trimmed.toLowerCase().replace(/,/g, " ").split(/\s+/).filter((word) => word !== "");
  if (words.length < 2 || words.length > 3) return null;
  const monthAt = words.findIndex((word) => MONTHS.some((month) => word.startsWith(month) && month.length >= 3));
  if (monthAt === -1 || monthAt > 1) return null;
  const month = MONTHS.findIndex((name) => words[monthAt]!.startsWith(name));
  const dayWord = words[monthAt === 0 ? 1 : 0]!;
  if (!/^\d{1,2}$/.test(dayWord)) return null;
  const day = Number(dayWord);
  const yearWord = words[2];
  if (yearWord !== undefined && !/^\d{4}$/.test(yearWord)) return null;
  const today = addDays(now, 0);
  let year = yearWord === undefined ? now.getFullYear() : Number(yearWord);
  let date = new Date(year, month, day);
  if (yearWord === undefined && date < today) date = new Date((year += 1), month, day);
  if (date.getMonth() !== month || date.getDate() !== day) return null;
  return isoDay(date);
}

/** A due day as a row shows it: Today, Tomorrow, a weekday within the week, else "Oct 3" (with the year when not this one). */
export function dueLabel(iso: string, now: Date): string {
  const date = parseIsoDay(iso);
  if (date === null) return iso;
  const days = Math.round((date.getTime() - addDays(now, 0).getTime()) / 86_400_000);
  if (days === 0) return "Today";
  if (days === 1) return "Tomorrow";
  if (days > 1 && days < 7) return DAY_LABELS[date.getDay()]!;
  const short = `${MONTH_LABELS[date.getMonth()]} ${date.getDate()}`;
  return date.getFullYear() === now.getFullYear() ? short : `${short}, ${date.getFullYear()}`;
}

/* --------------------------------- tags -------------------------------- */

/** A tag as written: one word or a few, without the characters a list cannot hold. */
export function cleanTag(text: string): string | null {
  const tag = text.trim().replace(/^#+/, "").replace(/\s+/g, " ").trim();
  if (tag === "" || /[,[\]"'#\p{Cc}]/u.test(tag) || tag.length > 40) return null;
  return tag;
}

function wordsIn(value: PropertyValue | undefined): string[] {
  const list = Array.isArray(value) ? value : typeof value === "string" ? value.split(",") : [];
  return list.filter((item): item is string => typeof item === "string").map((item) => item.trim()).filter((item) => item !== "");
}

/** The tags notes under `folder` use, most used first, spelled as first seen. */
export function tagsInUse(notes: readonly Pick<ListNote, "path" | "properties">[], folder = ""): string[] {
  const prefix = folder === "" ? "" : `${folder}/`;
  const tally = new Map<string, { tag: string; count: number; first: number }>();
  let order = 0;
  for (const note of notes) {
    if (!note.path.startsWith(prefix)) continue;
    for (const tag of wordsIn(note.properties.tags)) {
      const key = tag.toLowerCase();
      const row = tally.get(key) ?? { tag, count: 0, first: order++ };
      row.count += 1;
      tally.set(key, row);
    }
  }
  return [...tally.values()].sort((a, b) => b.count - a.count || a.first - b.first).map((row) => row.tag);
}

/** `tags` with `tag` added, or removed when it is there already (ignoring case). */
export function toggleWord(list: readonly string[], word: string): string[] {
  const folded = word.toLowerCase();
  return list.some((item) => item.toLowerCase() === folded)
    ? list.filter((item) => item.toLowerCase() !== folded)
    : [...list, word];
}

/* ------------------------------- @mentions ------------------------------ */

const MENTION = /(^|\s)@([\p{L}\p{N}][\p{L}\p{N}._-]*)/u;

/**
 * The first `@name` in a title, and the title without it. An address
 * (`sayo@example.com`) is not a mention: the `@` has to start a word.
 */
export function parseMention(title: string): { title: string; mention: string | null } {
  const match = MENTION.exec(title);
  if (match === null) return { title: title.trim(), mention: null };
  const mention = match[2]!.replace(/[._-]+$/, "");
  const at = match.index + match[1]!.length;
  const rest = `${title.slice(0, at)}${title.slice(at + 1 + mention.length)}`;
  return { title: rest.replace(/\s+/g, " ").trim(), mention };
}

/**
 * The owner an `@name` means, among what an owner search returned for it: a
 * person whose handle is it (`@sayo`), else the one person whose name starts
 * with it, else an agent of that name. Null when nobody, or more than one
 * person, fits — a guess would assign the work to somebody else.
 */
export function resolveMention(mention: string, results: OwnerResults): string | null {
  const folded = mention.trim().toLowerCase().replace(/^@/, "");
  if (folded === "") return null;
  const people = results.people;
  const handle = people.find((person) => {
    const value = person.value.toLowerCase();
    return value === `@${folded}` || value === folded;
  });
  if (handle !== undefined) return handle.value;
  const named = people.filter((person) =>
    [person.name ?? "", person.value.replace(/^@/, "")].some((name) => (name.toLowerCase().split(/\s+/)[0] ?? "") === folded),
  );
  if (named.length === 1) return named[0]!.value;
  if (named.length > 1) return null;
  return knownAgent(results.agents, mention.replace(/^@/, ""));
}
