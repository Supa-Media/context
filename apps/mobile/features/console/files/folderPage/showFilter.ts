/**
 * The List's "Show" bar: whose tasks are drawn. Pure — no React, no storage.
 *
 * Everyone, Mine, No owner, Urgent, or one owner picked from the owners the
 * tasks name (people, then AI helpers, with "Any AI helper" for a task any
 * agent may pick up). It is a way of looking, per viewer: remembered in this
 * browser like the view choice (`viewMemory.ts`), never written to a note.
 *
 * Counts are over every task, subtasks included, so "No owner · 3" counts the
 * unowned subtask the filter will surface under its parent.
 */

import { ANY_AGENT } from "../owners";
import { taskChildren, type FolderItem } from "./model";
import type { ListNote } from "../listBlock/model";
import { ownersOf, priorityOf } from "./taskProps";

export type ShowFilter =
  | { readonly kind: "everyone" }
  | { readonly kind: "mine" }
  | { readonly kind: "no-owner" }
  | { readonly kind: "urgent" }
  | { readonly kind: "owner"; readonly owner: string };

export const EVERYONE: ShowFilter = { kind: "everyone" };

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

/** Which tasks a filter keeps; null for Everyone, which keeps them all. */
export function filterMatch(filter: ShowFilter, who: OwnerWho): ((item: FolderItem) => boolean) | null {
  switch (filter.kind) {
    case "everyone":
      return null;
    case "mine":
      return (item) => ownersOf(item.properties).some((owner) => who.isMe(owner));
    case "no-owner":
      return (item) => ownersOf(item.properties).length === 0;
    case "urgent":
      return (item) => priorityOf(item.properties) === 0;
    case "owner":
      return (item) => ownersOf(item.properties).some((owner) => sameOwner(who, owner, filter.owner));
  }
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

export function chipCounts(tasks: readonly FolderItem[], who: OwnerWho): { noOwner: number; urgent: number; mine: number } {
  const count = (filter: ShowFilter) => {
    const match = filterMatch(filter, who);
    return match === null ? tasks.length : tasks.filter(match).length;
  };
  return { noOwner: count({ kind: "no-owner" }), urgent: count({ kind: "urgent" }), mine: count({ kind: "mine" }) };
}

export interface OwnerOption {
  /** The owner line as a task first wrote it. */
  readonly value: string;
  readonly label: string;
  readonly count: number;
}

/** What "Any AI helper" is written as. */
export const ANY_AI_HELPER = "Any AI helper";

/**
 * The Owner list: how many tasks have no owner, how many are the viewer's,
 * and each other owner the tasks name — people, then AI helpers ("Any AI
 * helper" last) — most tasks first, then a to z; matching `query` by name.
 */
export function ownerOptions(
  tasks: readonly FolderItem[],
  who: OwnerWho,
  query: string,
): { none: number; me: number; people: OwnerOption[]; agents: OwnerOption[] } {
  let none = 0;
  let me = 0;
  const tally = new Map<string, { value: string; label: string; count: number; agent: boolean }>();
  for (const task of tasks) {
    const owners = ownersOf(task.properties);
    if (owners.length === 0) none += 1;
    if (owners.some((owner) => who.isMe(owner))) me += 1;
    const seen = new Set<string>();
    for (const owner of owners) {
      if (who.isMe(owner)) continue;
      const any = fold(owner) === ANY_AGENT;
      const label = any ? ANY_AI_HELPER : who.label(owner);
      const key = fold(label);
      if (seen.has(key)) continue;
      seen.add(key);
      const row = tally.get(key) ?? { value: owner, label, count: 0, agent: any || who.isAgent(owner) };
      row.count += 1;
      tally.set(key, row);
    }
  }
  const q = fold(query);
  const bare = (label: string) => label.replace(/^@/, "").toLowerCase();
  const rows = [...tally.values()]
    .filter((row) => q === "" || row.label.toLowerCase().includes(q))
    .sort((a, b) => {
      const anyA = fold(a.value) === ANY_AGENT ? 1 : 0;
      const anyB = fold(b.value) === ANY_AGENT ? 1 : 0;
      return anyA - anyB || b.count - a.count || (bare(a.label) < bare(b.label) ? -1 : bare(a.label) > bare(b.label) ? 1 : 0);
    });
  const strip = ({ value, label, count }: { value: string; label: string; count: number }) => ({ value, label, count });
  return { none, me, people: rows.filter((row) => !row.agent).map(strip), agents: rows.filter((row) => row.agent).map(strip) };
}

/** The filter as one word, for storage. */
export function showFilterKey(filter: ShowFilter): string {
  return filter.kind === "owner" ? `owner:${filter.owner}` : filter.kind;
}

/** A stored word read back; null for anything that is not one. */
export function parseShowFilter(stored: string | null | undefined): ShowFilter | null {
  if (typeof stored !== "string") return null;
  if (stored === "everyone" || stored === "mine" || stored === "no-owner" || stored === "urgent") return { kind: stored };
  if (stored.startsWith("owner:") && stored.slice("owner:".length).trim() !== "") return { kind: "owner", owner: stored.slice("owner:".length) };
  return null;
}
