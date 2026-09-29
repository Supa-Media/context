/**
 * What each of the filter bar's menus offers, with how many tasks each choice
 * would show, and how a kind that is on says so as a chip ("Tag is context or
 * portal"). Pure: `ShowBar.tsx` draws these as popovers, `FilterSheet.tsx` as
 * a phone's sheet, and neither decides what is in them.
 *
 * - **Owner**: Me, the people, the AI helpers ("Any AI helper" last), then
 *   No owner; the people and helpers the tasks name, most tasks first.
 * - **Tag**: the tags in use, most used first. A tag nothing uses is not a
 *   choice, since ticking it could only empty the list.
 * - **Priority**, **Estimate**, **Due**: their fixed scales, each ending with
 *   its "No …" choice.
 */

import { ANY_AGENT } from "../owners";
import type { FolderItem } from "./model";
import type { Face } from "./Glyphs";
import {
  DUE_PICKS,
  ESTIMATE_PICKS,
  NONE,
  OWNER_ME,
  OWNER_NONE,
  PRIORITY_PICKS,
  matchesKind,
  type FilterKind,
  type OwnerWho,
  type ShowFilter,
} from "./showFilter";
import { ESTIMATE_HINTS, NO_ESTIMATE, ownersOf, priorityWord, tagsOf, type Estimate, type Priority } from "./taskProps";

export const KIND_LABELS: Readonly<Record<FilterKind, string>> = {
  owner: "Owner",
  tag: "Tag",
  priority: "Priority",
  estimate: "Estimate",
  due: "Due",
};

const DUE_LABELS: Readonly<Record<string, string>> = {
  overdue: "Overdue",
  "this-week": "This week",
  "next-week": "Next week",
  [NONE]: "No due date",
};

/** What "Any AI helper" is written as. */
export const ANY_AI_HELPER = "Any AI helper";

export interface FilterOption {
  readonly value: string;
  readonly label: string;
  readonly count: number;
  /** Owner: whose face leads the row. */
  readonly face?: Face;
  /** Priority: the glyph that leads the row. */
  readonly priority?: Priority | null;
  /** Estimate: what the size roughly means. */
  readonly detail?: string;
  /** A heading drawn above this choice: PEOPLE, AI HELPERS. */
  readonly heading?: string;
}

const fold = (text: string) => text.trim().toLowerCase();

export interface OptionsContext {
  readonly tasks: readonly FolderItem[];
  readonly who: OwnerWho;
  /** The viewer's name, for "Me"; null when the page does not know who is looking (no Me). */
  readonly me: string | null;
  readonly faceOf: (owner: string) => Face;
  readonly now: number;
}

function count(context: OptionsContext, kind: FilterKind, value: string): number {
  return context.tasks.filter((task) => matchesKind(task, kind, [value], context.who, context.now)).length;
}

function ownerLabel(who: OwnerWho, owner: string): string {
  return fold(owner) === ANY_AGENT ? ANY_AI_HELPER : who.label(owner);
}

