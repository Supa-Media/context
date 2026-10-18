import { baseName, displayName, folderLabel, parentPath } from "../files/paths";

/**
 * The Trash page's words and groups (design A, Dev2 2026-10-17, project file
 * `trash-page/`): what goes soonest first, under "Erased this week", in bold
 * red; the rest under "Later". The server decides the date
 * (`functions/trash.ts`); this only says it.
 */

const DAY = 24 * 60 * 60 * 1000;
/** Erased within this many days: grouped first, and said in bold red. */
export const SOON_DAYS = 7;

/** What `trash.listTrash` answers for one thing in the trash. */
export interface TrashItem {
  trash: string;
  path: string;
  kind: "file" | "folder";
  at: number;
  eraseAt: number;
  byYou: boolean;
  byName: string | null;
  notes: number;
}

/** Whole days until `eraseAt`, never below 0: "3 days" on the morning it has 2.4 left. */
export function daysLeft(eraseAt: number, now: number): number {
  return Math.max(0, Math.ceil((eraseAt - now) / DAY));
}

export function erasedSoon(eraseAt: number, now: number): boolean {
  return eraseAt - now <= SOON_DAYS * DAY;
}

/** "Erased today", "Erased in 1 day", "Erased in 5 days" when soon; "28 days left" otherwise. */
export function eraseLabel(eraseAt: number, now: number): string {
  const days = daysLeft(eraseAt, now);
  if (!erasedSoon(eraseAt, now)) return `${days} days left`;
  if (days === 0) return "Erased today";
  return `Erased in ${days} ${days === 1 ? "day" : "days"}`;
}

/** A phone's narrower column: "3 days left", "1 day left", "Erased today". */
export function daysLeftLabel(eraseAt: number, now: number): string {
  const days = daysLeft(eraseAt, now);
  if (days === 0) return "Erased today";
  return `${days} ${days === 1 ? "day" : "days"} left`;
}

/** "Nov 16": the day, in the reader's own calendar. */
export function eraseDay(eraseAt: number): string {
  return new Date(eraseAt).toLocaleDateString("en-US", { month: "short", day: "numeric" });
}

/** The line on an open trashed note. */
export function eraseSentence(eraseAt: number): string {
  return `Erased for good on ${eraseDay(eraseAt)} unless you restore it.`;
}

/** The name a row shows: a note's without its extension, a folder's without its sort number. */
export function trashName(item: Pick<TrashItem, "path" | "kind">): string {
  const name = baseName(item.path);
  return item.kind === "folder" ? folderLabel(name) || name : displayName(name) || name;
}

/** "from projects / hiring", or `null` for something that sat at the top of the workspace. */
export function fromLabel(path: string): string | null {
  const parent = parentPath(path);
  if (parent === "") return null;
  return `from ${parent.split("/").map((segment) => folderLabel(segment) || segment).join(" / ")}`;
}

/** "You deleted it", "@ana deleted it", "Deleted" when nobody is named. */
export function byLine(item: Pick<TrashItem, "byYou" | "byName">): string {
  if (item.byYou) return "You deleted it";
  return item.byName === null ? "Deleted" : `${item.byName} deleted it`;
}

export interface TrashGroups {
  soon: TrashItem[];
  later: TrashItem[];
}

/** Soonest erased first in each group. */
export function groupTrash(items: readonly TrashItem[], now: number): TrashGroups {
  const sorted = [...items].sort((a, b) => a.eraseAt - b.eraseAt || a.path.localeCompare(b.path));
  return {
    soon: sorted.filter((item) => erasedSoon(item.eraseAt, now)),
    later: sorted.filter((item) => !erasedSoon(item.eraseAt, now)),
  };
}

export const trashCopy = {
  heading: "Trash",
  lede: (days: number) => `Deleted notes and folders wait here for ${days} days, then they are `,
  ledeBold: "erased for good",
  ledeEnd: ". Restore puts one back.",
  soon: "Erased this week",
  later: "Later",
  empty: "Nothing is in the trash.",
  restore: "Restore",
  restoring: "Restoring…",
  restored: "Restored",
  open: "Open",
  close: "Close the trash",
  more: "There is more in the trash than one page shows. Restore or wait for some to go, and the rest will appear.",
  notes: (count: number) => `${count} ${count === 1 ? "note" : "notes"}`,
};
