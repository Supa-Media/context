/**
 * The shape of one menu row, shared by every menu the app draws — the file
 * menu (`menu.ts`), the account menu and the presence list. Its own module so
 * a caller can build rows without the file menu's model.
 */

import type { ReactNode } from "react";
import type { MenuActionId } from "./menu";

/**
 * One row's data, generic in its own id.
 *
 * Parameterised — defaulting to `MenuActionId` — so that `Menu.tsx` and
 * `Menu.web.tsx` are a **disclosure menu component**, not "the file menu's
 * renderer": the account menu (`ConsoleRail.tsx`'s `AccountBlock`) draws with
 * the exact same two files against its own two-item id union. Widening
 * `MenuActionId` itself to fit a caller with nothing to do with files was the
 * alternative, and it is the wrong one — `Explorer.tsx`'s `runAction` switches
 * on every member of that union, so an unrelated id added there is a case
 * that dispatcher must now also not mishandle, forever, for a menu it never
 * draws.
 */
export interface MenuItem<Id extends string = MenuActionId> {
  id: Id;
  label: string;
  /**
   * A second line under the label, for an outcome a verb cannot carry alone.
   *
   * Deliberately rare — a menu where every row explains itself is a menu
   * nobody reads. It exists for the folder visibility items, where the
   * label says what happens and the thing people get wrong is what *does
   * not*: a note with its own setting keeps it.
   */
  detail?: string;
  /**
   * What the row is set to now, drawn muted at its right before the chevron:
   * "Status  In progress ›". For a sheet that covers the thing it is about —
   * a task's menu on a phone (`folderPage/tasks/phoneSheet.ts`) — where the
   * row is no longer in sight to read it from.
   */
  value?: string;
  /** Printed on the right on web. Absent on touch. */
  shortcut?: string;
  /**
   * A radio mark: this is the setting in force right now.
   *
   * Present only where "in force" is a question with an answer. The visibility
   * items on a *note* are three mutually exclusive states, so all three carry
   * it and exactly one may be true; a folder's pair is a bulk write over its
   * contents rather than a state the folder is in, and a selection has no
   * single state at all, so both leave it `undefined`.
   *
   * `false` and `undefined` therefore mean different things and the renderer
   * must keep them apart: `false` reserves the check gutter so three radio rows
   * line up, `undefined` draws no gutter at all.
   */
  checked?: boolean;
  danger?: boolean;
  /**
   * Present, but inert and drawn dimmed.
   *
   * **The file menu never sets this, and that is a rule rather than an
   * oversight** — see this module's own header: a console that cannot edit is
   * offered *fewer* items, because a screen of greyed rows tells somebody their
   * context is broken while a short menu tells them the truth.
   *
   * It exists for the tab menu's "Reopen closed", where the opposite is right
   * and for a reason that does not generalise: that item is one ⌘⇧T away from
   * being available again, it comes back on its own the moment anything is
   * closed, and a menu of three rows whose contents shuffle between openings is
   * a menu nobody can learn. Absence tells the truth about a permission;
   * absence would tell a lie about an empty undo stack.
   *
   * A new caller reaching for this should read both paragraphs and expect to
   * have to argue for the second one.
   */
  disabled?: boolean;
  /** Items after this one start a new visual group. */
  separatorBefore?: boolean;
  /** A submenu (Visibility ▸). Only ever one level deep. */
  items?: MenuItem<Id>[];
  /**
   * Overrides the row's default `menu-item-<id>` testID.
   *
   * For a caller whose id is chrome-internal (short, reused across menus) but
   * whose row is cited elsewhere by a stable name — the account menu's
   * `account-settings` / `account-sign-out`, which predate this menu and are
   * asserted directly rather than through the `menu-item-` convention.
   */
  testID?: string;
  /**
   * A mark before the label, such as the face on a row of the presence list.
   * Decorative: the accessible name is still `label`.
   */
  leading?: ReactNode;
}
