/**
 * A whole-note save's editing history: in the workspace object in one call where the store offers it
 * (`store/idLayout.js` `replaceInObject`, `workspaceStore/collabReplace.js`), else the engine through the store.
 *
 * The object runs the same engine on its own storage, so the answer and every refusal are the same: a conflict is a
 * `CONFLICT` either way. A call that fails on the way (the object unreachable) runs the engine here instead. That is
 * safe because the engine only ever commits on the version it read: had the object committed, the version has moved
 * and the save here is refused as a conflict, never applied twice.
 */
import { CollaborationError, replaceText } from "@context/collaboration";
import { phaseTook } from "../../mcp/phase.js";

export async function replaceNoteText(store, path, input) {
  if (input?.onlyCurrent === true && typeof store?.replaceInObject === "function") {
    let answer = null;
    try {
      answer = await store.replaceInObject(path, { expectedEtag: input.expectedEtag, text: input.text });
    } catch {
      answer = null;
    }
    if (answer?.served === false) {
      // Declined by the object: why, and what it spent first, beside the engine's run from here (`inside:collab_declined_*`).
      if (typeof answer.reason === "string") phaseTook(store, `collab_declined_${answer.reason}`, Number.isFinite(answer.took) ? answer.took : 0);
    } else if (answer !== null && answer !== undefined) {
      // How long the object spent on it by its own clock, beside the call's whole trip (`obj:ws.collab.replace`).
      phaseTook(store, "collab_replace", answer.took);
      recordSaveShape(store, answer);
      if (answer.error) throw new CollaborationError(String(answer.error.code ?? "STORAGE_WRITE_FAILED"), String(answer.error.message ?? "collaboration save failed"));
      if (answer.result && typeof answer.result === "object") return answer.result;
    }
  }
  return await replaceText(store, path, input);
}

/** The size bucket of a document state of `bytes`: the history's snapshot is most of it. */
export function stateBucket(bytes) {
  if (bytes < 16 * 1024) return "small";
  if (bytes < 256 * 1024) return "medium";
  if (bytes < 2 * 1024 * 1024) return "large";
  return "huge";
}

/**
 * A save's shape beside its timings, so a slow save can be told apart (2026-11-06): its whole trip by the size of its
 * document state (`inside:collab_trip_<bucket>`), how long it waited before the object ran it (`collab_waited`),
 * its state and everything it wrote in KB (`collab_state_kb`, `collab_written_kb`), and its writes
 * (`collab_writes`, three on a first try). Sizes only, never content. These are not times though they sit in the
 * timing columns: the timings workflow prints them as they are.
 */
function recordSaveShape(store, answer) {
  const sizes = answer?.sizes;
  if (Number.isFinite(answer?.trip) && Number.isFinite(sizes?.state)) phaseTook(store, `collab_trip_${stateBucket(sizes.state)}`, answer.trip);
  if (Number.isFinite(answer?.waited)) phaseTook(store, "collab_waited", answer.waited);
  if (Number.isFinite(sizes?.state)) phaseTook(store, "collab_state_kb", Math.round(sizes.state / 1024));
  if (Number.isFinite(sizes?.written)) phaseTook(store, "collab_written_kb", Math.round(sizes.written / 1024));
  if (Number.isFinite(sizes?.writes)) phaseTook(store, "collab_writes", sizes.writes);
}
