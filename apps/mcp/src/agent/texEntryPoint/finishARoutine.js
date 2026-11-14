/** A routine's run ends here: its outcome is kept, and it stops or finishes itself when due. One step of Tex's turn (`../texEntryPoint.js`). */

import { json } from "../../http/responses.js";
import { disarmTexting } from "../../tools/approvals.js";
import { rememberRoutineText } from "../conversation.js";
import { wordsEntry } from "../ledger.js";
import { texVersion } from "../texVersion.js";
import { turnTiming } from "../turnTiming.js";
import { finishOnce, keepRun, routineTimeZone, runOutcome, stopRoutine } from "../routine.js";
import { deliverSupervision } from "../supervise.js";

/** A run's time, code and timing for replay (Dev2, 2026-11-14), as a texted reply keeps them (`sendTheReply.js`). */
function runFacts(env, production, tex, turn, received) {
  const version = texVersion(env, production);
  const replyMs = Number.isFinite(received) ? Date.now() - received : null;
  return {
    ...(replyMs === null ? {} : { ms: replyMs }),
    ...(version === null ? {} : { version }),
    ...(replyMs === null ? {} : { timing: turnTiming({ steps: tex.steps, trace: turn.timing?.trace, replyMs }) }),
  };
}

// TEX ENTRY POINT: begin (every await below is a timed `tex` call: `texTiming.js`, checked by `scripts/tex-entry-check.mjs`)
export async function finishARoutine(t) {
  const { afterAnswer, body, chatLog, dispatch, env, ledger, ledgerTurn, production, received, routine, runner, runs, session, store, supervision, tex, turn } = t;
  if (runner) {
    const ran = turn.exhausted ? { outcome: "failed", text: "" } : runOutcome(turn.answer, { routine, runs });
    chatLog?.write(wordsEntry("note", ran.text, { turn: ledgerTurn, routine: routine.path, outcome: ran.outcome, ...runFacts(env, production, tex, turn, received), ...(ledger.untrusted === true ? { tainted: true } : {}), ...(Array.isArray(routine.settings?.to) && routine.settings.to.length > 0 ? { others: true } : {}) })); await tex.after("ledger", () => chatLog?.flush());
    await tex.step("keep_run", () => keepRun(store, routine, runs, ran.outcome, ran.text));
    /*
      A routine that texts the person is a message they may answer with a bare
      "ok" or "yes", and that answer is to it, not to an ask raised before it.
    */
    if (ran.text && routine.settings.send !== "note") {
      await tex.step("disarm", () => disarmTexting(store, { userId: session.actorUserId }));
      await tex.step("remember_routine_text", () => rememberRoutineText(store, routine, ran.text, ledger.untrusted));
    }
    // A routine whose `until:` came true stops itself, recoverably.
    if (ran.outcome === "finished" && routine.cadence.unit !== "once") {
      await tex.step("stop_routine", () => stopRoutine(dispatch, routine.path));
    }
    // A one-off has run: it stays where it is, marked done (`finishOnce`).
    if (supervision !== null) await tex.step("deliver_supervision", () => deliverSupervision(store, dispatch, supervision, ran, afterAnswer));
    if (routine.cadence.unit === "once" && ran.outcome !== "failed") {
      await tex.step("finish_once", () => finishOnce(dispatch, routine.path, {
        now: Date.now(),
        timeZone: routineTimeZone(routine.settings, body.routine.timeZone),
      }));
    }
    return json({
      outcome: ran.outcome,
      answer: ran.text,
      skipped: ran.outcome !== "answered" && ran.outcome !== "finished",
      send: routine.settings.send,
      to: routine.settings.to,
      provider: turn.provider,
      model: turn.model,
      steps: turn.steps,
    });
  }
}
// TEX ENTRY POINT: end
