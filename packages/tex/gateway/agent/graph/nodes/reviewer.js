/**
 * Reply reviewer node "reviewer" (`texConfig.json`; Dev2, 2026-11-23, the no-shadow steps): one model read of a draft the
 * Claim checks let through (`replyJudge.js` `review`), over the Answer check's `uses` wire (`answerCheck -> reviewer`).
 * It reads only a job's report or a routine's text, when the setup turns the reviewer on (`runTheModel.js` `reviewedAs`),
 * as it did inside the Answer check before it had a step of its own.
 *
 * Its notice goes to the Answer check on the turn (`t.reviewNotice`), never into the chat's record: the row says only
 * whether it sent the draft back.
 */
export async function reviewerNode(_input, io) {
  const t = io.ctx.turn;
  const waiting = t.drafts?.waiting;
  t.reviewNotice = null;
  if (!waiting || typeof t.answerChecks?.review !== "function") return { when: ["pass"], back: false };
  const notice = await t.answerChecks.review(waiting.draft, waiting.info);
  t.reviewNotice = notice === null || notice === undefined ? null : String(notice);
  return { when: [t.reviewNotice === null ? "pass" : "back"], back: t.reviewNotice !== null };
}
