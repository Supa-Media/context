/**
 * Folder icons from the console: reading them at the caller's clearance and
 * setting one. Storage, moves and deletes are `@context/shared`'s
 * `folderIcons.cjs`, shared with the gateway.
 *
 * ## The privacy rule
 *
 * The file names folders by path, and a path is information: `2-areas/divorce`
 * with a ⚖️ beside it says something even with no note open. So a reader gets
 * exactly the icons of the folders their listing would draw
 * (`folderVisibleAtScope`) and nothing else, and setting one on a folder the
 * caller cannot see answers "does not exist", the same as every other write.
 */

import { isSingleEmoji } from "@context/shared";
import {
  type FolderIcons,
  readFolderIcons,
  updateFolderIcons,
} from "@context/shared/src/folderIcons.cjs";
import { isPlumbing } from "../privacy";
import { type Clearance } from "../clearance";
import type { FileStore } from "./store";
import { FileOpError, notFound } from "./errors";
import { requireFolderPath } from "./paths";
import { loadPrivacyState } from "./privacyState";
import { folderVisibleAtScope } from "./listing";
import { isFolder } from "./walk";

/** Every icon on a folder this caller can see. */
export async function listFolderIcons(
  store: FileStore,
  options: { clearance: Clearance },
): Promise<FolderIcons> {
  const { icons } = await readFolderIcons(store);
  const paths = Object.keys(icons);
  if (paths.length === 0) return {};
  const state = await loadPrivacyState(store);
  const visible: FolderIcons = {};
  for (const path of paths) {
    if (folderVisibleAtScope(path, options.clearance, state.rules, state.overrides)) visible[path] = icons[path];
  }
  return visible;
}

/**
 * Give a folder an icon, or take it away (`icon: null`). Returns the icons the
 * caller can now see, so the app redraws from the server's answer.
 */
export async function setFolderIcon(
  store: FileStore,
  options: { path: string; icon: string | null; clearance: Clearance },
): Promise<FolderIcons> {
  const path = requireFolderPath(options.path);
  if (path === "" || isPlumbing(path)) throw new FileOpError("PATH_INVALID", "Only a folder can have an icon.");
  if (options.icon !== null && !isSingleEmoji(options.icon)) {
    throw new FileOpError("PATH_INVALID", "A folder icon is one emoji.");
  }
  const state = await loadPrivacyState(store);
  if (!folderVisibleAtScope(path, options.clearance, state.rules, state.overrides)) throw notFound();
  if (options.icon !== null && !(await isFolder(store, path))) throw notFound();

  const icon = options.icon;
  const written = await updateFolderIcons(store, (icons) => {
    if (icon === null ? !(path in icons) : icons[path] === icon) return null;
    const next = { ...icons };
    if (icon === null) delete next[path];
    else next[path] = icon;
    return next;
  });
  if (written === null) {
    // Either nothing changed, or two writes raced twice; the read below says which.
    const { icons } = await readFolderIcons(store);
    if ((icon === null && !(path in icons)) || (icon !== null && icons[path] === icon)) {
      return await listFolderIcons(store, { clearance: options.clearance });
    }
    throw new FileOpError("CONFLICT", "Folder icons changed while this one was being set. Try again.");
  }
  return await listFolderIcons(store, { clearance: options.clearance });
}
