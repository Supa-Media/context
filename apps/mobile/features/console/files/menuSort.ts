/**
 * A folder's Sort submenu (owner, 2026-11-04; boards in the project file
 * `custom-sort/index.html`; `docs/decisions/app-and-console/folder-sort.md`):
 * one row per way to sort, the one the folder draws by now ticked, and
 * "Apply to folders inside", which gives every folder beneath the same sort.
 *
 * Editor only and absent otherwise, like every write in this menu: the order
 * is shared by the whole workspace. A folder with no setting anywhere above it
 * draws by name with its folders first, so Name, A to Z is ticked there.
 */

import type { ListingSort } from "@context/shared/src/listingSort.cjs";
import type { MenuActionId, MenuContext } from "./menu";
import type { MenuItem } from "./menuItem";
import { makeItem } from "./menuMake";
import { SORT_CHOICES } from "./sortChoices";
import type { TreeRow } from "./tree";

/** Each sort's menu id, and back. */
export const SORT_IDS: Readonly<Record<ListingSort, MenuActionId>> = {
  custom: "sortCustom",
  "name-asc": "sortNameAsc",
  "name-desc": "sortNameDesc",
  "edited-desc": "sortEditedDesc",
  "edited-asc": "sortEditedAsc",
  "created-desc": "sortCreatedDesc",
  "created-asc": "sortCreatedAsc",
};

/** The sort a menu id sets, or `null` for an id that is not one. */
export function sortOfId(id: string): ListingSort | null {
  const found = (Object.entries(SORT_IDS) as [ListingSort, MenuActionId][]).find(([, menuId]) => menuId === id);
  return found === undefined ? null : found[0];
}

/** "Sort ›" for one folder row, or nothing. */
export function sortGroup(context: MenuContext, row: TreeRow | null): MenuItem[] {
  if (!context.canEdit || row === null || row.kind !== "folder" || row.path === "") return [];
  const held = context.sortOf?.(row.path);
  if (held === undefined || held === null) return [];
  const ticked = held.drawn ?? "name-asc";
  const items: MenuItem[] = SORT_CHOICES.map(({ sort, label, groupStart }) => ({
    ...makeItem(context, SORT_IDS[sort], label, { checked: ticked === sort }),
    ...(groupStart === true ? { separatorBefore: true } : {}),
  }));
  // Custom order is what was dragged in this one folder: there is nothing to give the folders inside.
  if (ticked !== "custom") items.push({ ...makeItem(context, "sortInside", "Apply to folders inside"), separatorBefore: true });
  return [makeItem(context, "sort", "Sort", { items })];
}
