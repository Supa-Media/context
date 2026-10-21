/**
 * Folder and note icons from the console: which ones a caller sees, and
 * whether they may set one. The icons are rows in Convex (`folderIcons`,
 * `lib/smallData/icons.ts`) since 2026-10-14; this decides over those rows,
 * the tree's rows (`servedNodesStore`) and the rules mirror, and reads no
 * bucket. Storage of the file the rows are exported to is `@context/shared`'s
 * `folderIcons.cjs`.
 *
 * ## The privacy rule
 *
 * An icon names a folder by path, and a path is information: `2-areas/divorce`
 * with a ⚖️ beside it says something even with no note open. So a reader gets
 * exactly the icons of the folders their listing would draw
 * (`folderVisibleAtScope`) and nothing else, and setting one on a folder the
 * caller cannot see answers "does not exist", the same as every other write.
 * A note's icon (since 2026-10-13, keyed by the note's own path) is shown
 * exactly when the note is (`canSee`): a folder's rule is wider than a note
 * held back inside it.
 */

import { customEmojiShortcode, isSingleEmoji } from "@context/shared";
import { contextIconOf } from "@context/shared/src/contextIcons.cjs";
import type { FolderIcons } from "@context/shared/src/folderIcons.cjs";
import { canSee, isPlumbing } from "../privacy";
import { type Clearance } from "../clearance";
import type { FileStore } from "./store";
import { FileOpError, notFound } from "./errors";
import { requireFolderPath } from "./paths";
import type { PrivacyState } from "./privacyState";
import { folderVisibleAtScope } from "./listing";
import { isFolder } from "./walk";

/**
 * Whether a key names a note rather than a folder. Notes are Markdown, so the
 * suffix decides; a folder that happens to end in `.md` is judged by the note
 * rule, which is never wider than the folder one.
 */
function namesNote(path: string): boolean {
  return path.toLowerCase().endsWith(".md");
}

function iconVisible(path: string, clearance: Clearance, state: PrivacyState): boolean {
  if (namesNote(path)) return canSee(path, clearance.scope, state.rules, state.overrides, clearance.names);
  return folderVisibleAtScope(path, clearance, state.rules, state.overrides);
}

/** Every icon on a folder or note this caller can see. */
export function visibleFolderIcons(icons: FolderIcons, options: { clearance: Clearance; state: PrivacyState }): FolderIcons {
  const visible: FolderIcons = {};
  for (const [path, icon] of Object.entries(icons)) {
    if (iconVisible(path, options.clearance, options.state)) visible[path] = icon;
  }
  return visible;
}

/** Whether the tree holds a note at `path` (a key), or a folder (a key under it). */
async function inTree(tree: FileStore, path: string): Promise<boolean> {
  if (!namesNote(path)) return await isFolder(tree, path);
  const listing = await tree.list({ prefix: path, limit: 1 });
  return listing.objects?.[0]?.key === path;
}

/**
 * Whether this caller may give `path` this icon, or take it away
 * (`icon: null`); answers the path to write, or throws as every other write
 * refuses. `tree` is the Convex tree's store (`servedNodesStore`), so "does it
 * exist" is the tree's answer; `hasEmoji` is Convex's emoji rows.
 */
export async function checkFolderIcon(
  options: {
    path: string;
    icon: string | null;
    clearance: Clearance;
    state: PrivacyState;
    tree: FileStore;
    hasEmoji: (name: string) => Promise<boolean>;
  },
): Promise<string> {
  const path = requireFolderPath(options.path);
  if (path === "" || isPlumbing(path)) throw new FileOpError("PATH_INVALID", "Only a folder or a note can have an icon.");
  // One emoji: a character, one of this workspace's own as `:name:`, which
  // must exist, so an icon never names a picture nobody can draw, or one of
  // Context's own icons (`contextIcons.cjs`), by a name in the set. A drawn
  // part (`context:part:`) is a default, never chosen, so it is refused here.
  const custom = options.icon === null ? null : customEmojiShortcode(options.icon);
  const context = options.icon === null ? null : contextIconOf(options.icon);
  if (options.icon !== null && custom === null && context === null && !isSingleEmoji(options.icon)) {
    throw new FileOpError("PATH_INVALID", "An icon is one emoji.");
  }
  if (custom !== null && !(await options.hasEmoji(custom))) {
    throw new FileOpError("PATH_INVALID", `This workspace has no :${custom}: emoji.`);
  }
  if (!iconVisible(path, options.clearance, options.state)) throw notFound();
  if (options.icon !== null && !(await inTree(options.tree, path))) throw notFound();
  return path;
}
