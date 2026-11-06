/**
 * THE TEX ENTRY POINT, IN ONE FUNCTION (Dev, 2026-11-03: "a standalone single
 * file with one function, and have it have other functions called in there";
 * 2026-11-04: "why can't it be called texEntrypoint"). Its steps are timed by
 * `texTiming.js`.
 *
 * Every text to Tex, every group chat turn, job, report and routine run goes
 * through `texEntryPoint`, top to bottom. Each line is one step, in its own file
 * under `texEntryPoint/`, named for what it does. A step either hands the turn on
 * or answers it: the first answer is the response, and the steps after it do
 * not run.
 *
 * `t` is the turn: what was asked and what each step found, handed to the
 * next. Every wait inside a step is timed by name (`texTiming.js`), so a
 * turn's breakdown shows exactly where its time went.
 */

import { texEntry } from "./texTiming.js";
import * as steps from "./texEntryPoint/steps.js";

// TEX ENTRY POINT: begin (every await below is a timed `tex` call or one step of the turn: `texTiming.js`, checked by `scripts/tex-entry-check.mjs`)
export async function texEntryPoint(request, env, store, session, controlPlane, { progress = null, step = null, stages = null, tex = texEntry(env) }, outcome) {
  const t = { request, env, store, session, controlPlane, outcome, progress, step, stages, tex };

  const early =
    (await steps.readTheText(t)) ?? // who is asking, from which chat, and what
    (await steps.runARoutine(t)) ?? // a routine's run: paused, or nothing to do
    (await steps.checkTheQuestion(t)) ?? // the question, its files, what it replies to
    (await steps.settleAYesOrNo(t)) ?? // a texted yes or no to a waiting approval
    (await steps.watchWhatLeaves(t)) ?? // what this turn may read in and send out
    (await steps.checkItMayRun(t)) ?? // tools, history, and whether the model may run
    (await steps.readTheHistory(t)) ?? // voice notes, files, the chat so far
    (await steps.openTheWeb(t)) ?? // write tools and the browser
    (await steps.readTheSetup(t)) ?? // Tex's prompt, skills and models
    (await steps.prepareBookkeeping(t)) ?? // usage, the turn log, the ledger
    (await steps.prepareTheAnswer(t)); // side reads, answer checks, pictures
  if (early !== undefined) return early;

  try {
    return (
      (await steps.runTheModel(t)) ?? // the model, with every tool
      (await steps.finishARoutine(t)) ?? // a routine's run ends here
      (await steps.sendTheReply(t)) // the text that goes back
    );
  } catch (error) {
    return await steps.recoverFromFailure(t, error);
  }
}
// TEX ENTRY POINT: end
