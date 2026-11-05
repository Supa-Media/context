/** Starts reading the tools and the history, and checks the model may run here (beside the model on a lean chat). One step of Tex's turn (`../texEntryPoint.js`). */

import { json } from "../../http/responses.js";
import { DEFAULT_TIME_ZONE, readTimeZone } from "../localNow.js";
import { turnReads } from "../loggedTurn.js";
import { keepRun } from "../routine.js";
import { grantedToolsFor } from "../sixTools.js";
import { NO_MODEL_HERE } from "./clients.js";
import { AgentRefusal, openProvider } from "../turn.js";

// TEX ENTRY POINT: begin (every await below is a timed `tex` call: `texTiming.js`, checked by `scripts/tex-entry-check.mjs`)
export async function checkItMayRun(t) {
  const { body, controlPlane, dispatch, env, group, hot, job, outcome, report, routine, runner, runs, session, stages, store, tex } = t;
  const offeredRead = tex.ahead("tools_list", () => grantedToolsFor(session, store)), historyRead = tex.ahead("history", () => turnReads(store, session, body, { runner, group, dispatch, warm: hot, timeZone: readTimeZone(body.timeZone) ?? DEFAULT_TIME_ZONE, job: job !== null, time: { memory: (run) => tex.ahead("history_memory", run), ledger: (run) => tex.ahead("history_ledger", run), log: (run) => tex.ahead("history_log", run), groupReads: (run) => tex.ahead("history_group_notes", run), groupLedger: (run) => tex.ahead("history_group_ledger", run) } })); // beside the provider check (`ahead`), a group's memory too now that the egress ledger is set above (2026-10-31)
  const allowedRead = tex.ahead("allowed", () => openProvider(controlPlane, session, body.provider, env, { background: job !== null || report !== null })); // a job's part or report: not on the daily cap (Dev2, 2026-10-31)
  const refused = async (error) => { // the turn's answer when the model may not run here (beside the model on a chat's text: `tex.lean`)
    outcome.turn = undefined; // no model ran
    if (runner) await tex.step("keep_run", () => keepRun(store, routine, runs, error instanceof AgentRefusal ? error.code : "failed", ""));
    if (error instanceof AgentRefusal && error.code === "daily_limit") {
      return json(
        { error: "daily_limit", error_description: "That's all the questions for today. Ask me again tomorrow." },
        429,
      );
    }
    if (error instanceof AgentRefusal) return json({ error: error.code, error_description: NO_MODEL_HERE }, 409);
    // A control plane that could not be reached is not a refusal, and telling somebody
    // the assistant is not theirs when it is is worse than telling them nothing.
    return json({ error: "model_unavailable" }, 503);
  };
  if (!tex.lean) {
    const error = await tex.wait("allowed", allowedRead).then(() => null, (thrown) => thrown); stages?.mark("provider");
    if (error !== null) return await tex.step("refused", () => refused(error));
  }
  Object.assign(t, { allowedRead, historyRead, offeredRead, refused });
}
// TEX ENTRY POINT: end
