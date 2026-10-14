import type { FileBrowser } from "../../files/browser";
import { renamedFileName, shownNoteName } from "../../files/noteName";

/**
 * The open note's name as something to edit, for the two places a note is
 * renamed from itself — the header's path line and a title-less note's inline
 * title — or `undefined` where this person may not rename it (a viewer's
 * console, `privacy.md`, a note the gateway marks read-only).
 *
 * Both go through `rename`, the Rename dialog's own path, so a taken or
 * invalid name is turned down with the same notice and a refused move puts the
 * old name back in both.
 */
export function noteNameEdit(
  files: Pick<FileBrowser, "canEdit" | "rename" | "renamed">,
  path: string | null,
  readOnly: boolean,
): { name: string; onCommit: (typed: string) => void } | undefined {
  if (path === null || !files.canEdit || readOnly) return undefined;
  return {
    name: shownNoteName(path, files.renamed),
    onCommit: (typed) => {
      const to = renamedFileName(path, typed);
      if (to !== null) files.rename(path, to);
    },
  };
}
