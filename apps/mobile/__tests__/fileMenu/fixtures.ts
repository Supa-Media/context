/**
 * The file action menu, without a renderer.
 *
 * `features/console/files/menu.ts` is the one list of items behind both the
 * web context menu and the mobile action sheet, which is what makes the rules
 * below testable at all. Written inside a component they would be two `&&`
 * expressions in two files that nobody would ever compare.
 *
 * Three of them are the point:
 *
 *  - a console that cannot edit is offered *fewer items*, not disabled ones;
 *  - `privacy.md` is generated, so almost nothing may be done to it;
 *  - a multi-selection is a different menu, and every label says how many
 *    things it is about to touch.
 *
 * The separator tests look pedantic and are not: a menu whose items appear and
 * disappear (no clipboard, no `openInNewTab` on touch, no mutations for a
 * `member`) grows a leading rule or a double rule the first time a group
 * empties, and that is the bug that ships.
 *
 * This module is the shared fixture harness for every file in this folder —
 * it carries no tests of its own.
 */

import {
  itemsFor,
  joinGroups,
  type MenuActionId,
  type MenuContext,
  type MenuItem,
  type MenuTarget,
} from "../../features/console/files/menu";
import { put } from "../../features/console/files/clipboard";
import { BINDINGS, describeBinding } from "../../features/design/keymap";
import type { TreeRow } from "../../features/console/files/tree";
import { displayName } from "../../features/console/files/paths";

export {
  itemsFor,
  joinGroups,
  type MenuActionId,
  type MenuContext,
  type MenuItem,
  type MenuTarget,
  put,
  BINDINGS,
  describeBinding,
  type TreeRow,
  displayName,
};

export function row(kind: TreeRow["kind"], path: string, over: Partial<TreeRow> = {}): TreeRow {
  return {
    kind,
    key: path,
    path,
    name: path.slice(path.lastIndexOf("/") + 1),
    label: displayName(path.slice(path.lastIndexOf("/") + 1)),
    depth: 0,
    expanded: false,
    selected: false,
    markerIsDefault: kind === "folder",
    readOnly: false,
    ...over,
  };
}

export const note = (path: string, over: Partial<TreeRow> = {}) => row("file", path, over);
export const dir = (path: string, over: Partial<TreeRow> = {}) => row("folder", path, over);

/** Everything a menu could be about, with the permissive defaults. */
export function menu(target: MenuTarget, over: Partial<Omit<MenuContext, "target">> = {}): MenuItem[] {
  const context: MenuContext = {
    target,
    canEdit: true,
    // Permissive default like canEdit: most of this suite is about shape,
    // and the owner-only rule has its own describe below.
    canSetVisibility: true,
    canShare: true,
    canDownload: true,
    clipboard: null,
    platform: "web",
    ...over,
  };
  return itemsFor(context);
}

export const ids = (list: MenuItem[]): MenuActionId[] => list.map((entry) => entry.id);
export const labels = (list: MenuItem[]): string[] => list.map((entry) => entry.label);

export function find(list: MenuItem[], id: MenuActionId): MenuItem | undefined {
  return list.find((entry) => entry.id === id);
}

export const MUTATING: MenuActionId[] = [
  "newNote",
  "newFolder",
  "rename",
  "duplicate",
  "moveTo",
  "cut",
  "paste",
  "visibility",
  "visibilityPrivate",
  "visibilityTeam",
  "visibilityFollow",
  "archive",
  "restore",
  "delete",
];
