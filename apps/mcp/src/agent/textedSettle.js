/**
 * A TEXTED YES OR NO SETTLES A PENDING APPROVAL BEFORE ANY MODEL RUNS.
 *
 * The egress gate (`privacy/egress.js`) held a call nobody can take back —
 * an email, a calendar change, a handle claim, a vault key's first use —
 * until the person says so, and the person says so here: a text that is
 * nothing but yes or no, from the linked phone, is matched by
 * `textedApprovals.js` and never shown to a model. The call then runs through
 * the same dispatcher under this session, marked approved, and the result is
 * the reply.
 *
 * Only the texting client reaches this: a routine's run has no person on the
 * line, and the app approves through `/approvals`.
 *
 * The words judged are the person's own, never the message an inline reply
 * answers (`quoted.js`), so a quoted "yes" settles nothing.
 */

import { disarmTexting } from "../tools/approvals.js";
import { approvalVerdict, settleByText } from "./textedApprovals.js";
import { openTranscript } from "./transcript.js";

/** What a texted turn is answered with before any model runs, or null to go on to one. */
export async function settleTextedText(store, session, { dispatch, question, hasAttachments, now, timeZone, defer }) {
  const verdict = hasAttachments ? null : approvalVerdict(question); // a yes with a photo is about the photo
  if (verdict !== null) {
    const settled = await settleByText(store, session, verdict, question);
    if (settled !== null) {
      // The yes and what it released go in today's transcript too (`transcript.js`), after the reply.
      await defer(openTranscript(dispatch, { now, timeZone, question }).finish({ answer: settled }));
      return { answer: settled, provider: "gateway", model: "none", steps: [] };
    }
  }
  /*
    A text that goes to the model is not the answer to an ask made before it:
    the person has moved on, and a bare "yes" to the model's next question
    must not release a call raised two texts ago. Disarmed here, before the
    model runs, so an ask this turn raises is the only one a yes can reach.
  */
  if ((await disarmTexting(store, { userId: session.actorUserId })) > 0) {
    // Still armed, a yes to the model's next question would release it.
    return {
      answer: "I couldn't clear what I asked you before. Reply NO to drop it, then send that again.",
      provider: "gateway",
      model: "none",
      steps: [],
    };
  }
  return null;
}
