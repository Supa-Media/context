/**
 * @shared: everything shared with you by name, across workspaces you may not
 * belong to — the Google Drive "Shared with me" (Dev2, 2026-10-14, board A).
 *
 * Pure, so the grouping and the dot are testable without a socket. The rows
 * come from `shares.listSharedWithMe`, which already put every one back
 * through the same predicate the share link answers, so nothing here decides
 * who may see what.
 */

import { atName } from "../format";
import { baseName, displayName } from "../files/paths";
import { SHARE_PATH_PREFIX } from "../files/shares";

/** One row of `shares.listSharedWithMe`. */
export interface SharedItem {
  token: string;
  workspaceId: string;
  slug: string;
  displayName: string;
  workspaceKind: "personal" | "shared";
  entryPath: string;
  sharedBy: string;
  sharedByHandle: string | null;
  /** The sharer's account name, `null` for an account with none. */
  sharedByName: string | null;
  /** The note's own title (front matter or first heading), `null` to use its file name. */
  title: string | null;
  createdAt: number;
}

/** The URL of @shared. */
export const SHARED_HREF = "/console/shared";

/**
 * Where a row opens: the note inside @shared itself (board A3), with the
 * sidebar still beside it and a path that starts at Shared with me. The token
 * is the whole address, so the server's share check decides what it reaches.
 */
export function sharedNoteHref(token: string): string {
  return `${SHARED_HREF}?note=${encodeURIComponent(token)}`;
}

/** The share's public address, `/s/<token>`, the one its sharer pasted into a chat. */
export function sharedLinkHref(token: string): string {
  return `${SHARE_PATH_PREFIX}${encodeURIComponent(token)}`;
}

/**
 * What the note is called: its own title, as the server read it from the
 * note's front matter or first heading, else its file name the way the tree
 * shows one (`1-projects/beneath-the-chaos.md` → `beneath-the-chaos`).
 */
export function itemTitle(item: Pick<SharedItem, "entryPath" | "title">): string {
  return item.title ?? displayName(baseName(item.entryPath));
}

/**
 * Who shared it: their name ("Ana Ruiz"), else `@ana`, else "Someone" for an
 * account with neither.
 */
export function sharerLabel(item: Pick<SharedItem, "sharedByHandle" | "sharedByName">): string {
  if (item.sharedByName !== null) return item.sharedByName;
  return item.sharedByHandle === null ? "Someone" : atName(item.sharedByHandle);
}

/** The face's key: `@ana`, as every other face in the app is looked up. */
export function sharerFace(item: Pick<SharedItem, "sharedByHandle">): string | null {
  return item.sharedByHandle === null ? null : atName(item.sharedByHandle);
}

const DAY = 24 * 60 * 60 * 1000;
const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

/**
 * The row's right-hand time, as board A2 writes it: "Just now", "2h ago",
 * "Yesterday", then the date ("Oct 9"), with the year once it is not this one.
 */
export function shortWhen(createdAt: number, now: number): string {
  const minutes = Math.floor((now - createdAt) / 60_000);
  const day = new Date(now);
  day.setHours(0, 0, 0, 0);
  const today = day.getTime();
  if (createdAt >= today) {
    if (minutes < 1) return "Just now";
    if (minutes < 60) return `${minutes}m ago`;
    return `${Math.floor(minutes / 60)}h ago`;
  }
  if (createdAt >= today - DAY) return "Yesterday";
  const when = new Date(createdAt);
  const date = `${MONTHS[when.getMonth()]} ${when.getDate()}`;
  return when.getFullYear() === day.getFullYear() ? date : `${date}, ${when.getFullYear()}`;
}

/** Narrow the list to what a typed filter names: the title, the sharer, or the workspace. */
export function matchesFilter(item: SharedItem, query: string): boolean {
  const needle = query.trim().toLowerCase();
  if (needle === "") return true;
  return [itemTitle(item), sharerLabel(item), item.sharedByHandle ?? "", placeLabel(item) ?? ""].some((field) =>
    field.toLowerCase().includes(needle),
  );
}

/**
 * Where it lives, said only when it adds something. A note in the sharer's
 * own workspace needs no second name — "@ana · in @ana" says one thing twice —
 * so this is the shared workspace's name or nothing.
 */
export function placeLabel(item: Pick<SharedItem, "workspaceKind" | "displayName" | "slug">): string | null {
  if (item.workspaceKind !== "shared") return null;
  return item.displayName.trim() === "" ? atName(item.slug) : item.displayName;
}

/** Newest first, the order the list and every group inside it read in. */
export function newestFirst(items: readonly SharedItem[]): SharedItem[] {
  return [...items].sort((a, b) => b.createdAt - a.createdAt);
}

export type DayBucket = "Today" | "This week" | "Earlier";

/** Which heading a share sits under, by the reader's own calendar day. */
export function dayBucket(createdAt: number, now: number): DayBucket {
  const startOfToday = new Date(now);
  startOfToday.setHours(0, 0, 0, 0);
  const today = startOfToday.getTime();
  if (createdAt >= today) return "Today";
  if (createdAt >= today - 6 * DAY) return "This week";
  return "Earlier";
}

/** The list's sections, empty ones left out, newest first inside each. */
export function groupByDay(
  items: readonly SharedItem[],
  now: number,
): { heading: DayBucket; items: SharedItem[] }[] {
  const order: DayBucket[] = ["Today", "This week", "Earlier"];
  const sorted = newestFirst(items);
  return order
    .map((heading) => ({ heading, items: sorted.filter((item) => dayBucket(item.createdAt, now) === heading) }))
    .filter((group) => group.items.length > 0);
}

/**
 * The sidebar's people, each with what they shared, the most recent sharer
 * first. Keyed by account rather than handle, so two people who both lack a
 * handle are still two people.
 */
export interface PersonGroup {
  sharedBy: string;
  label: string;
  handle: string | null;
  items: SharedItem[];
}

export function groupByPerson(items: readonly SharedItem[]): PersonGroup[] {
  const groups = new Map<string, PersonGroup>();
  for (const item of newestFirst(items)) {
    const group = groups.get(item.sharedBy);
    if (group === undefined) {
      groups.set(item.sharedBy, {
        sharedBy: item.sharedBy,
        label: sharerLabel(item),
        handle: item.sharedByHandle,
        items: [item],
      });
    } else {
      group.items.push(item);
    }
  }
  return [...groups.values()];
}

/**
 * Shares that arrived since the reader last opened @shared. `undefined` seen
 * means the answer has not loaded yet and counts nothing, so the dot never
 * flashes on at start-up; `null` means they have never looked.
 */
export function unseenCount(items: readonly SharedItem[] | undefined, seenAt: number | null | undefined): number {
  if (items === undefined || seenAt === undefined) return 0;
  if (seenAt === null) return items.length;
  return items.filter((item) => item.createdAt > seenAt).length;
}
