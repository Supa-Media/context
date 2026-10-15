/**
 * The gateway's half of the two name guards in
 * `apps/convex/functions/lib/fileOps/nameTwins.ts` (decided by the owner,
 * 2026-10-14, after Tex made `projects` beside `Projects` and nobody could
 * remove it):
 *
 *  - a built-in folder is protected only while it is the folder for its role
 *    (`isProtectedFolder`), so a duplicate can be emptied and removed;
 *  - a new name may not twin a sibling by case, nor, at the root, take a role
 *    another folder plays (`siblingTwin`). The refusal names the path to use,
 *    so an agent's retry lands in the folder that is already there.
 *
 * Both read the Convex tree (`servedListingStore`), never the bucket, and only
 * what this connection can see: a twin it cannot see is not refused on, since
 * that refusal would name it. A tree that cannot answer yet skips the twin
 * check (the write is not held hostage to a listing) and keeps a role-shaped
 * folder protected (the safe side).
 */

import {
  ROLE_LABEL,
  isMainFolder,
  isProtectedFolder,
  siblingTwin,
  topLevelRole,
  twinMessage,
} from "../../../../packages/shared/src/folderRoles.cjs";
import { canSee, isPlumbing } from "../privacy/engine.js";
import { listAllKeys } from "../notes/storage.js";
import { servedListingStore } from "./served.js";

/** The names one level holds, files and folders, from the visible keys under it. */
async function visibleChildren(listing, parent, scope, rules, overrides) {
  const prefix = parent === "" ? "" : `${parent}/`;
  const files = new Set();
  const folders = new Set();
  for (const { key } of await listAllKeys(listing, prefix)) {
    if (isPlumbing(key) || !canSee(key, scope, rules, overrides)) continue;
    const rest = key.slice(prefix.length);
    const slash = rest.indexOf("/");
    if (slash === -1) files.add(rest);
    else folders.add(rest.slice(0, slash));
  }
  return { files, folders };
}

/** Does this connection see anything under `folder`? Reads that folder's subtree only. */
async function folderSeen(listing, folder, scope, rules, overrides) {
  for (const { key } of await listAllKeys(listing, `${folder}/`)) {
    if (!isPlumbing(key) && canSee(key, scope, rules, overrides)) return true;
  }
  return false;
}

/**
 * The refusal for a new `path` that twins a sibling, or null. Walks down from
 * the root: a folder that exists is entered, and the first segment that does
 * not is compared with its siblings. `ignore` is the path being renamed.
 */
export async function nameTwinRefusal(store, scope, rules, overrides, path, { kind = "file", ignore } = {}) {
  if (isPlumbing(path)) return null;
  const listing = servedListingStore(store);
  const segments = path.split("/");
  try {
    for (let index = 0; index < segments.length; index += 1) {
      const last = index === segments.length - 1;
      const here = segments.slice(0, index + 1).join("/");
      if (!last && here !== ignore && (await folderSeen(listing, here, scope, rules, overrides))) continue;
      const parent = segments.slice(0, index).join("/");
      const { files, folders } = await visibleChildren(listing, parent, scope, rules, overrides);
      const siblings = [...files, ...folders].filter((name) => (parent === "" ? name : `${parent}/${name}`) !== ignore);
      const name = segments[index];
      if (last && siblings.includes(name)) return null;
      const twin = siblingTwin(name, siblings, { topLevelFolder: index === 0 && (!last || kind === "folder") });
      if (twin === null) return null;
      const instead = [...segments.slice(0, index), twin, ...segments.slice(index + 1)].join("/");
      return twinMessage(name, twin, instead, index === 0);
    }
  } catch {
    // A tree that cannot answer yet: the write goes ahead unchecked.
    return null;
  }
  return null;
}

/** The refusal for moving or renaming the folder that plays a main role, or null. */
export async function protectedFolderRefusal(store, scope, rules, overrides, path) {
  if (!isMainFolder(path)) return null;
  let folders;
  try {
    folders = [...(await visibleChildren(servedListingStore(store), "", scope, rules, overrides)).folders];
  } catch {
    folders = [];
  }
  if (!isProtectedFolder(path, folders)) return null;
  return `${ROLE_LABEL[topLevelRole(path)]} is a built-in folder, so it can't be renamed or moved. Move what's inside it instead.`;
}
