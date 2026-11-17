/**
 * Answer check node "answerCheck" (`texConfig.json`; Dev2, 2026-11-16: Answer checks and the Reply reviewer, merged):
 * every draft the Front door would send is checked here before it goes. Code first (`doItChecks.js`, `claimCheck.js`,
 * `replyJudge.js` `codeCheck`) catches what it can prove wrong; a draft it lets through that is a job's report or a
 * routine's text (the turn's kind, `runTheModel.js` `reviewedAs`, set only when the setup turns the reviewer on) is then
 * read once by the model (`replyJudge.js` `review`). Either sends it back with its notice through the `loop` wire to
 * the Front door (`io.back.fd`), which comes back with the rewrite; `null` lets it go, and the Front door goes on.
 *
 * The wire's rounds are the send-back budget. Letting a draft go is a release and spends none. Once the budget is
 * spent, a draft that would be sent back goes on as it is, and the output says `spent` (Dev2, 2026-11-17: a job whose
 * part got a third notice crashed and lost its finished answer ten times running).
 */
export async function answerCheckNode(input, io) {
  const t = io.ctx.turn;
  const back = io.back.fd;
  let stop = input;
  let sentBack = 0;
  let reviews = 0;
  let spent = false;
  const letGo = () => back({ notice: null }, { release: true });
  while (stop.pending) {
    const waiting = t.drafts.waiting;
    const { notice, review } = await t.answerChecks.code(waiting.draft, waiting.info);
    if (notice !== null && notice !== undefined) {
      if (back.left() === 0) {
        spent = true;
        stop = await letGo();
        continue;
      }
      sentBack += 1;
      stop = await back({ notice: String(notice) });
      continue;
    }
    if (review && t.reviewedAs) {
      reviews += 1;
      const said = await t.answerChecks.review(waiting.draft, waiting.info);
      if (said !== null && said !== undefined && back.left() > 0) {
        sentBack += 1;
        stop = await back({ notice: String(said) });
      } else {
        if (said !== null && said !== undefined) spent = true;
        stop = await letGo();
      }
      continue;
    }
    stop = await letGo(); // let go: the front door may still write it again with a text that came in
  }
  return { ...stop, when: [stop.ended ? "ended" : "done"], sentBack, reviews, ...(spent ? { spent: true } : {}) };
}
