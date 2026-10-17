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
import type { ReportPerson, ReportTarget } from "../../report/model";
import { grantItemKey, grantQuery } from "./sharedGrant";

/** A share sent to you: one row of `shares.listSharedWithMe` with `kind: "share"` (or no kind, from before grants). */
export interface ShareItem {
  kind?: "share";
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

/**
 * A row you hold a grant on (`kind: "grant"`): the same row as a share, but it
 * opens by its note id, not a token, and the granter is recorded only where
 * the row says so.
 */
export interface GrantItem {
  kind: "grant";
  workspaceId: string;
  slug: string;
  displayName: string;
  workspaceKind: "personal" | "shared";
  noteId: string;
  entryPath: string;
  itemKind: "file" | "folder";
  /** Who wrote the grant, `null` when the row does not record it. */
  sharedBy: string | null;
  sharedByHandle: string | null;
  sharedByName: string | null;
  /** The note's title, or its file name without `.md`. Never empty. */
  title: string;
  createdAt: number;
}

/** One row of `shares.listSharedWithMe`. */
export type SharedItem = ShareItem | GrantItem;

/** The URL of @shared. */
export const SHARED_HREF = "/console/shared";

/** The key a row is listed, selected and opened under: its token for a share, its grant for a grant. */
export function sharedItemKey(item: SharedItem): string {
  return item.kind === "grant" ? grantItemKey(item.workspaceId, item.noteId) : item.token;
}

/** Where a row opens, whichever kind it is: a share's `?note=`, a grant's `?grant=`. */
export function sharedItemHref(item: SharedItem): string {
  if (item.kind !== "grant") return sharedNoteHref(item.token);
  return `${SHARED_HREF}${grantQuery({
    workspaceId: item.workspaceId,
    ref: { by: "id", noteId: item.noteId },
    folder: item.itemKind === "folder",
  })}`;
}

/**
 * What a row's Report names: a share by its token, a grant by its workspace and stable note id. Never a path,
 * which is the owner's words; the server re-derives either from what the caller can still reach.
 */
export function reportTargetOf(item: SharedItem): ReportTarget {
  return item.kind === "grant"
    ? { kind: "grant", workspaceId: item.workspaceId, noteId: item.noteId }
    : { kind: "share", token: item.token };
}

/** Who a row's Report offers to block: the person who shared it, or nobody when the grant records no granter. */
export function reportPersonOf(item: SharedItem): ReportPerson | null {
  if (item.kind === "grant" && item.sharedBy === null) return null;
  return { handle: item.sharedByHandle, name: item.sharedByName };
}

/** The share token a row carries, for the parts of the page that only a share can use (its link). */
export function shareTokenOf(item: SharedItem): string | null {
  return item.kind === "grant" ? null : item.token;
}

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

/** The group key of a grant whose row does not say who wrote it: one group, not one per row. */
const UNRECORDED = "unrecorded";

export function groupByPerson(items: readonly SharedItem[]): PersonGroup[] {
  const groups = new Map<string, PersonGroup>();
  for (const item of newestFirst(items)) {
    const key = item.sharedBy ?? UNRECORDED;
    const group = groups.get(key);
    if (group === undefined) {
      groups.set(key, {
        sharedBy: key,
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
