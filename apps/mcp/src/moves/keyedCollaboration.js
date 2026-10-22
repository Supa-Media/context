/**
 * Carrying a moved note's collaboration history to its new name, after a keyed
 * row move (`docs/decisions/storage-and-credentials/notes-by-id.md`).
 *
 * The control plane has already moved the rows; this is the engine's half. It
 * runs once per moved file, in the request that moved it, so the open editor's
 * next save lands at the new name rather than on a head the row no longer
 * serves. It is best-effort and bounded:
 *
 *  - A file with no collaboration state costs one read and nothing else.
 *  - A rename that fails after the new name is claimed leaves the row move
 *    standing and the rename journaled: the next read of the new name finishes
 *    it. A failure before the claim leaves the old head still active and the new
 *    name unclaimed, and nothing here retries it. That window is the open gap in
 *    `notes-by-id.md`. The history stays in the customer's bucket either way.
 *  - A rename that succeeds tells the room that held the old name, so its
 *    sockets learn where the note went (`announceMovedToPresence`). The new
 *    name is sent only where the team tier may see it: a room holds people who
 *    could see the old name, not necessarily the new one, and a move can narrow.
 */

import { renameDocument, supported as collaborationSupported } from "@context/collaboration";
import { canSee } from "../privacy/engine.js";
import { announceMovedToPresence } from "../live/presence.js";

/**
 * Moved files one request will carry. A keyed folder over the row cap moves in pages
 * (`rowMoveChunks.ts`), so a bigger folder's notes past this are not carried here:
 * the open gap `notes-by-id.md` names.
 */
export const COLLABORATION_RENAME_MAX = 500;

/**
 * Carry each moved note's collaboration state from its old name to its new one.
 *
 * @param {object} store the request's store (its collaboration heads and state are plumbing)
 * @param {{from: string, to: string}[]} moved the files the row move renamed
 * @param {{rules: unknown, overrides: unknown}} privacy the rules the move was judged under; without them no name is shared
 * @param {{carried?: boolean}} [options] `carried`: the control plane already carried the history with the rows
 *   (`historyCarried` on its answer), so only the rooms are told
 * @returns {Promise<{renamed: number, failed: string[]}>} the codes of any refusals, never the paths
 */
export async function renameCollaboration(store, moved, privacy, { carried = false } = {}) {
  const answer = { renamed: 0, failed: [] };
  if (!collaborationSupported(store) || !Array.isArray(moved)) return answer;
  for (const pair of moved.slice(0, COLLABORATION_RENAME_MAX)) {
    if (typeof pair?.from !== "string" || typeof pair?.to !== "string") continue;
    if (!pair.from.endsWith(".md") || !pair.to.endsWith(".md")) continue;
    try {
      if (!carried && (await renameDocument(store, pair.from, pair.to)).renamed !== true) continue;
      answer.renamed += 1;
      // Shown to the room only where every team member may see the new name; otherwise members are told it moved, not where.
      const shownTo = privacy && canSee(pair.to, "team", privacy.rules, privacy.overrides) ? pair.to : null;
      await announceMovedToPresence(store, pair.from, shownTo).catch(() => {});
    } catch (error) {
      const code = typeof error?.code === "string" ? error.code : "ERROR";
      answer.failed.push(code);
      console.error("moves.collaboration_rename_failed", { code });
    }
  }
  return answer;
}
