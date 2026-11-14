/**
 * Answer checks node "checks" (`texConfig.json`): the code checks every draft gets before it goes (`doItChecks.js`,
 * `claimCheck.js`, `replyJudge.js` `codeCheck`). A draft they send back goes back to the front door through the `loop`
 * wire, and comes back rewritten; one the Reply reviewer reads next is tagged `action`, which the wire to it fires on;
 * any other is let go, and the front door goes on to its reply.
 */
export async function checksNode(input, io) {
  const t = io.ctx.turn;
  let stop = input;
  let sentBack = 0;
  while (stop.pending) {
    const waiting = t.drafts.waiting;
    const { notice, review } = await t.answerChecks.code(waiting.draft, waiting.info);
    if (notice !== null && notice !== undefined) {
      sentBack += 1;
      stop = await io.back.fd({ notice: String(notice) });
      continue;
    }
    if (review) return { ...stop, when: ["action"], sentBack };
    stop = await io.back.fd({ notice: null }); // let go: the front door may still write it again with a text that came in
  }
  return { ...stop, when: [stop.ended ? "ended" : "done"], sentBack };
}
