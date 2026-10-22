import { isPlumbing } from "../privacy";
import { type Clearance } from "../clearance";
import { type FileStore } from "./store";
import { FileOpError, notFound } from "./errors";
import { baseName, joinPath, requirePath } from "./paths";
import { loadPrivacyState } from "./privacyState";
import { folderVisibleAtScope } from "./listing";
import { renderNewFolderAbout } from "./folders";
import { namesListing } from "./walk";
import { trashKeyedRows, type DeleteResult } from "./deleting";

/**
 * Take back a folder that was just made: the Undo on "Created Hiring in Team"
 * (board 05c of the phone Home artboards, approved 2026-09-30).
 *
 * **Only while it is still empty**, and "empty" is checked against the bucket
 * rather than against what this caller can see: the folder's one key must be
 * the `about.md` that `createFolder` wrote, still word for word what it
 * wrote. A note somebody filed in it since — including one this caller is not
 * allowed to see — or a sentence typed into the about note, and the folder
 * is kept with a plain sentence saying so. Anything else would be a permanent
 * delete of somebody's work behind a button labelled Undo.
 *
 * The refusal names nothing inside the folder, so it tells a caller only what
 * the folder they made seconds ago now holds *something*, never what.
 *
 * The folder is trashed as its rows (`trashKeyedRows`): the same emptiness
 * check, made on the tree's names, and a folder that is restorable rather than gone.
 */
export async function removeNewFolder(
  store: FileStore,
  options: { path: string; clearance: Clearance },
): Promise<DeleteResult> {
  const folder = requirePath(options.path);
  if (isPlumbing(folder)) {
    throw new FileOpError("PATH_INVALID", "Paths beginning with a dot are reserved for history and audit.");
  }
  const state = await loadPrivacyState(store);
  if (!folderVisibleAtScope(folder, options.clearance, state.rules, state.overrides)) throw notFound();

  const about = joinPath(folder, "about.md");
  // Two keys are enough to know it is not only the about note. The tree's
  // names (`namesListing`): a note filed seconds ago that it has not heard of
  // yet is not lost, since only the about note is deleted, and only at the
  // version read below.
  const listing = await namesListing(store).list({ prefix: `${folder}/`, limit: 2 });
  const keys = (listing.objects ?? []).map((object) => object.key);
  if (keys.length === 0) throw notFound();
  const kept = new FileOpError("FOLDER_NOT_EMPTY", `${baseName(folder)} has something in it now, so it was kept.`);
  if (keys.length > 1 || listing.truncated || keys[0] !== about) throw kept;

  // The about note's bytes are at its id key, and the path holds nothing this store can judge, so the check
  // above is the tree's: the folder holds only its about note. The folder then moves to the trash as rows,
  // which Restore reverses. The text typed into the about note is not compared here; it stays in the trash
  // with the folder.
  return await trashKeyedRows(store, { path: folder, clearance: options.clearance, now: Date.now() });
}
