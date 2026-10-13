/**
 * Folder and note icons from the console: reading them at the caller's
 * clearance and setting one. Storage, moves and deletes are `@context/shared`'s
 * `folderIcons.cjs`, shared with the gateway.
 *
 * ## The privacy rule
 *
 * The file names folders by path, and a path is information: `2-areas/divorce`
 * with a ⚖️ beside it says something even with no note open. So a reader gets
 * exactly the icons of the folders their listing would draw
 * (`folderVisibleAtScope`) and nothing else, and setting one on a folder the
 * caller cannot see answers "does not exist", the same as every other write.
 * A note's icon (since 2026-10-13, keyed by the note's own path) is shown
 * exactly when the note is (`canSee`): a folder's rule is wider than a note
 * held back inside it.
 */

import { customEmojiShortcode, isSingleEmoji } from "@context/shared";
import {
  type FolderIcons,
  readFolderIcons,
  updateFolderIcons,
} from "@context/shared/src/folderIcons.cjs";
import { canSee, isPlumbing } from "../privacy";
import { type Clearance } from "../clearance";
import type { FileStore } from "./store";
import { FileOpError, notFound } from "./errors";
import { requireFolderPath } from "./paths";
import { loadPrivacyState } from "./privacyState";
import { folderVisibleAtScope } from "./listing";
import { isFolder } from "./walk";
import { hasCustomEmoji } from "./emoji";

/**
 * Whether a key in the icons file names a note rather than a folder. Notes are
 * Markdown, so the suffix decides; a folder that happens to end in `.md` is
 * judged by the note rule, which is never wider than the folder one.
 */
function namesNote(path: string): boolean {
  return path.toLowerCase().endsWith(".md");
}

function iconVisible(
  path: string,
  clearance: Clearance,
  state: Awaited<ReturnType<typeof loadPrivacyState>>,
): boolean {
  if (namesNote(path)) return canSee(path, clearance.scope, state.rules, state.overrides, clearance.names);
  return folderVisibleAtScope(path, clearance, state.rules, state.overrides);
}

/** Every icon on a folder or note this caller can see. */
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
    if (iconVisible(path, options.clearance, state)) visible[path] = icons[path];
  }
  return visible;
}

/**
 * Give a folder or a note an icon, or take it away (`icon: null`). Returns the icons the
 * caller can now see, so the app redraws from the server's answer.
 */
export async function setFolderIcon(
  store: FileStore,
  options: { path: string; icon: string | null; clearance: Clearance },
): Promise<FolderIcons> {
  const path = requireFolderPath(options.path);
  if (path === "" || isPlumbing(path)) throw new FileOpError("PATH_INVALID", "Only a folder or a note can have an icon.");
  // One emoji: a character, or one of this workspace's own as `:name:`, which
  // must exist, so an icon never names a picture nobody can draw.
  const custom = options.icon === null ? null : customEmojiShortcode(options.icon);
  if (options.icon !== null && custom === null && !isSingleEmoji(options.icon)) {
    throw new FileOpError("PATH_INVALID", "An icon is one emoji.");
  }
  if (custom !== null && !(await hasCustomEmoji(store, custom))) {
    throw new FileOpError("PATH_INVALID", `This workspace has no :${custom}: emoji.`);
  }
  const state = await loadPrivacyState(store);
  if (!iconVisible(path, options.clearance, state)) throw notFound();
  if (options.icon !== null) {
    const exists = namesNote(path) ? (await store.get(path)) !== null : await isFolder(store, path);
    if (!exists) throw notFound();
  }

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
