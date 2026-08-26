/**
 * Copy, cut and paste for files.
 *
 * A cut-and-paste is a move and a copy-and-paste is a copy, so this module's
 * whole job is to work out which one, to where, under what name — and to say
 * no to the pastes that cannot work, before a round trip rather than after one.
 *
 * Pure and separate for the usual reason: the awkward cases (pasting a copy
 * back into its own folder, pasting a folder into itself, pasting a cut where
 * it already is) are the ones worth pinning, and none of them need a renderer.
 */

import { baseName, duplicateName, joinPath, parentPath } from "./paths";

export type ClipboardMode = "copy" | "cut";

export interface Clipboard {
  mode: ClipboardMode;
  path: string;
  /** For the toolbar's "Paste `foo.md`" label. */
  name: string;
}

export function put(mode: ClipboardMode, path: string): Clipboard {
  return { mode, path, name: baseName(path) };
}

export type PastePlan =
  | { ok: true; action: "copy" | "move"; from: string; to: string }
  | { ok: false; reason: string };

/**
 * What pasting into `destinationFolder` would do.
 *
 * `taken` is the set of names already in that folder. Two different answers
 * depend on it, and the difference is the point:
 *
 *  - **copy** into a folder that already has the name picks the next free
 *    "… copy" name, exactly as duplicating does. That is what every file
 *    manager does and what people expect.
 *  - **cut** into a folder that already has the name is **refused**. A move
 *    that renames itself out of a collision is a move that quietly did
 *    something other than what was asked, and the original is gone.
 */
export function planPaste(
  clipboard: Clipboard | null,
  destinationFolder: string,
  taken: ReadonlySet<string>,
): PastePlan {
  if (clipboard === null) return { ok: false, reason: "Nothing has been copied." };

  const { mode, path } = clipboard;
  if (destinationFolder === path || destinationFolder.startsWith(`${path}/`)) {
    return { ok: false, reason: "A folder cannot be pasted inside itself." };
  }

  const name = baseName(path);

  if (mode === "cut") {
    if (parentPath(path) === destinationFolder) {
      return { ok: false, reason: "It is already there." };
    }
    if (taken.has(name)) {
      return {
        ok: false,
        reason: `${label(destinationFolder)} already has something called ${name}. Rename one of them first.`,
      };
    }
    return { ok: true, action: "move", from: path, to: joinPath(destinationFolder, name) };
  }

  const free = taken.has(name) ? duplicateName(name, taken) : name;
  return { ok: true, action: "copy", from: path, to: joinPath(destinationFolder, free) };
}

function label(folder: string): string {
  return folder === "" ? "The root" : folder;
}

/**
 * A cut is spent once it lands; a copy stays on the clipboard.
 *
 * Same as every file manager, and it matters here because a cut whose source
 * no longer exists would produce a confusing `FILE_NOT_FOUND` on the second
 * paste rather than doing nothing.
 */
export function afterPaste(clipboard: Clipboard): Clipboard | null {
  return clipboard.mode === "cut" ? null : clipboard;
}
