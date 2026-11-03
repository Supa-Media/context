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
 * Both read the tree, never the bucket: the workspace object's one key per
 * child (`store.treeChildren`) where the notes live there, else the served
 * listing (`servedListingStore`). They read only
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
import { INBOX_PARTS, INBOX_PART_LABEL, TEX_PARTS } from "../../../../packages/shared/src/folderJobInfo.cjs";
import { canSee, isPlumbing } from "../privacy/engine.js";
import { listAllKeys } from "../notes/storage.js";
import { servedListingStore } from "./served.js";

/** Folders one `treeChildren` call may name (`workspaceStore/manifest.js` `CHILDREN_FOLDERS`). */
const CHILDREN_PER_ASK = 8;

/**
 * Where the guards read a level from: the workspace object's one-level answer (`store.treeChildren`, one key per
 * visible child) where this session reads the object, else the served listing's subtrees. Either way every key is
 * judged here again with `canSee`, as a listing is. An object that does not serve an ask hands the rest of the call
 * to the listing.
 */
function levelsOf(store) {
  let listing = null;
  const viaListing = () => (listing ??= servedListingStore(store));
  const children = typeof store?.treeChildren === "function" ? store.treeChildren : null;
  const held = new Map();
  let objectServes = children !== null;

  /** The visible keys under `folder` (`""`: the root) that say what it holds: every one, or one per child. */
  async function keysUnder(folder, scope, rules, overrides, prefetch = []) {
    if (objectServes) {
      if (!held.has(folder)) {
        const wanted = [folder, ...prefetch.filter((other) => other !== folder && !held.has(other))].slice(0, CHILDREN_PER_ASK);
        const answer = await children(wanted);
        if (answer === null) objectServes = false;
        else for (const asked of wanted) held.set(asked, answer[asked]);
      }
      if (objectServes) return visibleKeys(held.get(folder).map((key) => ({ key })), folder, scope, rules, overrides);
    }
    return visibleKeys(await listAllKeys(viaListing(), folder === "" ? "" : `${folder}/`), folder, scope, rules, overrides);
  }

  return {
    /** The names one level holds, files and folders, from the visible keys under it. */
    async children(parent, scope, rules, overrides, prefetch) {
      const prefix = parent === "" ? "" : `${parent}/`;
      const files = new Set();
      const folders = new Set();
      for (const key of await keysUnder(parent, scope, rules, overrides, prefetch)) {
        const rest = key.slice(prefix.length);
        const slash = rest.indexOf("/");
        if (slash === -1) files.add(rest);
        else folders.add(rest.slice(0, slash));
      }
      return { files, folders };
    },
    /** Does this connection see anything under `folder`? */
    async seen(folder, scope, rules, overrides, prefetch) {
      return (await keysUnder(folder, scope, rules, overrides, prefetch)).length > 0;
    },
  };
}

/** The keys under `folder` this connection may see, plumbing never. */
function visibleKeys(objects, folder, scope, rules, overrides) {
  const prefix = folder === "" ? "" : `${folder}/`;
  return objects.map(({ key }) => key).filter((key) => key.startsWith(prefix) && !isPlumbing(key) && canSee(key, scope, rules, overrides));
}

/**
 * The refusal for a new `path` that twins a sibling, or null. Walks down from
 * the root: a folder that exists is entered, and the first segment that does
 * not is compared with its siblings. `ignore` is the path being renamed.
 */
export async function nameTwinRefusal(store, scope, rules, overrides, path, { kind = "file", ignore, topOnly = false } = {}) {
  if (isPlumbing(path)) return null;
  // `topOnly`: only the top-level folder is judged. A move the workspace object makes refuses a twin by case anywhere
  // on its path itself (`DEFER`, `workspaceStore/moveWrites.js`), so only a top-level folder twinning another's role
  // is left to ask here; listing the destination's own folder took 333 ms in production (2026-11-03).
  const levels = levelsOf(store);
  const segments = path.split("/");
  // Every folder on the way down, asked of the object in one call; the root only if the walk reaches it.
  const below = (topOnly ? segments.slice(0, 1) : segments.slice(0, -1)).map((_, index) => segments.slice(0, index + 1).join("/"));
  try {
    for (let index = 0; index < (topOnly ? 1 : segments.length); index += 1) {
      const last = index === segments.length - 1;
      const here = segments.slice(0, index + 1).join("/");
      if (!last && here !== ignore && (await levels.seen(here, scope, rules, overrides, below))) continue;
      const parent = segments.slice(0, index).join("/");
      const { files, folders } = await levels.children(parent, scope, rules, overrides, below);
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

/**
 * The refusal for moving or renaming the folder that plays a main role, or one
 * of the Inbox's own folders (`INBOX_PARTS`, owner 2026-10-18), or of Tex's
 * own at `tex/` (`TEX_PARTS`, owner 2026-10-21), or null. A Tex folder nested
 * elsewhere is kept by the control plane's own check (`assertNotTexPart`).
 */
export async function protectedFolderRefusal(store, scope, rules, overrides, path) {
  const segments = path.split("/");
  const inboxPart = segments.length === 2 && INBOX_PARTS.includes(segments[1]) && isMainFolder(segments[0]) && topLevelRole(segments[0]) === "inbox";
  const texPart = segments.length === 2 && segments[0] === "tex" && TEX_PARTS.includes(segments[1]);
  if (!isMainFolder(path) && !inboxPart && !texPart) return null;
  let folders;
  try {
    folders = [...(await levelsOf(store).children("", scope, rules, overrides)).folders];
  } catch {
    folders = [];
  }
  if (texPart) {
    if (!folders.includes("tex")) return null;
    return `${segments[1]} is one of Tex's own folders: Tex files into it by name, so it stays where it is. You can add your own notes and folders beside it.`;
  }
  if (inboxPart) {
    if (!isProtectedFolder(segments[0], folders)) return null;
    return `${INBOX_PART_LABEL[segments[1]]} is one of the Inbox's own folders: Context files into it, so it stays where it is. You can add your own notes and folders beside it.`;
  }
  if (!isProtectedFolder(path, folders)) return null;
  return `${ROLE_LABEL[topLevelRole(path)]} is a built-in folder, so it can't be renamed or moved. Move what's inside it instead.`;
}
