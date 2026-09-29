/**
 * The List's filter bar: which tasks are drawn. Pure — no React, no storage.
 *
 * Five kinds, each a menu of choices ticked as many as wanted: **Owner**
 * (Me, No owner, and each owner the tasks name), **Tag** (the tags in use),
 * **Priority** (Urgent to Low, and No priority), **Estimate** (XS to XXL, and
 * No estimate) and **Due** (Overdue, This week, Next week, No due date), plus
 * a search over names. A task matches a kind when it matches **any** of that
 * kind's ticks, and is drawn when it matches **every** kind with a tick — the
 * approved artboard (the owner, 2026-09-29), where each kind on is a chip
 * saying so ("Tag is context or portal"). Mine is the one-press way to tick
 * Owner's Me.
 *
 * It is a way of looking, per viewer: remembered in this browser like the
 * view choice (`viewMemory.ts`), never written to a note. The search is not
 * remembered; it is for now.
 *
 * Counts are over every task, subtasks included (`tasksWithSubtasks`), so
 * "No owner 3" counts the unowned subtask the filter will surface under its
 * parent.
 */

import { taskChildren, type FolderItem } from "./model";
import type { ListNote } from "../listBlock/model";
import { dueOf, estimateOf, ESTIMATES, ownersOf, priorityOf, tagsOf, type Due } from "./taskProps";

export const FILTER_KINDS = ["owner", "tag", "priority", "estimate", "due"] as const;
export type FilterKind = (typeof FILTER_KINDS)[number];

/** Owner's two choices that are not a name. A written owner never starts with a colon. */
export const OWNER_ME = ":me";
export const OWNER_NONE = ":none";
/** Priority, Estimate and Due's "No …" choice. */
export const NONE = "none";

export const PRIORITY_PICKS = ["p0", "p1", "p2", "p3", NONE] as const;
export const ESTIMATE_PICKS = [...ESTIMATES, NONE] as const;
export const DUE_PICKS = ["overdue", "this-week", "next-week", NONE] as const;

export interface ShowFilter {
  /** Words a task's name must hold; `""` for no search. */
  readonly query: string;
  /** What is ticked in each kind; empty for a kind that narrows nothing. */
  readonly picks: Readonly<Record<FilterKind, readonly string[]>>;
}

export const NO_FILTER: ShowFilter = { query: "", picks: { owner: [], tag: [], priority: [], estimate: [], due: [] } };

/** What the page knows about an owner line. */
export interface OwnerWho {
  /** The viewer, or the viewer's own agent (`@seyi's Claude`). */
  isMe(owner: string): boolean;
  isAgent(owner: string): boolean;
  /** As shown: `@seyi` for an owner written as their address. */
  label(owner: string): string;
}

const fold = (text: string) => text.trim().toLowerCase();

/** The same owner, as written or as shown. */
function sameOwner(who: OwnerWho, a: string, b: string): boolean {
  return fold(a) === fold(b) || fold(who.label(a)) === fold(who.label(b));
}

function has(list: readonly string[], value: string): boolean {
  return list.some((each) => fold(each) === fold(value));
}

/** The filter with one choice ticked, or unticked if it was. */
export function toggle(filter: ShowFilter, kind: FilterKind, value: string): ShowFilter {
  const now = filter.picks[kind];
  const next = has(now, value) ? now.filter((each) => fold(each) !== fold(value)) : [...now, value];
  return { ...filter, picks: { ...filter.picks, [kind]: next } };
}

/** The filter with nothing ticked in one kind. */
export function clearKind(filter: ShowFilter, kind: FilterKind): ShowFilter {
  return { ...filter, picks: { ...filter.picks, [kind]: [] } };
}

export function isPicked(filter: ShowFilter, kind: FilterKind, value: string): boolean {
  return has(filter.picks[kind], value);
}

/** The kinds with something ticked, in the bar's order. */
export function activeKinds(filter: ShowFilter): FilterKind[] {
  return FILTER_KINDS.filter((kind) => filter.picks[kind].length > 0);
}

/** Whether anything narrows the list: a tick or a search. */
export function isFiltered(filter: ShowFilter): boolean {
  return filter.query.trim() !== "" || activeKinds(filter).length > 0;
}

const DAY = 24 * 60 * 60 * 1000;

