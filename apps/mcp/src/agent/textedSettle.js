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

import { disarmRecords, listPending } from "../tools/approvals.js";
import { approvalVerdict, settleByText } from "./textedApprovals.js";
import { openTranscript } from "./transcript.js";
import { appendConversation, appendTold, readConversation, readTold } from "./conversation.js";

/**
 * What a texted turn is answered with before any model runs (`{ answer, … }`),
 * or what goes on to the model: `{ setAside }`, the asks this text moved on
 * from, which the model is told about (`setAsideLine`), or null.
 */
export async function settleTextedText(store, session, { dispatch, question, hasAttachments, now, timeZone, defer, conversation = null, told }) {
  // The Worker's fixed texts since the last turn go in the history first (`conversation.js` `TOLD`).
  if (conversation !== null) await appendTold(store, conversation, readTold(told));
  const verdict = hasAttachments ? null : approvalVerdict(question); // a yes with a photo is about the photo
  if (verdict !== null) {
    const settled = await settleByText(store, session, verdict, question);
    if (settled !== null) {
      // The yes and what it released go in today's transcript too (`transcript.js`), after the reply.
      await defer(openTranscript(dispatch, { now, timeZone, question }).finish({ answer: settled }));
      await remember(store, conversation, question, settled);
      return { answer: settled, provider: "gateway", model: "none", steps: [] };
    }
  }
  /*
    A text that goes to the model is not the answer to an ask made before it:
    the person has moved on, and a bare "yes" to the model's next question
    must not release a call raised two texts ago. Disarmed here, before the
    model runs, so an ask this turn raises is the only one a yes can reach.
  */
  const asked = await listPending(store, { userId: session.actorUserId, texting: true, now });
  if ((await disarmRecords(store, asked)) > 0) {
    // Still armed, a yes to the model's next question would release it.
    return {
      answer: "I couldn't clear what I asked you before. Reply NO to drop it, then send that again.",
      provider: "gateway",
      model: "none",
      steps: [],
    };
  }
  // Said to the model, or it goes on as if the ask still stood: "I'll cc him
  // once you confirm" over an email nothing would ever send (2026-10-19).
  return asked.length > 0 ? { setAside: asked.map(({ record }) => ({ tool: record.tool, summary: record.summary })) } : null;
}

/** The model's note that what it asked before was set aside by this text, or "". */
export function setAsideLine(setAside) {
  if (!Array.isArray(setAside) || setAside.length === 0) return "";
  const each = setAside.map((entry) => `"${String(entry.summary ?? entry.tool).slice(0, 200)}"`).join(", ");
  return (
    `(Context: you had asked the person to say yes to ${each}. This text is not that yes, so nothing was sent or changed and it no longer waits for a texted yes. ` +
    "If they still want it, with any change this text asks for, make the call again with the change; they are asked again. Never say it is still waiting.)"
  );
}

/**
 * The yes and what it released go in the conversation too, as any answered
 * text does (`route.js`). Left out, the next turn never saw them: it said a
 * bug report filed on that yes was "still waiting", and filed it again
 * (@context-lc tex-bugs, 2026-10-18 and 2026-10-19). Best effort, as there.
 */
async function remember(store, conversation, question, answer) {
  if (conversation === null) return;
  try {
    await appendConversation(store, conversation, await readConversation(store, conversation), question, answer, { theirs: true });
  } catch {
    // The reply is still owed; a history that failed to save costs the next turn some context.
  }
}
