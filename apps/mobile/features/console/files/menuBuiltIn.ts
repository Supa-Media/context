/**
 * The menu rows for a built-in folder: one with a job (Inbox, Projects, Areas,
 * Resources, Archive, the extras, Website, Meetings;
 * `packages/shared/src/folderRoles.cjs`).
 *
 * Since 2026-10-18 the job is on the folder's row and goes with it, so a
 * built-in folder is renamed, moved and nested like any folder (owner,
 * "fixed jobs, free names"). What the server still refuses
 * (`assertNotProtectedFolder`), the menu does not offer:
 *
 *  - **The five main ones are never archived or trashed**: every AI files into
 *    them. Archive and Move to trash stay in the menu **drawn dimmed, with a
 *    line saying why**, which is the exception `MenuItem.disabled` asks to be
 *    argued for. Absence tells the truth about a permission somebody lacks;
 *    here nobody lacks one. A Move to trash that silently vanished from one
 *    folder's menu reads as a bug, where a dimmed one with the reason under it
 *    answers the question before it is asked (the owner's mockup, 2026-10-08).
 *  - **Website keeps its name and place**, because its site is published from
 *    it by name. Rename and Move to are dimmed with that reason, the same way.
 *  - **No built-in folder takes another icon**: its job's drawn icon is the
 *    point (board 9), so "Set icon…" is simply absent.
 */

import { MAIN_ROLES, isMainFolder, isProtectedFolder, topLevelRole, type RowRole } from "@context/shared/src/folderRoles.cjs";
import { folderPlace, jobOfPath, type JobListings } from "./jobIcons/folderJobs";
import type { MenuContext } from "./menu";
import type { MenuItem } from "./menuItem";
import { makeItem } from "./menuMake";

export const BUILT_IN_DETAIL = "Built in. It can be renamed or moved, but not deleted, so your AI always knows where things go.";

export const WEBSITE_DETAIL = "Your website is published from this folder, so it keeps its name and place.";

/**
 * Is this row a folder playing one of the five main roles, by its name?
 *
 * The fallback for a row whose listing carries no job (`rowJob`). Given the
 * root's folder names, a second folder claiming a role (an agent's `projects`
 * beside `Projects`) is an ordinary folder, as the server treats it
 * (`isProtectedFolder`). Without them every role-shaped name is locked, the
 * safe side.
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

/**
 * What a menu needs to know about folders from the loaded listings: the root's
 * names, each folder's job, and, where this console can reorder folders, each
 * one's place among its siblings as drawn (Z to A turns the ends round).
 */
export function folderMenuFacts(
  files: {
    listings: JobListings & Readonly<Record<string, { entries: readonly { kind: string; name: string }[] } | undefined>>;
    moveFolder?: unknown;
    setFolderJob?: unknown;
    canShare?: boolean;
  },
  descending = false,
): Pick<MenuContext, "topLevelFolders" | "jobOf" | "folderPlace" | "canSetJob"> {
  const { listings } = files;
  const topLevelFolders = rootFolderNames(listings);
  return {
    ...(topLevelFolders === undefined ? {} : { topLevelFolders }),
    jobOf: (path: string) => jobOfPath(listings, path),
    // Owner only, as Share is (`canShare`): a job decides where everybody's mail lands.
    canSetJob: files.canShare === true && files.setFolderJob !== undefined,
    ...(files.moveFolder === undefined
      ? {}
      : {
          folderPlace: (path: string) => {
            const place = folderPlace(listings, path);
            return place === null || !descending ? place : { first: place.last, last: place.first };
          },
        }),
  };
}

/**
 * The job of the folder a row is, or `null`:the job its listing entry
 * carries (`context.jobOf`), else, where that listing is not known, the main
 * role its name plays (`isBuiltInRow`).
 */
export function rowJob(
  row: { kind: string; path: string },
  context: Pick<MenuContext, "jobOf" | "topLevelFolders">,
): RowRole | null {
  if (row.kind !== "folder") return null;
  const known = context.jobOf?.(row.path);
  if (known !== undefined) return known;
  return isBuiltInRow(row, context.topLevelFolders) ? topLevelRole(row.path) : null;
}

/** What a folder's job holds it to. */
export interface BuiltInLocks {
  /** Rename and move are refused: the website folder. */
  fixed: boolean;
  /** Archive and trash are refused: the five main folders. */
  kept: boolean;
}

export function builtInLocks(job: RowRole | null): BuiltInLocks {
  return {
    fixed: job === "website",
    kept: job !== null && (MAIN_ROLES as readonly string[]).includes(job),
  };
}

/** Rename and Move to, dimmed, the second carrying the reason: the website folder. */
export function fixedItems(context: MenuContext): MenuItem[] {
  return [
    makeItem(context, "rename", "Rename…", { disabled: true }),
    makeItem(context, "moveTo", "Move to…", { disabled: true, detail: WEBSITE_DETAIL }),
  ];
}

/** Archive and Move to trash, dimmed, the second carrying the reason: the five main folders. */
export function keptItems(context: MenuContext, archiveLabel = "Archive"): MenuItem[] {
  return [
    makeItem(context, "archive", archiveLabel, { disabled: true }),
    makeItem(context, "delete", "Move to trash", { disabled: true, detail: BUILT_IN_DETAIL }),
  ];
}
