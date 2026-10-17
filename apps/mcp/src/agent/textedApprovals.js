/**
 * A texted yes or no settles what the texting thread's latest ask put to the
 * person (`privacy/egress.js`), before any model runs; moved out of
 * `route.js`, which calls it, to keep that file to one job.
 */

import { callToolForSession } from "../tools/session.js";
import { listPending, replayAsAsked, settlePending } from "../tools/approvals.js";

/** A text that is nothing but yes, or nothing but no; anything else goes to the model. */
const YES = /^\s*(?:yes|yes please|yep|yeah|yup|ok|okay|sure|do it|go ahead|go for it|confirm|confirmed|approve|approved|allow|y)\s*[.!]*\s*$/i;
const NO = /^\s*(?:no|nope|no thanks|don'?t|cancel|stop|deny|denied|never ?mind|forget it|drop it|n)\s*[.!]*\s*$/i;

export function approvalVerdict(text) {
  if (typeof text !== "string") return null;
  if (YES.test(text)) return "approve";
  if (NO.test(text)) return "deny";
  return null;
}

/** The line a texted answer ends with when the turn held something for the person. */
export function askLine(asked) {
  // An email is shown whole: the person can allow only the copy they read (`emailGate.js`).
  const emails = asked.filter((record) => typeof record.detail === "string");
  if (emails.length > 0 && emails.length === asked.length) {
    const copies = emails.map((record) => clean(record.detail)).join("\n\n---\n\n");
    return `Here ${emails.length === 1 ? "is the email" : "are the emails"} I'd send:\n\n${copies}\n\nReply YES to send ${emails.length === 1 ? "it" : "them"} now, or NO to drop ${emails.length === 1 ? "it" : "them"}.`;
  }
  const what = asked.map((record) => (typeof record.detail === "string" ? `${record.summary}:\n\n${clean(record.detail)}\n\n` : record.summary)).join("; ");
  return `Before I ${asked.length === 1 ? "do that" : "do those"}, I need your OK: ${what}. Reply YES to go ahead, or NO to drop it.`;
}

/** Control characters and bidi overrides out of words the model wrote, before a person reads them. */
function clean(text) {
  return text.replace(/[\u0000-\u0008\u000b-\u001f\u007f\u202a-\u202e\u2066-\u2069]/g, "");
}

/**
 * Settle what this thread's latest ask put to the person, as their text said.
 * Returns the reply, or null when nothing was waiting — in which case the text
 * is an ordinary one and the model answers it.
 */
export async function settleByText(store, session, verdict) {
  // Only what this thread asked about, lately, and not since moved on from: a
  // yes here never releases a call some other client raised that the person was
  // not told of. Every record left armed was asked in the thread's latest ask,
  // and the ask line named all of them, so one yes answers all of them.
  const waiting = await listPending(store, { userId: session.actorUserId, texting: true });
  if (waiting.length === 0) return null;
  const replies = [];
  for (const { record } of [...waiting].reverse()) {
    const settled = await settlePending(store, record.id, {
      userId: session.actorUserId,
      action: verdict,
      actorScope: session.scope,
      run: (held) =>
        replayAsAsked(store, session, held, (approver) =>
          callToolForSession({ name: held.tool, arguments: held.args }, store, approver),
        ),
    });
    if (settled.status === "denied") {
      replies.push(`OK, dropped: ${record.summary}.`);
      continue;
    }
    if (settled.status !== "approved") continue;
    const text = settled.result?.content?.[0]?.text;
    const said = typeof text === "string" && text.trim() ? text.trim() : "done.";
    // A tool's own text is for a model: an etag, a visibility line. The person
    // texted yes to a one-line summary and gets that summary back (the first
    // Action round, 2026-10-10: "Done: write projects/x.md into @woodshop.
    // written: projects/x.md (etag c2.doc-…) visibility: team" failed every
    // voice line the judge has). What went wrong still says what the tool said.
    replies.push(settled.result?.isError === true ? `I tried to ${record.summary}, but: ${said}` : `Done: ${record.summary}.`);
  }
  return replies.length === 0 ? null : replies.join("\n");
}
