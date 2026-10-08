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
 * Whether the main-folders band may be asked for: somebody who can edit, the
 * root listing has loaded (so "missing" is an answer and not a guess), and at
 * least one main folder is missing.
 */
export function missingFoldersEligible(input: { canEdit: boolean; root: FolderListing | undefined }): boolean {
  return input.canEdit && input.root !== undefined && missingMainRoles(rootFolderNames(input.root)).length > 0;
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
