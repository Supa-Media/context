import { entryAt } from "../files/tree";
import type { ConsoleData } from "../types";

/**
 * What the top bar's ••• acts on. Pure: read off the
 * selection on every render of the console, exactly as the layout read it.
 */
export function noteTargetsFor({ data }: { data: ConsoleData }) {
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

  return { selectedEntry };
}
