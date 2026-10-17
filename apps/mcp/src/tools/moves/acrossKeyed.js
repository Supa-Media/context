/**
 * `move_note` into another workspace when either end is keyed
 * (`docs/decisions/storage-and-credentials/notes-by-id.md`, "A move into
 * another workspace, when either end is keyed").
 *
 * A keyed note's bytes are at its id key and its name is a row, so the
 * path-based move in `acrossContexts.js` cannot read or retire it. The control
 * plane's engine can, and it is the one the console's Move runs: the note
 * lands as a new note in the destination and the source's goes to its trash.
 * The gateway asks it through the source store's `moveAcross` seam
 * (`sessionStore.js`) and writes no bytes itself. Who may move what is decided
 * there, again: owner of the source with private access, editor of the
 * destination.
 */

import { contextNameFor } from "../../context/identity.js";
import { KEYED_PATH_REFUSAL } from "../../store/idLayout.js";
import { toolError, toolText } from "../results.js";

export async function moveNoteAcrossKeyed(
  sourceStore,
  sourceSession,
  destinationSession,
  source,
  destination,
  expectedSourceEtag
) {
  // A store with no control plane (self-tests, an old binding) cannot ask.
  if (typeof sourceStore?.moveAcross !== "function") return toolError(KEYED_PATH_REFUSAL);
  const sourceContext = contextNameFor(sourceSession);
  const destinationContext = contextNameFor(destinationSession);

  if (expectedSourceEtag) {
    // Read through the store, so a keyed note answers from its key, not its frozen path copy.
    const current = await sourceStore.head(source);
    if (!current) return toolError("not found");
    if (current.etag !== expectedSourceEtag) {
      return toolError(`conflict: source changed since you read it (current etag ${current.etag}); re-read and retry`);
    }
  }

  let answer;
  try {
    answer = await sourceStore.moveAcross(destinationSession.workspaceId, source, destination);
  } catch {
    return toolError(
      `the move could not be confirmed; check ${sourceContext}/${source} and ${destinationContext}/${destination} before trying again`
    );
  }
  if (answer === null || answer === undefined) {
    return toolError(
      `permission denied: moving a note out of ${sourceContext} needs owner access there, with private notes, ` +
        `and edit access to ${destinationContext}.`
    );
  }
  if (answer.status !== "complete") {
    return toolError(`not moved: ${answer.error ?? "the move stopped"}`);
  }
  const skipped = Array.isArray(answer.skipped) ? answer.skipped : [];
  if (answer.movedObjects === 0 && skipped.length > 0) {
    const reason = skipped[0]?.reason === "encrypted" ? "it is encrypted" : "it is too large to move";
    return toolError(`not moved: ${sourceContext}/${source} stayed where it is because ${reason}`);
  }
  return toolText(
    `moved: ${sourceContext}/${source} → ${destinationContext}/${destination}\n` +
      "the old copy is in the source workspace's trash\n" +
      "references: not rewritten across workspace boundaries"
  );
}
