/**
 * Self-review node "selfreview" (`texConfig.json`): "fix this" or frustration scores the conversation, after a reply
 * went, on Text them's `background` wire (`selfReview.js` `reviewAfterTurn`). Quiet ends do it from the Worker.
 */
import { reviewAfterTurn } from "../../selfReview.js";

export async function selfreviewNode(_input, io) {
  const { env, store, session, controlPlane, question, group, conversation } = io.ctx.turn;
  const filed = await reviewAfterTurn({ env, store, session, controlPlane, question, group, saved: group !== null || conversation !== null });
  return { filed: filed != null };
}
