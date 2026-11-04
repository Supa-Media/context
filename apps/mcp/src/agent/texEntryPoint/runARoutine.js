/** A routine's run: reloads the routine, and stops here when it is paused or its job needs no model. One step of Tex's turn (`../texEntryPoint.js`). */

import { json } from "../../http/responses.js";
import { deferred } from "../deferred.js";
import { RoutineRefusal, keepRun, loadRoutine, readRuns, routinePathFrom, routineRunQuestion, stopRoutine } from "../routine.js";
import { NO_MODEL, deliverSupervision, prepareSupervision } from "../supervise.js";

// TEX ENTRY POINT: begin (every await below is a timed `tex` call: `texTiming.js`, checked by `scripts/tex-entry-check.mjs`)
export async function runARoutine(t) {
  let { body, dispatch, question, routine, runner, runs, store, supervision, tex } = t;
  if (runner) {
    try {
      routine = await tex.step("load_routine", () => loadRoutine(dispatch, routinePathFrom(body.routine)));
    } catch (error) {
      if (!(error instanceof RoutineRefusal)) throw error;
      return json({ error: error.code, error_description: error.message }, error.code === "routine_gone" ? 404 : 400);
    }
    if (routine.settings.paused) return json({ outcome: "paused", skipped: true });
    runs = await tex.step("read_runs", () => readRuns(store, routine.path));
    question = await tex.step("routine_question", () => routineRunQuestion(store, routine, runs, body.routine.timeZone));
    // A job going well, done or gone costs no model call (`supervise.js`); done or gone stops its supervisor.
    supervision = await tex.step("prepare_supervision", () => prepareSupervision(dispatch, routine, { runs, handle: store.contexts.find((c) => c.current)?.name }));
    if (supervision?.skip) {
      const { skip: outcome, answer = "" } = supervision;
      await tex.step("keep_run", () => keepRun(store, routine, runs, outcome, answer || NO_MODEL));
      if (outcome === "finished") await tex.step("stop_routine", () => stopRoutine(dispatch, routine.path));
      if (supervision.task) await tex.step("deliver_supervision", () => deliverSupervision(store, dispatch, supervision, { outcome, text: answer }, (work) => deferred(store, work)));
      return json({ outcome, answer, skipped: answer === "", send: routine.settings.send, to: routine.settings.to });
    }
    if (supervision !== null) question = supervision.question;
  }
  Object.assign(t, { question, routine, runs, supervision });
}
// TEX ENTRY POINT: end
