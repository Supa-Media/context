/**
 * A text is edited or unsent, node "edit" (`texConfig.json`; Dev2, 2026-11-16: "Build edit support in Tex", "not just
 * edits but deleted messages as well"). When someone edits or unsends a text they sent (iMessage's Edit and Undo Send,
 * as Photon's line hears them), the texting Worker's chat object hands its new words (none for an unsend) and, when the
 * chat still has them, its words before (`apps/agent/src/editStep.ts`). This says only what happened, never whether it
 * deserves an answer: that is Decide's, taught by example conversations (the judge's Training labels on edits).
 *
 * - "same": an edit whose words did not change (folded for case and spacing). Nothing is kept or answered.
 * - "turn": any other edit. It is kept, marked as the edit of the earlier text, and goes on to Triage as a text of its
 *   own, where Decide judges it as it judges any text: a fixed typo can go quiet, a changed ask gets its answer.
 * - "withdraw": an unsend. It is kept as that text taken back, and the text leaves the chat's queue if no turn has
 *   started on it, since the text is no longer there. It takes no turn.
 *
 * No model and no reads: pure code over what it is handed, logged like every node.
 */

const folded = (text) => String(text ?? "").replace(/\s+/g, " ").trim().toLowerCase();

/** @param {{ kind: "one" | "group", change: "edit" | "unsend", words?: string, earlier?: string }} input */
export async function editNode(input) {
  if (input.change === "unsend") return { to: "withdraw", why: "they took the text back" };
  if (typeof input.words !== "string" || input.words.trim() === "") return { to: "same", why: "an edit with no words" };
  if (typeof input.earlier === "string" && folded(input.earlier) === folded(input.words)) return { to: "same", why: "the words did not change" };
  return { to: "turn", why: typeof input.earlier === "string" && input.earlier.trim() !== "" ? "the words changed" : "the words before are not known" };
}
