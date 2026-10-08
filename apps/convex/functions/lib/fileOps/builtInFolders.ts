/**
 * Adding one of the built-in folders a workspace does not have yet: an extra
 * (Clients, Teams, Products) from "Add a folder", or a main folder an older
 * workspace lacks (decided by the owner, 2026-10-08; see
 * `packages/shared/src/folderRoles.cjs`).
 *
 * The folder gets its fixed name (`4-clients`) and an `about.md` saying what it is
 * for, which is what an AI reads when deciding where to file. A workspace that
 * already has a folder playing that role, under any number or none, is told so
 * rather than given a second one.
 */

import {
  DEFAULT_FOLDER,
  EXTRA_ROLES,
  MAIN_ROLES,
  ROLE_DESCRIPTION,
  ROLE_LABEL,
  type FolderRole,
  rolesIn,
} from "@context/shared/src/folderRoles.cjs";
import { type Clearance } from "../clearance";
import type { FileStore } from "./store";
import { FileOpError, notFound } from "./errors";
import { joinPath } from "./paths";
import { loadPrivacyState } from "./privacyState";
import { folderVisibleAtScope, listFolder } from "./listing";
import { writeFile } from "./writing";

const ROLES: readonly string[] = [...MAIN_ROLES, ...EXTRA_ROLES];

export function isBuiltInRole(role: string): role is FolderRole {
  return ROLES.includes(role);
}

/** The `about.md` a built-in folder starts with. */
export function renderBuiltInAbout(role: FolderRole): string {
  return [`# ${ROLE_LABEL[role]}`, "", ROLE_DESCRIPTION[role], ""].join("\n");
}

export async function addBuiltInFolder(
  store: FileStore,
  options: { role: string; clearance: Clearance; now: number },
): Promise<{ path: string; readme: string }> {
  if (!isBuiltInRole(options.role)) throw new FileOpError("PATH_INVALID", "That is not one of the built-in folders.");
  const role = options.role;
  const folder = DEFAULT_FOLDER[role];
  // As `createFolder`: a caller who could not see the folder is not told
  // whether it is there.
  const state = await loadPrivacyState(store);
  if (!folderVisibleAtScope(folder, options.clearance, state.rules, state.overrides)) throw notFound();

  const root = await listFolder(store, { path: "", clearance: options.clearance });
  const names = root.entries.filter((entry) => entry.kind === "folder").map((entry) => entry.name);
  const existing = rolesIn(names)[role];
  if (existing !== null) throw new FileOpError("DESTINATION_EXISTS", `${ROLE_LABEL[role]} is already in this workspace.`);

  const about = joinPath(folder, "about.md");
  if ((await store.get(about)) !== null) {
    throw new FileOpError("DESTINATION_EXISTS", `${ROLE_LABEL[role]} is already in this workspace.`);
  }
  await writeFile(store, { path: about, text: renderBuiltInAbout(role), clearance: options.clearance, now: options.now });
  return { path: folder, readme: about };
}
