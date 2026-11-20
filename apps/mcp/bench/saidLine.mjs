/**
 * The line a texted turn leaves in a bench answer's record, and whether it is silent (out of `run.mjs`).
 */
import { sentPicturesLine } from "../../../packages/tex/gateway/agent/outgoingPictures.js";

/**
 * What the person got from one texted turn, as the record's line. Words are the words, with the pictures sent beside
 * them said as the chat's own record says them (`outgoingPictures.js` sentPicturesLine): a drawn card was invisible to
 * the judge, and an answer that was only a picture read as nothing. A turn with no words, no picture and no tapback is
 * one of three things, and the line says which (Training, 2026-11-18: such rows read "Tex: " with nothing, and nobody
 * could tell a chosen silence from a lost answer): Tex chose to say nothing (`quiet`, with its model's last words and
 * call), the Worker stopped the turn, or the gateway answered with nothing at all, which production's Worker retries
 * and then texts an apology for (`packages/tex/worker/reply.ts`), so it is a failed turn, never a reply.
 */
export function saidLine(turn) {
  const pictures = sentPicturesLine(Array.from({ length: Number(turn.pictures) || 0 }));
  if (turn.answer !== "" || pictures !== "") return [turn.answer, pictures].filter(Boolean).join("\n");
  if (typeof turn.react === "string") return "";
  if (turn.cancelled === true) return "(the turn was stopped before it answered)";
  if (turn.quiet === true) return `(stayed quiet${turn.quietWhy ? `: ${turn.quietWhy}` : ""})`;
  return `(no answer came back${turn.quietWhy ? `: ${turn.quietWhy}` : ""}; the texting Worker would retry, then text that something went wrong)`;
}

/**
 * Whether `saidLine` names a turn that texted nothing: the quiet or the stopped marker, with no words, picture or
 * tapback. WHY: a failed turn's apology line is not silent, it is what production would have texted.
 */
export function silentTurn(turn) {
  const noPictures = sentPicturesLine(Array.from({ length: Number(turn.pictures) || 0 })) === "";
  return turn.answer === "" && noPictures && typeof turn.react !== "string" && (turn.cancelled === true || turn.quiet === true);
}
