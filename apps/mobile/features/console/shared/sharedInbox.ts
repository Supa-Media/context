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
import { displayName } from "../files/paths";
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
  createdAt: number;
}

/** The URL of @shared. */
export const SHARED_HREF = "/console/shared";

/**
 * Where a row opens: the share's own page, which draws the note in the real
 * editor, read only (`share/SharedConsole.tsx`, board A3). The same address
 * the sharer pasted into a chat, so a reader who arrives either way lands in
 * one place, and only the share page decides what the token reaches.
 */
export function sharedOpenHref(token: string): string {
  return `${SHARE_PATH_PREFIX}${encodeURIComponent(token)}`;
}

/** The note's name as the tree would show it: `1-projects/beneath-the-chaos.md` → `beneath-the-chaos`. */
export function itemTitle(item: Pick<SharedItem, "entryPath">): string {
  const base = item.entryPath.split("/").pop() ?? item.entryPath;
  return displayName(base);
}

/** Who shared it, as the product names people: `@ana`, or "Someone" for an account with no handle. */
export function sharerLabel(item: Pick<SharedItem, "sharedByHandle">): string {
  return item.sharedByHandle === null ? "Someone" : atName(item.sharedByHandle);
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

const DAY = 24 * 60 * 60 * 1000;

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
export function groupByPerson(
  items: readonly SharedItem[],
): { sharedBy: string; label: string; handle: string | null; items: SharedItem[] }[] {
  const groups = new Map<string, { sharedBy: string; label: string; handle: string | null; items: SharedItem[] }>();
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
