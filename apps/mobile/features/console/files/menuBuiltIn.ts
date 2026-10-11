/**
 * The menu rows for one of the five built-in folders (Inbox, Projects, Areas,
 * Resources, Archive; `packages/shared/src/folderRoles.cjs`).
 *
 * They cannot be renamed, moved, archived or trashed — the server refuses
 * every one of those (`assertNotMainFolder`) — so the menu does not offer to.
 *
 * Rename and trash stay in the menu **drawn dimmed, with a line saying why**,
 * which is the exception `MenuItem.disabled` asks to be argued for. Absence
 * tells the truth about a permission somebody lacks; here nobody lacks one.
 * The folder is built in for everyone, and a Rename that silently vanished
 * from one folder's menu reads as a bug, where a dimmed one with "Built in"
 * under it answers the question before it is asked. Approved on the owner's
 * mockup, 2026-10-08. Move to and Archive are simply absent, as they are on
 * the workspace root: there is nowhere else for these folders to be.
 */

import { isMainFolder } from "@context/shared/src/folderRoles.cjs";
import type { MenuContext } from "./menu";
import type { MenuItem } from "./menuItem";
import { makeItem } from "./menuMake";

export const BUILT_IN_DETAIL = "Built in. Every workspace has this folder, so your AI always knows where things go.";

/** Is this row one of the five built-in folders itself? */
export function isBuiltInRow(row: { kind: string; path: string }): boolean {
  return row.kind === "folder" && isMainFolder(row.path);
}

/** Rename and trash, dimmed, the second carrying the reason. */
export function builtInLockedItems(context: MenuContext): MenuItem[] {
  return [
    makeItem(context, "rename", "Rename…", { disabled: true }),
    makeItem(context, "delete", "Move to trash", { disabled: true, detail: BUILT_IN_DETAIL }),
  ];
}
