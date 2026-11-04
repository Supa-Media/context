/** Prepares what the turn records: usage, the turn log, the ledger turn id, the pictures to keep. One step of Tex's turn (`../texEntryPoint.js`). */

import { newLedger } from "../../privacy/egress.js";
import { callToolForSession } from "../../tools/session.js";
import { BUILTIN_PROVIDER } from "../builtin.js";
import { heardEntry, heardEvents } from "../heardWords.js";
import { DEFAULT_TIME_ZONE, readTimeZone } from "../localNow.js";
import { routineTimeZone } from "../routine.js";
import { keepTextedPictures } from "../textedPictures.js";
import { turnKind, turnReport, waitBefore } from "../turnLog.js";

// TEX ENTRY POINT: begin (every await below is a timed `tex` call: `texTiming.js`, checked by `scripts/tex-entry-check.mjs`)
export async function prepareBookkeeping(t) {
  const { body, builtinUsed, controlPlane, fresh, group, hot, job, logged, ownConversation, received, report, routine, runner, session, stages, store, tex, texting, web } = t;
  const started = Date.now();
  /*
    The built-in turn was counted when it was allowed; this adds what it spent.
    Counts only, best effort: a meter that could not be reached costs us a
    report, not the person their answer.
  */
  const meter = async (usage, failed, model = builtinUsed, whole = true) => {
    try {
      await tex.step("usage_record", () => controlPlane.recordBuiltinUsage(session.accessToken, session.workspaceId, {
        input: usage?.input ?? 0,
        output: usage?.output ?? 0,
        cacheRead: usage?.cacheRead ?? 0,
        cacheWrite: usage?.cacheWrite ?? 0,
        // The model that spent this: a planned turn reports each (`modelPlan.js`), its own counts on one.
        model: typeof model === "string" ? model : builtinUsed,
        decision: whole ? (web?.usage.decision ?? 0) + (usage?.decision ?? 0) : 0,
        failed,
        ms: whole ? Date.now() - started : 0, background: job !== null || report !== null, // a job's turn was never on the cap
      }));
    } catch {
      // See above.
    }
  };

  // Ours, not the person's: after the answer has gone (`deferred`).
  const afterAnswer = (work) => tex.after("supervision", work); // ours, not theirs: started once the response is ready (`deferred.js` `afterTurn`)

  /*
    Every turn goes to the turn log (`apps/convex/functions/agentTurns.ts`) and
    to this deployment's logs: where its time went, by model round and tool
    name, so the agent can be audited and made faster. Never text. Best effort
    like the meter: a log that could not be reached costs us a row, not the
    person their answer.
  */
  const logTurn = (outcome, model, timing, usage, parts = null) => {
    const report = turnReport({ provider: BUILTIN_PROVIDER, outcome, model, timing, usage, parts, kind: turnKind({ runner, job, group, texting }), ms: Date.now() - received, waitMs: waitBefore(body.arrivedAt, received) }); stages?.ran(report, timing?.trace);
    console.log(
      JSON.stringify({
        event: "agent_turn",
        workspace: session.workspaceId,
        grant: session.grantId, texting,
        ...report,
        trace: undefined,
        tools: report.trace.filter((entry) => entry.kind === "tool").map((entry) => entry.tool),
      }),
    );
    return async () => { // the row is sent once the response is ready (`afterAnswer`); the numbers are taken now
      try {
        await tex.step("turn_row", () => controlPlane.recordAgentTurn(session.accessToken, session.workspaceId, report));
      } catch {
        // See above.
      }
    };
  };

  // Their zone: a routine's own, else the one the texting Worker sent (`localNow.js`).
  const timeZone = runner ? routineTimeZone(routine.settings, body.routine.timeZone) : readTimeZone(body.timeZone) ?? DEFAULT_TIME_ZONE;
  const chatLog = texting || group !== null || ownConversation !== null ? store.ledger : null, ledgerTurn = typeof body.turn === "string" && body.turn !== "" ? body.turn : `gw${crypto.randomUUID().replace(/-/g, "").slice(0, 20)}`, ledgerAt = { turn: ledgerTurn, ownSlug: session.workspaceSlug }; tex.turn = ledgerTurn; if (stages) stages.turn = ledgerTurn; // every timing point carries it (`texTiming.js`, `turnStages.js`) // a turn the Worker named none for gets one, so its steps and reply are its own (`ledgerConversation.js`) // the chat's one record of everything (`ledger.js`); the pictures they texted are kept below under an egress ledger of its own
  // A voice message's words, heard this turn, written onto their own line of the chat's one record (`heardWords.js`), and onto the day the Worker's copy carries to the next turn.
  const heard = chatLog !== null && !runner && job === null ? heardEvents(fresh, logged?.covered) : [];
  if (heard.length > 0) { chatLog.write(heard.map(heardEntry)); hot?.restate?.(heard); }
  const unseen = { ...session, egress: { ...session.egress, ledger: newLedger() } };
  Object.defineProperty(unseen, "accessToken", { value: session.accessToken, enumerable: false }); // as `sessionForContext`
  // The pictures they texted, kept in a note of their own (`textedPictures.js`) as the turn is saved: the daily transcripts that kept them are no longer written.
  const keepPictures = texting && !runner ? () => keepTextedPictures((name, args) => callToolForSession({ name, arguments: args }, store, unseen), { now: received, timeZone, attachments: fresh }).catch(() => []) : () => null;
  Object.assign(t, { afterAnswer, chatLog, keepPictures, ledgerAt, ledgerTurn, logTurn, meter, timeZone });
}
// TEX ENTRY POINT: end
