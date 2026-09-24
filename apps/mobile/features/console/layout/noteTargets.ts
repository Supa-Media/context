import { entryAt } from "../files/tree";
import type { ConsoleData } from "../types";

/**
 * What the top bar's Share and reading-mode eye act on. Pure: read off the
 * selection on every render of the console, exactly as the layout read it.
 */
export function noteTargetsFor({ browsing, data }: { browsing: boolean; data: ConsoleData }) {
  /**
   * The note the top bar's Share acts on, or `null`.
   *
   * The one control that had to find a new home when the breadcrumb row went.
   * `BrowsePane` puts Share beside the note's name on a pointer layout, and the
   * name is inside the document now — so on a phone it moves into the top bar's
   * trailing group, which is what Obsidian's ⋯ container is for.
   *
   * The same three conditions the pane applied, because they are the server's:
   * `canShare` is `canEdit && isOwner`, `privacy.md` is read-only, and a folder
   * has its own team-link offer in `FolderView` rather than this one.
   */
  const selectedEntry =
    data.files.selectedPath === null
      ? null
      : entryAt(data.files.listings, data.files.selectedPath, data.files.editor);
  /**
   * **A folder is a share target too, and it used to draw its own button.**
   *
   * `FolderView` had a text "Share…" pill in its heading and a full-width
   * "Make this folder private" beneath it, so a folder and a note offered the
   * same two capabilities through two different sets of controls in two
   * different places — the folder's being the pair that filled the top third
   * of a phone screen. They are one pair now, in the group Obsidian's ⋯
   * container is for, and `FolderView` draws neither.
   *
   * What is shared differs and that is the dialog's business, not this
   * button's: `ShareDialog` offers a person a note and offers a *team link*
   * for a folder, because `createShare` has no folder form — see
   * `SHARE_TRAVERSAL_DEPTH` in `functions/shares.ts` and the rule `menu.ts`
   * states for the row menu.
   */
  const shareTarget =
    browsing && data.files.canShare && selectedEntry !== null && !selectedEntry.readOnly
      ? selectedEntry.path
      : null;

  /**
   * Whether the eye is offered, which is a wider question than Share's.
   *
   * Any open **note** can be read, including the ones `shareTarget` refuses:
   * `privacy.md` and an encrypted envelope are exactly the notes somebody is
   * reading rather than editing, and both are already `readOnly`, so the mode
   * costs them nothing and the markup goes quiet for them too. A folder has no
   * document to put into reading mode and gets no eye.
   */
  const readable = browsing && selectedEntry !== null && selectedEntry.kind === "file";
  return { selectedEntry, shareTarget, readable };
}
