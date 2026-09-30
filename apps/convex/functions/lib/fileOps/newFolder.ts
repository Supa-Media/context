import { isPlumbing } from "../privacy";
import { type Clearance } from "../clearance";
import { type FileStore } from "./store";
import { FileOpError, notFound } from "./errors";
import { baseName, joinPath, requirePath } from "./paths";
import { loadPrivacyState } from "./privacyState";
import { folderVisibleAtScope } from "./listing";
import { renderFolderPlaceholder } from "./folders";
import { DELETE_CONFIRMATION, deletePath, type DeleteResult } from "./deleting";

/**
 * Take back a folder that was just made: the Undo on "Created Hiring in Team"
 * (board 05c of the phone Home artboards, approved 2026-09-30).
 *
 * **Only while it is still empty**, and "empty" is checked against the bucket
 * rather than against what this caller can see: the folder's one key must be
 * the `README.md` that `createFolder` wrote, still word for word what it
 * wrote. A note somebody filed in it since — including one this caller is not
 * allowed to see — or a sentence typed into the placeholder, and the folder
 * is kept with a plain sentence saying so. Anything else would be a permanent
 * delete of somebody's work behind a button labelled Undo.
 *
 * The refusal names nothing inside the folder, so it tells a caller only what
 * the folder they made seconds ago now holds *something*, never what.
 *
 * The delete itself is `deletePath` on the placeholder, conditional on the
 * version just read where the store can hold a delete to one, so a write
 * into the placeholder between the read and the delete is not lost either.
 * With the placeholder gone, the prefix has no keys and the folder is gone.
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

  const readme = joinPath(folder, "README.md");
  // Two keys are enough to know it is not only the placeholder.
  const listing = await store.list({ prefix: `${folder}/`, limit: 2 });
  const keys = (listing.objects ?? []).map((object) => object.key);
  if (keys.length === 0) throw notFound();
  const kept = new FileOpError("FOLDER_NOT_EMPTY", `${baseName(folder)} has something in it now, so it was kept.`);
  if (keys.length > 1 || listing.truncated || keys[0] !== readme) throw kept;

  const placeholder = await store.get(readme);
  if (placeholder === null) throw notFound();
  if ((await placeholder.text()) !== renderFolderPlaceholder(folder)) throw kept;

  const conditional = store.capabilities?.conditionalDelete === true;
  try {
    return await deletePath(store, {
      path: readme,
      confirmation: DELETE_CONFIRMATION,
      clearance: options.clearance,
      ...(conditional ? { expectedEtag: placeholder.etag } : {}),
    });
  } catch (error) {
    // The placeholder changed between the read and the delete.
    if (error instanceof FileOpError && error.code === "CONFLICT") throw kept;
    throw error;
  }
}
