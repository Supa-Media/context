/** Reads the request: who is asking, from which chat, and what they asked. One step of Tex's turn (`../texEntryPoint.js`). */

import { actorFor, contextsFor } from "../../context/identity.js";
import { json } from "../../http/responses.js";
import { callToolForSession } from "../../tools/session.js";
import { jobOf, jobReportOf, jobReportQuestion } from "../background.js";
import { mailDomainOf } from "../chatHome.js";
import { groupOf, isGroupSession } from "../groupTurn.js";
import { jobTagged } from "../ledger.js";
import { readProductionSetup } from "../production.js";
import { ROUTINES_CLIENT_ID } from "../routine.js";
import { TEXTS_CLIENT_ID } from "./clients.js";
import { turnKind } from "../turnLog.js";
import { vaultSavedQuestion } from "../vaultSaved.js";
import { warmTurn } from "../warmCopy.js";
import { chatLedger, reportEntry } from "../workEntries.js";

// TEX ENTRY POINT: begin (every await below is a timed `tex` call: `texTiming.js`, checked by `scripts/tex-entry-check.mjs`)
export async function readTheText(t) {
  const { env, request, session, store, tex } = t;
  const received = Date.now();
  let body;
  try {
    body = await tex.step("read_request", () => request.json());
  } catch {
    return json({ error: "invalid_request", error_description: "Expected a JSON body." }, 400);
  }
  if (!body || typeof body !== "object" || Array.isArray(body)) {
    return json({ error: "invalid_request", error_description: "Expected a JSON body." }, 400);
  }

  /*
    A routine's connection runs routines and nothing else, and nothing else runs
    one: both decided by the grant's client, never by the body. A routine grant
    that answered free questions would be a second texting grant nobody linked.
  */
  const runner = session.actorClientId === ROUTINES_CLIENT_ID;
  if (runner !== (body.routine !== undefined)) {
    return json(
      {
        error: "invalid_request",
        error_description: runner ? "This connection only runs routines." : "Only a routine's own connection runs one.",
      },
      runner ? 400 : 403,
    );
  }

  // A group chat's turn names its chat (`groupTurn.js`); decided by the grant, never by the body.
  const group = isGroupSession(session) ? groupOf(body, session) : null;
  if (isGroupSession(session) && group === null) return json({ error: "invalid_request", error_description: "A group chat's turn names its chat." }, 400);
  if (group !== null) group.mailDomain = mailDomainOf(env); // the chat's own address is on this deployment's apex (`chatHome.js` `chatMailAddress`)
  // Background jobs (`background.js`): a texted turn may start them, and a job's own turn names itself.
  const chatTurn = !runner && (session.actorClientId === TEXTS_CLIENT_ID || group !== null);
  const job = chatTurn ? jobOf(body.job) : null, report = jobReportOf(body, { chatTurn, job }); // and a job reporting to the chat's own turn, its coordinator (`jobReport.js`)

  store.actor = actorFor(session); tex.kind = turnKind({ runner, job, group, texting: session.actorClientId === TEXTS_CLIENT_ID }); // which steps are off (`texTiming.js`)
  // Note mail (`tools/notes/mail.js`): a job's turn joins mail as the job, so mail reaches it at once; only Tex's own turn may interrupt one.
  store.mailTurn = job !== null ? { role: "job", job: job.id } : chatTurn || runner ? { role: "tex" } : null;
  store.contexts = contextsFor(session); store.ledger = chatTurn || runner ? chatLedger(store, session) : null; if (job !== null && store.ledger) store.ledger = session.ledger = jobTagged(store.ledger, job); // a job's turn marks all it writes as the job's (`ledger.js` `jobTagged`) // a texted, group or routine turn's chat ledger, which the email gate and a settled ask write to (`workEntries.js`)
  if (report !== null && store.ledger) { try { store.ledger.write(reportEntry(report, { turn: body.turn })); } catch { /* the history's line never costs the turn */ } } // what this turn was handed, before the model reads it (`workEntries.js` `reportEntry`)
  const hot = warmTurn(env, session, body, { eligible: session.actorClientId === TEXTS_CLIENT_ID && group === null && job === null && !runner, logEligible: group !== null && job === null && !runner, now: received }); // what the Worker kept of the last turn's reads, never the history or About me (`warmCopy.js`)
  const setupRead = readProductionSetup(store, session, { texting: session.actorClientId === TEXTS_CLIENT_ID || runner || group !== null, warm: hot.setup }); // read beside what comes before it, not after

  // The routine is re-read now, before any model is opened: a paused or vanished one costs no turn.
  // A tool call through the client's own dispatcher, under this session.
  const dispatch = (name, args) => callToolForSession({ name, arguments: args }, store, session);
  let routine = null;
  let runs = [];
  // A delegated job's supervisor (`supervise.js`): what this run is for, decided before any model.
  let supervision = null;
  // A saved login's turn (`vaultSaved.js`) and a job's report are asked the gateway's own line, never the body's.
  let question = vaultSavedQuestion(body, { texting: session.actorClientId === TEXTS_CLIENT_ID && group === null, job }) ?? (report !== null ? jobReportQuestion(report) : null) ?? (typeof body.question === "string" ? body.question.trim() : "");
  Object.assign(t, { body, chatTurn, dispatch, group, hot, job, question, received, report, routine, runner, runs, setupRead, supervision });
}
// TEX ENTRY POINT: end
