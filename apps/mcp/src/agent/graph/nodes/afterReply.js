/**
 * After the reply node "afterReply" (`texConfig.json`; Dev2, 2026-11-16: the Classifier and Self-review, merged): on
 * Text them's `background` wire, so nobody waits for it (Dev2, 2026-11-12: "Never wait for it"). When the turn read the
 * chat's threads it files the new text into them (`conversationThreads.js`, on the sort `threadedTurn.js` read); when a
 * reply went, "fix this" or frustration scores the conversation and files a review (`selfReview.js`). Text them says
 * which of the two this turn calls for (`t.sentAs`); one that fails never stops the other.
 */
import { reviewAfterTurn } from "../../selfReview.js";

export async function afterReplyNode(_input, io) {
  const t = io.ctx.turn;
  const out = {};
  const [filed, reviewed] = await Promise.allSettled([
    typeof t.threadsSort === "function" ? t.threadsSort() : Promise.resolve(null),
    t.sentAs === "sent" ? reviewAfterTurn({ env: t.env, store: t.store, session: t.session, controlPlane: t.controlPlane, question: t.question, group: t.group, saved: t.group !== null || t.conversation !== null }) : Promise.resolve(undefined),
  ]);
  if (filed.status === "fulfilled" && filed.value !== null) out.filed = Array.isArray(filed.value) ? filed.value.length : 0;
  if (reviewed.status === "fulfilled" && reviewed.value !== undefined) out.reviewed = reviewed.value != null;
  const failed = [filed, reviewed].find((r) => r.status === "rejected");
  if (failed) throw failed.reason;
  return out;
}
