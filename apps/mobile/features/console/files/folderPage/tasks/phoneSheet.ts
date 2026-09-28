/**
 * A task's menu as a phone draws it (PhoneMenu artboard, 2026-09-28): the
 * right-click menu's own list (`taskMenu.ts`), redrawn for a thumb — never a
 * second list. Pure.
 *
 * - **Priority becomes a row of chips** at the top of the sheet (Urgent, High,
 *   Medium, Low, None), one tap each, instead of a row that opens a page of
 *   five. Every other item stays where the menu put it, submenus untouched.
 * - **Each row shows what it is set to** ("Status  In progress ›"), because a
 *   sheet covers the row it is about.
 * - **A swipe offers two of the same items**: Assign (the menu's Assign to me)
 *   and Backlog (its Move to Backlog), each only where the menu offers it.
 *
 * Ids are the menu's, so a chip, a row and a swipe all go through
 * `taskMenuAction` and `runMenuAction`, the one road every menu write takes.
 */

import type { MenuItem } from "../../menuItem";

export interface PhoneSheet {
  /** The priority chips, in the menu's order; empty for a note. */
  readonly chips: readonly MenuItem<string>[];
  /** Everything else, in the menu's order. */
  readonly items: MenuItem<string>[];
}

/** What a task's rows are set to, as the owner reads them; absent draws nothing. */
export interface SheetValues {
  readonly status?: string;
  readonly owners?: string;
  readonly tags?: string;
  readonly due?: string;
}

const VALUE_OF: Readonly<Record<string, keyof SheetValues>> = { status: "status", owners: "owners", tags: "tags", due: "due" };

/** The chip that clears a priority: the menu's "No priority", short enough to sit beside Medium. */
const NONE_CHIP = "None";

export function phoneSheet(items: readonly MenuItem<string>[], values: SheetValues): PhoneSheet {
  const priority = items.find((item) => item.id === "priority");
  const chips = (priority?.items ?? []).map((chip) => (chip.id === "priority:none" ? { ...chip, label: NONE_CHIP } : chip));
  const rest = items
    .filter((item) => item !== priority)
    .map((item) => {
      const key = VALUE_OF[item.id];
      const value = key === undefined ? undefined : values[key];
      return value === undefined || value === "" ? item : { ...item, value };
    });
  // The first row after the chips needs no rule above it: the chips are the rule.
  if (rest[0]?.separatorBefore === true) rest[0] = { ...rest[0], separatorBefore: false };
  return { chips, items: rest };
}

export interface SwipeAction {
  /** The menu's id: `me` or `park`. */
  readonly id: "me" | "park";
  /** The word on the button (PhoneList artboard). */
  readonly label: string;
  /** The menu's own words, for a screen reader. */
  readonly accessibilityLabel: string;
}

const SWIPES: readonly SwipeAction[] = [
  { id: "me", label: "Assign", accessibilityLabel: "Assign to me" },
  { id: "park", label: "Backlog", accessibilityLabel: "Move to Backlog" },
];

/** What a swipe left offers: only what the menu offers this row, so a swipe can never do what the menu would not. */
export function swipeActions(items: readonly MenuItem<string>[]): SwipeAction[] {
  return SWIPES.filter((action) => items.some((item) => item.id === action.id));
}
