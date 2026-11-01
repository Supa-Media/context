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
 * Only the texting client and a group chat's Tex reach this: a routine's run
 * has no person on the line, and the app approves through `/approvals`. In a
 * group the yes is the tagger's own: a pending call is theirs alone
 * (`approvals.js` lists by person), so somebody else's "yes" in the chat
 * releases nothing of theirs.
 *
 * The words judged are the person's own, never the message an inline reply
 * answers (`quoted.js`), so a quoted "yes" settles nothing.
 */

import { disarmRecords, listPending } from "../tools/approvals.js";
import { askOvertaken, droppedLine } from "./askOvertaken.js";
import { approvalVerdict, settleByText } from "./textedApprovals.js";
import { settlePayByText } from "./textedPay.js";
import { openTranscript } from "./transcript.js";
import { appendConversation, appendTold, readTold } from "./conversation.js";

/**
 * What a texted turn is answered with before any model runs (`{ answer, … }`),
 * or what goes on to the model: `{ setAside }`, the asks still waiting for
 * their yes, which the model is told about (`setAsideLine`), or null.
 */
export async function settleTextedText(store, session, { dispatch, question, hasAttachments, now, timeZone, defer, conversation = null, told, keep = null, thumbsUp = false }) {
  // The Worker's fixed texts since the last turn go in the history first (`conversation.js` `TOLD`).
  if (conversation !== null) await appendTold(store, conversation, readTold(told));
  const verdict = hasAttachments ? null : approvalVerdict(question); // a yes with a photo is about the photo
  /*
    An ask Tex has since texted something else after by itself (a routine, a
    check-in) is no longer what a yes or no answers: it is dropped, nothing is
    sent, and the model answers the text (`askOvertaken.js`). A 👍 on the
    ask's own words was put on it, so it still counts (`thumbsUpIsYes`).
  */
  if (!thumbsUp) {
    const armed = await listPending(store, { userId: session.actorUserId, texting: true, now });
    if (await askOvertaken(store, conversation, armed.map(({ record }) => record))) {
      // One that cannot be dropped stays armed, but this same check keeps every later bare yes off it too.
      const stuck = await disarmRecords(store, armed);
      console.log(JSON.stringify({ event: "ask_overtaken", asks: armed.length, stuck }));
      return { dropped: armed.map(({ record }) => ({ tool: record.tool, summary: record.summary })) };
    }
  }
  // A yes to a card's payment goes on to the model, which fills the card (`textedPay.js`).
  const pay = await settlePayByText(store, session, verdict, question, now);
  if (verdict !== null && pay.allowed.length === 0) {
    const released = await settleByText(store, session, verdict);
    const settled = [...pay.replies, ...(released === null ? [] : [released])].join("\n") || null;
    if (settled !== null) {
      // The yes and what it released go in today's transcript too (`transcript.js`), after the reply.
      await defer(openTranscript(dispatch, { now, timeZone, question }).finish({ answer: settled }));
      await remember(store, conversation, question, settled);
      // A group chat keeps it in its own memory instead (`groupTurn.js`).
      if (keep !== null) await keep(question, settled);
      return { answer: settled, provider: "gateway", model: "none", steps: [] };
    }
  }
  /*
    A text that goes to the model leaves an ask standing (Dev2, 2026-10-22,
    asked: "one sec" used to drop the email, and the yes after it did
    nothing). It stops listening only when Tex's own answer asks something
    else, so a bare "yes" is never taken as the yes to an older ask
    (`textedAsk`), when a newer ask replaces it (`armForText`), on a no, or
    when it expires. The model is told it still stands, so it neither asks
    again nor says it was dropped.
  */
  const asked = await listPending(store, { userId: session.actorUserId, texting: true, now });
  // `id` and `args` let a correction drop exactly these (`claimCheck.js` rule 6); only `summary` is ever shown.
  const setAside = asked.length > 0 ? { setAside: asked.map(({ record }) => ({ id: record.id, tool: record.tool, summary: record.summary, args: record.args })) } : null;
  return pay.allowed.length > 0 ? { ...setAside, allowed: pay.allowed } : setAside;
}

/** The model's note that what it asked before still waits for their yes, or was dropped (`droppedLine`), or "". */
export function setAsideLine(setAside, dropped = []) {
  if (!Array.isArray(setAside) || setAside.length === 0) return droppedLine(dropped);
  const each = setAside.map((entry) => `"${String(entry.summary ?? entry.tool).slice(0, 200)}"`).join(", ");
  return (
    `(Context: you asked the person to give a 👍 or say yes to ${each}, and it still waits: their yes or 👍 makes it, nothing else is needed. ` +
    "This text is not that yes. Answer it; don't show it again or ask for the yes again. Only if this text changes what it should be, " +
    "or says what is wrong with it (\"they're both still at 6:30\"), make the call again with that change, and they are asked about the new one instead; " +
    "the same change again is never shown, and an apology is no answer.)"
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
    await appendConversation(store, conversation, question, answer, { theirs: true });
  } catch {
    // The reply is still owed; a history that failed to save costs the next turn some context.
  }
}
