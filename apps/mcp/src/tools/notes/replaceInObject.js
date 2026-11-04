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
      if (answer.error) throw new CollaborationError(String(answer.error.code ?? "STORAGE_WRITE_FAILED"), String(answer.error.message ?? "collaboration save failed"));
      if (answer.result && typeof answer.result === "object") return answer.result;
    }
  }
  return await replaceText(store, path, input);
}
