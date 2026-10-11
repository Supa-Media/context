/**
 * What "Add a folder" offers for a workspace, given the names of its top-level
 * folders. Pure, so the rule is testable without the sheet.
 *
 * Two kinds of choice, in this order:
 *
 *  - a main folder the workspace has no folder for (an older workspace may
 *    lack one, Resources say), in the order the main folders are drawn;
 *  - the extras (Clients, Teams, Products) it does not have yet, in their own order.
 *
 * "Has no folder for" is `rolesIn`'s question, not a comparison of names, so
 * `clients`, `4-Clients` and `7-Clients` all count as Clients being there.
 * Anything the workspace already has is simply not offered again.
 */

import {
  EXTRA_ROLES,
  MAIN_ROLES,
  ROLE_DESCRIPTION,
  ROLE_LABEL,
  rolesIn,
} from "@context/shared/src/folderRoles.cjs";

export interface AddFolderChoice {
  /** The role `builtInFolders.add` takes. */
  role: string;
  label: string;
  /** One line: what belongs in the folder. */
  description: string;
}

export function addFolderChoices(names: Iterable<string>): AddFolderChoice[] {
  const have = rolesIn(names);
  const choice = (role: string): AddFolderChoice => ({
    role,
    label: ROLE_LABEL[role as keyof typeof ROLE_LABEL],
    description: ROLE_DESCRIPTION[role as keyof typeof ROLE_DESCRIPTION],
  });
  return [
    ...MAIN_ROLES.filter((role) => have[role] === null).map(choice),
    ...EXTRA_ROLES.filter((role) => have[role] === null).map(choice),
  ];
}