/** Which Due choice a day falls in, read in the viewer's own calendar; weeks run Monday to Sunday. */
export function dueWindow(due: Due | null, now: number): string | null {
  if (due === null) return NONE;
  const today = new Date(now);
  const start = new Date(today.getFullYear(), today.getMonth(), today.getDate());
  const days = Math.round((new Date(due.year, due.month - 1, due.day).getTime() - start.getTime()) / DAY);
  if (days < 0) return "overdue";
  // Days left in this week after today: Sunday has none, Monday six.
  const left = (7 - start.getDay()) % 7;
  if (days <= left) return "this-week";
  if (days <= left + 7) return "next-week";
  return null;
}

/** Whether one task matches one tick. */
function matchesPick(item: FolderItem, kind: FilterKind, pick: string, who: OwnerWho, now: number): boolean {
  switch (kind) {
    case "owner": {
      const owners = ownersOf(item.properties);
      if (pick === OWNER_ME) return owners.some((owner) => who.isMe(owner));
      if (pick === OWNER_NONE) return owners.length === 0;
      return owners.some((owner) => sameOwner(who, owner, pick));
    }
    case "tag":
      return has(tagsOf(item.properties), pick);
    case "priority": {
      const priority = priorityOf(item.properties);
      return pick === NONE ? priority === null : priority !== null && `p${priority}` === pick;
    }
    case "estimate": {
      const estimate = estimateOf(item.properties);
      return pick === NONE ? estimate === null : estimate === pick;
    }
    case "due":
      return dueWindow(dueOf(item.properties), now) === pick;
  }
}

/** Whether a task matches any of one kind's ticks. */
export function matchesKind(item: FolderItem, kind: FilterKind, picks: readonly string[], who: OwnerWho, now: number): boolean {
  return picks.some((pick) => matchesPick(item, kind, pick, who, now));
}

/** Which tasks a filter keeps; null when nothing narrows, which keeps them all. */
export function filterMatch(filter: ShowFilter, who: OwnerWho, now: number): ((item: FolderItem) => boolean) | null {
  const words = fold(filter.query).split(/\s+/).filter((word) => word !== "");
  const kinds = activeKinds(filter);
  if (words.length === 0 && kinds.length === 0) return null;
  return (item) => {
    const name = item.label.toLowerCase();
    if (!words.every((word) => name.includes(word))) return false;
    return kinds.every((kind) => matchesKind(item, kind, filter.picks[kind], who, now));
  };
}

/** Every task on the page, and every subtask in a task folder: what the counts count. */
export function tasksWithSubtasks(items: readonly FolderItem[], notes: readonly ListNote[]): FolderItem[] {
  const out: FolderItem[] = [];
  for (const item of items) {
    if (item.status === "") continue;
    out.push(item);
    if (item.kind === "folder") out.push(...taskChildren(item.path, notes).subtasks);
  }
  return out;
}

/** The ticks as stored: a versioned line of JSON. The search is left out. */
export function showFilterKey(filter: ShowFilter): string {
  return JSON.stringify({ v: 2, ...filter.picks });
}

const LEGACY: Readonly<Record<string, Partial<Record<FilterKind, string[]>>>> = {
  everyone: {},
  mine: { owner: [OWNER_ME] },
  "no-owner": { owner: [OWNER_NONE] },
  urgent: { priority: ["p0"] },
};

function strings(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((each): each is string => typeof each === "string" && each.trim() !== "") : [];
}

/**
 * A stored filter read back; null for anything that is not one. The words
 * the old Show bar stored (`mine`, `no-owner`, `urgent`, `owner:<name>`,
 * `everyone`) read as the ticks they meant, so nobody's choice is lost.
 */
export function parseShowFilter(stored: string | null | undefined): ShowFilter | null {
  if (typeof stored !== "string") return null;
  const legacy = Object.hasOwn(LEGACY, stored) ? LEGACY[stored] : undefined;
  if (legacy !== undefined) return { query: "", picks: { ...NO_FILTER.picks, ...legacy } };
  if (stored.startsWith("owner:")) {
    const owner = stored.slice("owner:".length);
    return owner.trim() === "" ? null : { query: "", picks: { ...NO_FILTER.picks, owner: [owner] } };
  }
  try {
    const read = JSON.parse(stored) as Record<string, unknown> | null;
    if (read === null || typeof read !== "object" || read.v !== 2) return null;
    const picks = { ...NO_FILTER.picks };
    for (const kind of FILTER_KINDS) picks[kind] = strings(read[kind]);
    return { query: "", picks };
  } catch {
    return null;
  }
}
