/**
 * The pure rules behind the two folder offers: "Add the five main folders?"
 * (the root band) and "Is this for a business?" (the Add a folder sheet).
 * Which folders are missing comes from the shared role table, the same answer
 * the server gives `builtInFolders.add`, so the two cannot disagree.
 */

import {
  MAIN_ROLES,
  ROLE_LABEL,
  missingMainRoles,
  rolesIn,
  type MainRole,
} from "@context/shared/src/folderRoles.cjs";
import type { FolderListing } from "./types";

/** The top-level folder names of a root listing. */
export function rootFolderNames(root: FolderListing | undefined): string[] {
  return (root?.entries ?? []).filter((entry) => entry.kind === "folder").map((entry) => entry.name);
}

/**
 * Whether the main-folders band may be asked for: the signed-in owner of a
 * real workspace, the root listing has loaded (so "missing" is an answer and
 * not a guess), and at least one main folder is missing.
 *
 * Never on the homepage or the landing page's demo: both draw the console
 * shell over somebody else's notes (the homepage is @context-lc's `website/`
 * folder, which a visitor can edit in their tab, so `canEdit` alone let it
 * through). And never while a page of a website is open: a site's folder is
 * not where a workspace's filing system is decided.
 */
export function missingFoldersEligible(input: {
  canEdit: boolean;
  root: FolderListing | undefined;
  role: string | undefined;
  visitor: boolean;
  demo: boolean;
  selectedPath: string | null;
}): boolean {
  return (
    input.canEdit &&
    input.role === "owner" &&
    !input.visitor &&
    !input.demo &&
    !inWebsiteFolder(input.selectedPath) &&
    input.root !== undefined &&
    missingMainRoles(rootFolderNames(input.root)).length > 0
  );
}

function inWebsiteFolder(path: string | null): boolean {
  return path !== null && (path === "website" || path.startsWith("website/"));
}

/** One line per main folder: the folder found under its role, or none. */
export interface MainFolderLine {
  role: MainRole;
  label: string;
  /** The top-level folder that plays the role, or `null` when it is missing. */
  found: string | null;
}

export function mainFolderLines(names: readonly string[]): MainFolderLine[] {
  const have = rolesIn(names);
  return MAIN_ROLES.map((role) => ({ role, label: ROLE_LABEL[role], found: have[role] }));
}

/** "Add 1 folder" or "Add 3 folders". */
export function addFoldersLabel(count: number): string {
  return count === 1 ? "Add 1 folder" : `Add ${count} folders`;
}

/** The two extras a personal workspace is asked about before getting them. */
const BUSINESS_ROLES: readonly string[] = ["clients", "teams"];

export function isBusinessChoice(role: string): boolean {
  return BUSINESS_ROLES.includes(role);
}

/**
 * Whether the business question may be asked: a personal workspace, with an id
 * to answer for, while its Add a folder sheet is open. Shared workspaces never
 * (they are the business case already).
 */
export function businessQuestionEligible(input: {
  personal: boolean;
  contextId: string | null;
  sheetOpen: boolean;
}): boolean {
  return input.personal && input.contextId !== null && input.sheetOpen;
}
