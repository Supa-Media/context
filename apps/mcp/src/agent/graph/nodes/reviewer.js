/**
 * Reply reviewer node "reviewer" (`texConfig.json`): one Haiku review of a draft the Answer checks let through
 * (`replyJudge.js` `review`). Its notice sends the draft back through the `loop` wire to the front door, and the runner
 * brings the rewrite back through Answer checks first, as the wires run; `null` lets it go.
 */
export async function reviewerNode(input, io) {
  const t = io.ctx.turn;
  let stop = input;
  let reviews = 0;
  let sentBack = 0;
  while (stop.pending) {
    const waiting = t.drafts.waiting;
    reviews += 1;
    const notice = await t.answerChecks.review(waiting.draft, waiting.info);
    if (notice !== null && notice !== undefined) sentBack += 1;
    stop = await io.back.fd({ notice: notice === null || notice === undefined ? null : String(notice) });
  }
  return { ...stop, when: ["action"], reviews, sentBack };
}
