import { entryAt } from "../files/tree";
import type { ConsoleData } from "../types";

/**
 * What the top bar's ••• and reading-mode eye act on. Pure: read off the
 * selection on every render of the console, exactly as the layout read it.
 */
export function noteTargetsFor({ browsing, data }: { browsing: boolean; data: ConsoleData }) {
  /**
   * The note or folder that is open, or `null`.
   *
   * What the phone's ••• acts on (`NoteActionsSheet`). A folder is a target
   * too: renaming, moving and archiving it are the same verbs, and its Share
   * row offers a team link rather than a person, which is the dialog's
   * business — see `SHARE_TRAVERSAL_DEPTH` in `functions/shares.ts`. Which
   * rows each person gets is `noteActionItems`', including the server's own
   * rules: `canShare` is `canEdit && isOwner`, and `privacy.md` is read-only.
   *
   * It was also the top bar's Share target; Share moved into ••• on
   * 2026-09-27 (the phone artboards).
   */
  const selectedEntry =
    data.files.selectedPath === null
      ? null
      : entryAt(data.files.listings, data.files.selectedPath, data.files.editor);

  /**
   * Whether the eye is offered.
   *
   * Any open **note** can be read, including read-only ones: `privacy.md` and
   * an encrypted envelope are exactly the notes somebody is reading rather
   * than editing, so the mode costs them nothing and the markup goes quiet for
   * them too. A folder has no document to put into reading mode and gets no
   * eye.
   */
  const readable = browsing && selectedEntry !== null && selectedEntry.kind === "file";
  return { selectedEntry, readable };
}
