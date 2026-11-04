/** Checks the question and what came with it: the files, the message it replies to, the tapbacks. One step of Tex's turn (`../texEntryPoint.js`). */

import { json } from "../../http/responses.js";
import { turnAttachments } from "../attachments.js";
import { quotedOf, reactedOf } from "../quoted.js";
import { steerFor } from "../steer.js";
import { TEXTS_CLIENT_ID } from "./clients.js";
import { MAX_QUESTION_LENGTH } from "../turn.js";

// TEX ENTRY POINT: begin (every await below is a timed `tex` call: `texTiming.js`, checked by `scripts/tex-entry-check.mjs`)
export async function checkTheQuestion(t) {
  const { body, chatTurn, group, job, outcome, question, runner, session, store } = t;
  const { attachments: sent, refusal } = turnAttachments(body.attachments, runner); if (refusal) return json({ error: "invalid_request", error_description: refusal }, 400); // what came with the question (`attachments.js`); a routine's run has none
  if (question.length === 0 && sent.length === 0) {
    return json({ error: "invalid_request", error_description: "Ask a question." }, 400);
  }
  if (question.length > MAX_QUESTION_LENGTH) {
    return json({ error: "invalid_request", error_description: `A question is at most ${MAX_QUESTION_LENGTH} characters.` }, 400);
  }
  /*
    The words an inline reply answers (`quoted.js`). They are somebody else's
    — the message picked may be one Tex sent, carrying whatever Tex read — so
    they never join `question`, which is what the browser's addresses, the
    outgoing pictures, the sharing judge and the Mail checker all vouch from.
    Only `runTurn` sees the two together, and the quote is marked there.
  */
  const quoted = quotedOf(session.actorClientId === TEXTS_CLIENT_ID || group !== null ? body : null); session.ledgerWork = chatTurn ? { turn: body.turn, from: job?.title ?? (group !== null ? "the group" : "your texts") } : null; // what the email gate's ledger lines say they came from (`workEntries.js`)
  const reacted = reactedOf(session.actorClientId === TEXTS_CLIENT_ID ? body : null); // tapbacks since their last text
  const steer = steerFor(store, session, body); // texts sent while it works (`steer.js`)
  if (steer !== null) outcome.turn = body.turn; // only a texted turn the Worker named is recorded (`loggedTurn.js`)
  Object.assign(t, { quoted, reacted, sent, steer });
}
// TEX ENTRY POINT: end
