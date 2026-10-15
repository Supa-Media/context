/**
 * Carrying a keyed note's collaboration history with its row through a trash
 * or a restore (`docs/decisions/storage-and-credentials/notes-by-id.md`, "Trash
 * and Restore"). A trash moves the note's row and leaves its heads where they
 * were; without this the old name stays active, and a note created there later
 * opens the trashed note's live document.
 *
 * It runs after the row change, once per Markdown note the change moved, and
 * is best-effort: a rename that fails leaves the row change standing. Nothing
 * here reads or writes a note's bytes (`renameDocument` touches heads and
 * state only). Per-note identity is checked when the name is next opened, so a
 * failed carry cannot attach a new note to the old history.
 */

import { renameDocument, supported as collaborationSupported } from "@context/collaboration";
import type { FileStore } from "../fileOps/store";

export interface HistoryMove {
  from: string;
  to: string;
}

/**
 * Carry the heads and state of each Markdown note in `moves` from its old name
 * to its new one. A trash location is an allowed end (`internalTrash`). Never
 * throws: the failure is logged by code, and the row change it follows stands.
 */
export async function carryRowHistory(store: FileStore, moves: readonly HistoryMove[]): Promise<void> {
  if (!collaborationSupported(store)) return;
  for (const move of moves) {
    if (!move.from.endsWith(".md") || !move.to.endsWith(".md")) continue;
    try {
      await renameDocument(store, move.from, move.to, { internalTrash: true });
    } catch (error) {
      const code = error && typeof error === "object" && "code" in error ? String((error as { code?: unknown }).code) : "ERROR";
      console.error("nodes.trash_history_failed", { code });
    }
  }
}