function ownerChoices(context: OptionsContext): FilterOption[] {
  const { who } = context;
  const tally = new Map<string, { value: string; label: string; count: number; agent: boolean }>();
  for (const task of context.tasks) {
    const seen = new Set<string>();
    for (const owner of ownersOf(task.properties)) {
      if (who.isMe(owner)) continue;
      const label = ownerLabel(who, owner);
      const key = fold(label);
      if (seen.has(key)) continue;
      seen.add(key);
      const row = tally.get(key) ?? { value: owner, label, count: 0, agent: fold(owner) === ANY_AGENT || who.isAgent(owner) };
      row.count += 1;
      tally.set(key, row);
    }
  }
  const bare = (label: string) => label.replace(/^@/, "").toLowerCase();
  const rows = [...tally.values()].sort((a, b) => {
    const anyA = fold(a.value) === ANY_AGENT ? 1 : 0;
    const anyB = fold(b.value) === ANY_AGENT ? 1 : 0;
    return anyA - anyB || b.count - a.count || (bare(a.label) < bare(b.label) ? -1 : bare(a.label) > bare(b.label) ? 1 : 0);
  });
  const people = rows.filter((row) => !row.agent);
  const agents = rows.filter((row) => row.agent);
  const out: FilterOption[] = [];
  if (context.me !== null) out.push({ value: OWNER_ME, label: "Me", count: count(context, "owner", OWNER_ME), face: { kind: "person", name: context.me } });
  people.forEach((row, at) =>
    out.push({ value: row.value, label: row.label, count: row.count, face: context.faceOf(row.value), ...(at === 0 ? { heading: "PEOPLE" } : {}) }),
  );
  agents.forEach((row, at) =>
    out.push({ value: row.value, label: row.label, count: row.count, face: { kind: "agent" }, ...(at === 0 ? { heading: "AI HELPERS" } : {}) }),
  );
  out.push({ value: OWNER_NONE, label: "No owner", count: count(context, "owner", OWNER_NONE), face: { kind: "nobody" } });
  return out;
}

function tagChoices(tasks: readonly FolderItem[]): FilterOption[] {
  const tally = new Map<string, { value: string; count: number }>();
  for (const task of tasks)
    for (const tag of tagsOf(task.properties)) {
      const row = tally.get(fold(tag)) ?? { value: tag, count: 0 };
      row.count += 1;
      tally.set(fold(tag), row);
    }
  return [...tally.values()]
    .sort((a, b) => b.count - a.count || (fold(a.value) < fold(b.value) ? -1 : fold(a.value) > fold(b.value) ? 1 : 0))
    .map((row) => ({ value: row.value, label: row.value, count: row.count }));
}

/** Every choice one kind offers, with its count; the ticked ones are the filter's to say. */
export function kindOptions(kind: FilterKind, context: OptionsContext): FilterOption[] {
  switch (kind) {
    case "owner":
      return ownerChoices(context);
    case "tag":
      return tagChoices(context.tasks);
    case "priority":
      return PRIORITY_PICKS.map((value) => {
        const priority = value === NONE ? null : (Number(value.slice(1)) as Priority);
        return { value, label: priorityWord(priority), count: count(context, kind, value), priority };
      });
    case "estimate":
      return ESTIMATE_PICKS.map((value) =>
        value === NONE
          ? { value, label: NO_ESTIMATE, count: count(context, kind, value) }
          : { value, label: value, count: count(context, kind, value), detail: ESTIMATE_HINTS[value as Estimate] },
      );
    case "due":
      return DUE_PICKS.map((value) => ({ value, label: DUE_LABELS[value]!, count: count(context, kind, value) }));
  }
}

/** One tick as a chip says it: "me", "no owner", "Urgent", "M", "This week", a tag, an owner. */
export function pickWord(kind: FilterKind, value: string, who: OwnerWho): string {
  switch (kind) {
    case "owner":
      return value === OWNER_ME ? "me" : value === OWNER_NONE ? "no owner" : ownerLabel(who, value);
    case "tag":
      return value;
    case "priority":
      return value === NONE ? "no priority" : priorityWord(Number(value.slice(1)) as Priority);
    case "estimate":
      return value === NONE ? "no estimate" : value;
    case "due":
      return value === NONE ? "no due date" : DUE_LABELS[value] ?? value;
  }
}

/** "a", "a or b", "a, b or c". */
function orList(words: readonly string[]): string {
  return words.length <= 1 ? (words[0] ?? "") : `${words.slice(0, -1).join(", ")} or ${words[words.length - 1]}`;
}

/** A kind that is on, as its chip: the kind, and what it keeps ("Tag is", "context or portal"). */
export function chipWords(filter: ShowFilter, kind: FilterKind, who: OwnerWho): { kind: string; value: string } {
  return { kind: `${KIND_LABELS[kind]} is`, value: orList(filter.picks[kind].map((value) => pickWord(kind, value, who))) };
}
