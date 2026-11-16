/**
 * Answer check node "answerCheck" (`texConfig.json`; Dev2, 2026-11-16: Answer checks and the Reply reviewer, merged):
 * every draft the Front door would send is checked here before it goes. Code first (`doItChecks.js`, `claimCheck.js`,
 * `replyJudge.js` `codeCheck`) catches what it can prove wrong; a draft it lets through that is a job's report or a
 * routine's text (the turn's kind, `runTheModel.js` `reviewedAs`, set only when the setup turns the reviewer on) is then
 * read once by the model (`replyJudge.js` `review`). Either sends it back with its notice through the `loop` wire to
 * the Front door (`io.back.fd`), which comes back with the rewrite; `null` lets it go, and the Front door goes on.
 */
export async function answerCheckNode(input, io) {
  const t = io.ctx.turn;
  let stop = input;
  let sentBack = 0;
  let reviews = 0;
  while (stop.pending) {
    const waiting = t.drafts.waiting;
    const { notice, review } = await t.answerChecks.code(waiting.draft, waiting.info);
    if (notice !== null && notice !== undefined) {
      sentBack += 1;
      stop = await io.back.fd({ notice: String(notice) });
      continue;
    }
    if (review && t.reviewedAs) {
      reviews += 1;
      const said = await t.answerChecks.review(waiting.draft, waiting.info);
      if (said !== null && said !== undefined) sentBack += 1;
      stop = await io.back.fd({ notice: said === null || said === undefined ? null : String(said) });
      continue;
    }
    stop = await io.back.fd({ notice: null }); // let go: the front door may still write it again with a text that came in
  }
  return { ...stop, when: [stop.ended ? "ended" : "done"], sentBack, reviews };
}
