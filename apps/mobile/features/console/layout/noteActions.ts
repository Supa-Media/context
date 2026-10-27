import { isMarkdown, restoreTargetFor } from "../files/paths";
import { chipsFit } from "../files/noteEditor/chips/chipModel";
import type { MenuItem } from "../files/menuItem";
import type { FileEntry } from "../files/types";

/**
 * The phone's note actions: what the top bar's ••• offers about the open note.
 *
 * Approved by the owner on 2026-09-27 (the phone artboards, screen 7). iPhone
 * Safari has no right-click, and the note's verbs were reachable on a phone
 * only through a long press on its row in a folder listing — a row you cannot
 * see while you are reading the note. So the capsule at the top right carries
 * the read/edit toggle and a •••, and ••• raises this list as a bottom sheet
 * (the shared `Menu`, which is a sheet at phone width).
 *
 * **Nothing here is a new operation.** Every row is one the tree's and the
 * folder listing's menus already run, through the same `runMenuAction` and the
 * same dialogs (`ExplorerDialogs`, raised through the console's `barDialog`):
 * Share…, Rename, Move to…, and Archive. Copy link is the share sheet's own
 * Copy link (`copyShareLink`, the team link that grants nothing) for an owner,
 * and the homepage's copy-the-page-link for a visitor.
 *
 * Two rows on the artboard are not here, because nothing behind them exists to
 * reuse: **Comments (n)** — comments open from their highlight inside the
 * editor, which has no way in from outside it yet — and **History** — the
 * console keeps no per-note version history; Recent is the bottom bar's.
 *
 * **What a visitor sees is decided by permission, not by a second list.** A
 * visitor's edits stay in their tab, so they may rename and move there, and
 * copy the page's link; they have no workspace to share into and no archive.
 */
export type NoteActionId = "read" | "pageText" | "share" | "rename" | "moveTo" | "addProperty" | "copyLink" | "archive" | "restore";

export interface NoteActionContext {
  /** The note or folder that is open. */
  entry: FileEntry;
  canEdit: boolean;
  /** Owner-only: the share sheet, and the team link Copy link copies. */
  canShare: boolean;
  /** The homepage's visitor, whose Copy link copies the page's own address. */
  visitor: boolean;
  /**
   * Whether the note is being read rather than edited, for the sheet's first
   * row. Absent where there is no such row — the phone's note bar, which only
   * offers Share and Move.
   */
  reading?: boolean;
  /**
   * For a `.page.md` note drawn as a page: whether it is shown as its text
   * right now. The sheet then offers "Edit as text" or "View as page" in place
   * of reading mode and Add property, which a page has no use for.
   */
  pageAsText?: boolean;
}

export function noteActionItems({
  entry,
  canEdit,
  canShare,
  visitor,
  reading,
  pageAsText,
}: NoteActionContext): MenuItem<NoteActionId>[] {
  const writable = canEdit && !entry.readOnly;
  const archived = restoreTargetFor(entry.path) !== null;
  const items: MenuItem<NoteActionId>[] = [];

  /*
    Reading mode, first. It was an eye in the top bar beside •••; the owner's
    redesign of that bar (2026-10-13) found it the least important button
    there, so it is a row now. Any note can be read, a read-only one included,
    so it has no permission to check. Named as the act, as the eye's label was.
  */
  const page = pageAsText !== undefined && entry.kind === "file";
  if (page) {
    items.push({ id: "pageText", label: pageAsText ? "View as page" : "Edit as text", testID: "note-action-page-text" });
  } else if (reading !== undefined && entry.kind === "file") {
    items.push({
      id: "read",
      label: reading ? "Edit this note" : "Read this note",
      testID: "note-action-read",
    });
  }

  if (!visitor && canShare && !entry.readOnly) {
    items.push({ id: "share", label: "Share…", testID: "note-action-share" });
  }
  if (writable) {
    items.push({ id: "rename", label: "Rename", testID: "note-action-rename" });
    items.push({ id: "moveTo", label: "Move to…", testID: "note-action-move" });
  }
  /*
    Add property: the way in for a loose note, which draws no chips over its
    name on a phone (owner, 2026-10-18, board A of `loose-note-chips`). It
    opens the note's Properties card on its Add row (`addPropertyAsk.ts`).
  */
  if (!page && !visitor && writable && entry.kind === "file" && isMarkdown(entry.path) && chipsFit(entry.path)) {
    items.push({ id: "addProperty", label: "Add property", testID: "note-action-add-property" });
  }
  if (visitor || canShare) {
    items.push({ id: "copyLink", label: "Copy link", testID: "note-action-copy-link" });
  }
  if (!visitor && writable) {
    items.push(
      archived
        ? { id: "restore", label: "Restore", separatorBefore: true, testID: "note-action-restore" }
        : {
            id: "archive",
            label: "Move to archive",
            danger: true,
            separatorBefore: true,
            testID: "note-action-archive",
          },
    );
  }
  return items;
}
