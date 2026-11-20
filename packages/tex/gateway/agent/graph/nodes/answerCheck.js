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
 * part got a third notice crashed and lost its finished answer ten times running). When the config wires
 * `answerCheck -> handoff`, such a draft hands the job to a background worker instead (`handoff.js`), and the output
 * logs `handedOff`.
 *
 * When the config wires `answerCheck -> askGate`, a draft the code checks let through is read by the lookup ladder's
 * Before-asking step first (`askGate.js`): a draft that asks them a fact Tex could find goes back with what the quick
 * rungs found, or to a background job for the slow ones (`askGate -> handoff`). Unwired, nothing changes.
 */
export async function answerCheckNode(input, io) {
  const t = io.ctx.turn;
  const back = io.back.fd;
  let stop = input;
  let sentBack = 0;
  let reviews = 0;
  let spent = false;
  let handedOff = false;
  let ladders = 0;
  const letGo = () => back({ notice: null }, { release: true });
  // The budget is spent and the draft would be sent back: when the config wires the Hand-off node, the job goes to a
  // background worker instead of the draft going as it is (`../../handoff.js`); the Front door ends on its start line.
  const spentOn = async (waiting, notice) => {
    spent = true;
    const ack = typeof t.handoff === "function" ? await t.handoff(waiting.draft, waiting.info, notice) : null;
    if (typeof ack !== "string" || ack === "") return letGo();
    handedOff = true;
    t.handedOff = ack; // the Front door's model loop ends on it (`turn.js`), and the wire carries no notice
    return letGo();
  };
  while (stop.pending) {
    const waiting = t.drafts.waiting;
    const { notice, review } = await t.answerChecks.code(waiting.draft, waiting.info);
    if (notice !== null && notice !== undefined) {
      if (back.left() === 0) {
        stop = await spentOn(waiting, String(notice));
        continue;
      }
      sentBack += 1;
      stop = await back({ notice: String(notice) });
      continue;
    }
    const ladder = await askBefore(io, t, waiting);
    if (ladder !== null && (ladder.to === "back" || ladder.to === "job")) {
      ladders += 1;
      // The send-back runs only over its own wire, `askGate -> fd` (loop): unwired, the draft is not sent back.
      if (ladder.to === "back" && t.ladderBack === true && back.left() > 0) {
        sentBack += 1;
        stop = await back({ notice: String(ladder.notice) });
        continue;
      }
      // The quick rungs are spent, or found nothing: the slow ones go to a job when the config wires `askGate -> handoff`.
      const ack = typeof t.ladderHandOff === "function" ? await t.ladderHandOff(waiting.draft, waiting.info, String(ladder.why ?? "nothing quick found it")) : null;
      if (typeof ack === "string" && ack !== "") {
        handedOff = true;
        t.handedOff = ack;
        stop = await letGo();
        continue;
      }
    }
    if (review && t.reviewedAs) {
      reviews += 1;
      const said = await t.answerChecks.review(waiting.draft, waiting.info);
      if (said !== null && said !== undefined && back.left() > 0) {
        sentBack += 1;
        stop = await back({ notice: String(said) });
      } else {
        stop = said !== null && said !== undefined ? await spentOn(waiting, String(said)) : await letGo();
      }
      continue;
    }
    stop = await letGo(); // let go: the front door may still write it again with a text that came in
  }
  return { ...stop, when: [stop.ended ? "ended" : "done"], sentBack, reviews, ...(spent ? { spent: true } : {}), ...(handedOff || ladders > 0 ? { log: { ...(handedOff ? { handedOff: true } : {}), ...(ladders > 0 ? { ladders } : {}) } } : {}) };
}

/**
 * The lookup ladder (`../../lookupLadder.js`), when the config wires `answerCheck -> askGate` and the turn is a texted
 * one (`runTheModel.js` sets `t.ladderOn`): the Before-asking step's read of a draft the code checks let through, once
 * per draft. Null when it is not wired or it failed: the draft goes on as it would.
 */
async function askBefore(io, t, waiting) {
  if (t.ladderOn !== true || waiting?.draft === undefined || waiting.draft === t.ladderLast) return null;
  t.ladderLast = waiting.draft;
  try {
    if (!("askGate" in io.use)) return null;
    return await io.use.askGate({ ask: String(t.question ?? ""), draft: String(waiting.draft ?? "") });
  } catch {
    return null;
  }
}
