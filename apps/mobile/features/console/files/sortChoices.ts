/**
 * The ways a folder can be sorted, as the Sort menus name them: a folder's own
 * (`menuSort.ts`) and the workspace's at the top of the tree
 * (`ExplorerToolbar.tsx`). One list, so both menus say the same words in the
 * same order (owner, 2026-11-04; `docs/decisions/app-and-console/folder-sort.md`).
 * No size sort (owner).
 */

import type { ListingSort } from "@context/shared/src/listingSort.cjs";

export const SORT_CHOICES: ReadonlyArray<{ sort: ListingSort; label: string; groupStart?: boolean }> = [
  { sort: "custom", label: "Custom order" },
  { sort: "name-asc", label: "Name, A to Z", groupStart: true },
  { sort: "name-desc", label: "Name, Z to A" },
  { sort: "edited-desc", label: "Edited, newest first", groupStart: true },
  { sort: "edited-asc", label: "Edited, oldest first" },
  { sort: "created-desc", label: "Created, newest first" },
  { sort: "created-asc", label: "Created, oldest first" },
];

/**
 * The Sort submenu's own id, never dispatched (the caller opens its `items`),
 * and its rows: one per way to sort, and "Apply to folders inside"
 * (`menuSort.ts`). Part of `MenuActionId`.
 */
export type SortActionId =
  | "sort"
  | "sortCustom"
  | "sortNameAsc"
  | "sortNameDesc"
  | "sortEditedDesc"
  | "sortEditedAsc"
  | "sortCreatedDesc"
  | "sortCreatedAsc"
  | "sortInside";

/** The words for `sort` in a sentence ("projects is now in custom order"). */
export function sortWords(sort: ListingSort | null): string {
  if (sort === "custom") return "custom order";
  const choice = SORT_CHOICES.find((entry) => entry.sort === sort);
  return choice === undefined ? "the default order" : choice.label.toLowerCase();
}
