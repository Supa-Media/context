/**
 * Two guards about names at one level, both read off what the caller can see
 * (decided by the owner, 2026-10-14, after an agent made `projects` beside
 * `Projects` in a personal workspace and nobody could remove it):
 *
 *  - **A built-in folder is protected only while it is the folder for its
 *    role.** A second folder claiming the role is ordinary, so it can be
 *    emptied into the real one and deleted. `isProtectedFolder` decides.
 *  - **A new name may not twin a sibling.** Names that differ only by case are
 *    one folder to a person and two to the bucket, and at the root a new
 *    folder may not take a role another folder already plays. `siblingTwin`
 *    decides; the refusal names the folder to use instead.
 *
 * Both list through `listFolder`, so a sibling the caller cannot see is not
 * there for them: a twin hidden from them is not refused on (that refusal
 * would disclose it), and a hidden role-mate leaves the visible folder
 * protected, which is the safe direction.
 */

import { ROLE_LABEL, isMainFolder, isProtectedFolder, siblingTwin, topLevelRole, twinMessage } from "@context/shared/src/folderRoles.cjs";
import { canSee, isPlumbing } from "../privacy";
import { type Clearance } from "../clearance";
import { LIST_PAGE_CAP, type FileStore } from "./store";
import { FileOpError } from "./errors";
import { folderVisibleAtScope } from "./listing";
import { baseName } from "./paths";
import { loadPrivacyState } from "./privacyState";
import { namesListing } from "./walk";

interface Sibling {
  kind: "file" | "folder";
  name: string;
}

/**
 * One level's names as the tree draws them (`namesListing`: the Convex tree
 * wherever the barrier attached it, never a bucket listing there), less what
 * the caller cannot see.
 */
type PrivacyState = Awaited<ReturnType<typeof loadPrivacyState>>;

async function visibleNames(
  store: FileStore,
  folder: string,
  clearance: Clearance,
  state: PrivacyState,
): Promise<Sibling[]> {
  const prefix = folder === "" ? "" : `${folder}/`;
  const names = namesListing(store);
  const siblings: Sibling[] = [];
  let cursor: string | undefined;
  for (let page = 0; page < LIST_PAGE_CAP; page += 1) {
    const listing = await names.list({ prefix, delimiter: "/", cursor, limit: 1000 });
    for (const object of listing.objects ?? []) {
      if (object.key === prefix || isPlumbing(object.key)) continue;
      if (!canSee(object.key, clearance.scope, state.rules, state.overrides, clearance.names)) continue;
      siblings.push({ kind: "file", name: baseName(object.key) });
    }
    for (const raw of listing.delimitedPrefixes ?? []) {
      const path = raw.replace(/\/+$/, "");
      if (!folderVisibleAtScope(path, clearance, state.rules, state.overrides)) continue;
      siblings.push({ kind: "folder", name: baseName(path) });
    }
    if (!listing.truncated || !listing.cursor || listing.cursor === cursor) break;
    cursor = listing.cursor;
  }
  return siblings;
}

/**
 * Refuse to rename, move, archive or delete the folder that plays a main role.
 * A path that is not top-level, or names no main role, costs nothing; only a
 * role-shaped name lists the root to see whether it is the role's one folder.
 */
export async function assertNotProtectedFolder(store: FileStore, path: string, clearance: Clearance): Promise<void> {
  if (!isMainFolder(path)) return;
  const root = await visibleNames(store, "", clearance, await loadPrivacyState(store));
  const folders = root.filter((entry) => entry.kind === "folder").map((entry) => entry.name);
  if (!isProtectedFolder(path, folders)) return;
  const role = topLevelRole(path);
  const label = role === null ? path : ROLE_LABEL[role];
  throw new FileOpError(
    "PATH_INVALID",
    `${label} is a built-in folder, so it can't be renamed, moved or deleted. What's inside it can be.`,
  );
}

/** Is there a folder at `folder` this caller can see? Lists that folder's own level only. */
async function folderSeen(store: FileStore, folder: string, clearance: Clearance, state: PrivacyState): Promise<boolean> {
  if (!folderVisibleAtScope(folder, clearance, state.rules, state.overrides)) return false;
  const listing = await namesListing(store).list({ prefix: `${folder}/`, delimiter: "/", limit: 1 });
  return (listing.objects ?? []).length > 0 || (listing.delimitedPrefixes ?? []).length > 0;
}

/**
 * Refuse a new path whose first missing segment twins a sibling. Walks down
 * from the root: a folder that exists is entered (asking only about itself),
 * and the first segment that does not is compared with its siblings. Below
 * that everything is new, so there is nothing to compare with. A listing that
 * fails skips the check: the write is not held hostage to it.
 */
export async function assertNoNameTwin(
  store: FileStore,
  path: string,
  clearance: Clearance,
  kind: "file" | "folder",
  /** The path being renamed, which is not its own twin: `pay.md` may become `Pay.md`. */
  ignore?: string,
): Promise<void> {
  if (isPlumbing(path)) return;
  const state = await loadPrivacyState(store);
  const segments = path.split("/");
  let refusal: string | null = null;
  try {
    for (let index = 0; index < segments.length; index += 1) {
      const last = index === segments.length - 1;
      const here = segments.slice(0, index + 1).join("/");
      if (!last && here !== ignore && (await folderSeen(store, here, clearance, state))) continue;
      const parent = segments.slice(0, index).join("/");
      const siblings = (await visibleNames(store, parent, clearance, state))
        .map((entry) => entry.name)
        .filter((name) => (parent === "" ? name : `${parent}/${name}`) !== ignore);
      const name = segments[index];
      if (last && siblings.includes(name)) break;
      const twin = siblingTwin(name, siblings, { topLevelFolder: index === 0 && (!last || kind === "folder") });
      if (twin !== null) {
        const instead = [...segments.slice(0, index), twin, ...segments.slice(index + 1)].join("/");
        refusal = twinMessage(name, twin, instead, index === 0);
      }
      break;
    }
  } catch {
    return;
  }
  if (refusal !== null) throw new FileOpError("DESTINATION_EXISTS", refusal);
}
