/**
 * The menu rows for one of the five built-in folders (Inbox, Projects, Areas,
 * Resources, Archive; `packages/shared/src/folderRoles.cjs`).
 *
 * They cannot be renamed, moved, archived or trashed — the server refuses
 * every one of those (`assertNotProtectedFolder`) — so the menu does not offer to.
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

import { isMainFolder, isProtectedFolder } from "@context/shared/src/folderRoles.cjs";
import type { MenuContext } from "./menu";
import type { MenuItem } from "./menuItem";
import { makeItem } from "./menuMake";

export const BUILT_IN_DETAIL = "Built in. Every workspace has this folder, so your AI always knows where things go.";

/**
 * Is this row the folder playing one of the five built-in roles?
 *
 * Given the root's folder names, a second folder claiming a role (an agent's
 * `projects` beside `Projects`) is an ordinary folder, as the server treats it
 * (`isProtectedFolder`), so it can be renamed, moved and trashed. Without them
 * every role-shaped name is locked, the safe side.
 */
export function isBuiltInRow(row: { kind: string; path: string }, topLevelFolders?: readonly string[]): boolean {
  if (row.kind !== "folder") return false;
  return topLevelFolders === undefined ? isMainFolder(row.path) : isProtectedFolder(row.path, topLevelFolders);
}

/** The root's folder names from the loaded listings, or undefined before the root has loaded. */
export function rootFolderNames(
  listings: Readonly<Record<string, { entries: readonly { kind: string; name: string }[] } | undefined>>,
): string[] | undefined {
  const root = listings[""];
  return root === undefined ? undefined : root.entries.filter((entry) => entry.kind === "folder").map((entry) => entry.name);
}

/** Rename and trash, dimmed, the second carrying the reason. */
export function builtInLockedItems(context: MenuContext): MenuItem[] {
  return [
    makeItem(context, "rename", "Rename…", { disabled: true }),
    makeItem(context, "delete", "Move to trash", { disabled: true, detail: BUILT_IN_DETAIL }),
  ];
}
