import { restoreTargetFor } from "../files/paths";
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
export type NoteActionId = "share" | "rename" | "moveTo" | "copyLink" | "archive" | "restore";

export interface NoteActionContext {
  /** The note or folder that is open. */
  entry: FileEntry;
  canEdit: boolean;
  /** Owner-only: the share sheet, and the team link Copy link copies. */
  canShare: boolean;
  /** The homepage's visitor, whose Copy link copies the page's own address. */
  visitor: boolean;
}

export function noteActionItems({
  entry,
  canEdit,
  canShare,
  visitor,
}: NoteActionContext): MenuItem<NoteActionId>[] {
  const writable = canEdit && !entry.readOnly;
  const archived = restoreTargetFor(entry.path) !== null;
  const items: MenuItem<NoteActionId>[] = [];

  if (!visitor && canShare && !entry.readOnly) {
    items.push({ id: "share", label: "Share…", testID: "note-action-share" });
  }
  if (writable) {
    items.push({ id: "rename", label: "Rename", testID: "note-action-rename" });
    items.push({ id: "moveTo", label: "Move to…", testID: "note-action-move" });
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
