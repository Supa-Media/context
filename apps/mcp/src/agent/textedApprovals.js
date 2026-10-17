/**
 * A texted yes or no settles what the texting thread's latest ask put to the
 * person (`privacy/egress.js`), before any model runs; moved out of
 * `route.js`, which calls it, to keep that file to one job.
 */

import { callToolForSession } from "../tools/session.js";
import { armForText, disarmRecords, listPending, replayAsAsked, settlePending, withdrawPending } from "../tools/approvals.js";

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

/** The longest ask holding an email: one text, under the 3,000 a text keeps (`apps/agent/src/clients.ts`). */
export const TEXTED_ASK_CAP = 2_900;

/**
 * What a turn's answer ends with, and the part of it texted exactly as
 * written. The person may allow only what they read, so an ask that would not
 * fit in one text is withdrawn (and `asked` emptied) rather than cut.
 *
 * Every ask goes out verbatim, in a text of its own, whether or not it holds
 * an email. Handed back as part of the answer instead, it is the model's
 * prose that decides whether the person ever reads it:
 * `apps/agent/src/format.ts` keeps three texts and folds every later
 * paragraph into the third, and `apps/agent/src/clients.ts` sends at most
 * 3,000 characters of each, so a long answer cuts the ask line off its own
 * end. The record stays armed for half an hour either way, and a bare "yes"
 * afterwards releases what the person never saw. A handle claim is the ask
 * this matters most for: it holds no email, it is the one ask the deployment
 * switch still makes (`../tools/session.js`), and a claimed handle is never
 * given back.
 */
export async function textedAsk(store, session, asked) {
  if (asked.length === 0) return { ask: null, verbatim: [] };
  const ask = askLine(asked);
  const ids = asked.map((record) => record.id);
  const holdsEmail = asked.some((record) => typeof record.detail === "string");
  if (ask.length <= TEXTED_ASK_CAP) {
    // Raised unarmed (`../tools/approvals.js`): armed only now that the ask
    // goes out whole, so an ask that is dropped instead leaves nothing a yes
    // can reach, even if withdrawing it below fails.
    try {
      await armForText(store, { userId: session.actorUserId, ids });
      return { ask, verbatim: [ask] };
    } catch {
      await withdrawPending(store, { userId: session.actorUserId, ids }).catch(() => {});
      asked.length = 0;
      return { ask: "Something went wrong putting that to you, so I've dropped it. Ask me again.", verbatim: [] };
    }
  }
  await withdrawPending(store, { userId: session.actorUserId, ids }).catch(() => {});
  asked.length = 0;
  return {
    ask:
      "That was too long to show you whole in one text, so I've dropped it. " +
      (holdsEmail ? "Ask me for one email at a time." : "Ask me for one thing at a time."),
    verbatim: [],
  };
}

/** Control characters and bidi overrides out of words the model wrote, before a person reads them. */
function clean(text) {
  return text.replace(/[\u0000-\u0008\u000b-\u001f\u007f\u202a-\u202e\u2066-\u2069]/g, "");
}

/** An email is sent only on the word it asked for: "ok" or "sure" to an email is not a yes. */
const EMAIL_YES = /^\s*yes\s*[.!]*\s*$/i;
const EMAIL_TOOL = "send_email";

/**
 * Settle what this thread's latest ask put to the person, as their text said.
 * Returns the reply, or null when nothing was waiting — in which case the text
 * is an ordinary one and the model answers it.
 */
export async function settleByText(store, session, verdict, texted = "") {
  // Only what this thread asked about, lately, and not since moved on from: a
  // yes here never releases a call some other client raised that the person was
  // not told of. Every record left armed was asked in the thread's latest ask,
  // and the ask line named all of them, so one yes answers all of them.
  const waiting = await listPending(store, { userId: session.actorUserId, texting: true });
  if (waiting.length === 0) return null;
  const replies = [];
  const notYes = [];
  for (const entry of [...waiting].reverse()) {
    const { record } = entry;
    if (verdict === "approve" && record.tool === EMAIL_TOOL && !EMAIL_YES.test(texted)) {
      notYes.push(entry);
      continue;
    }
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
  // An email the text did not say YES to is disarmed now: when the text settled
  // something else, no model turn follows to disarm it, and a later bare yes must not reach it.
  if ((await disarmRecords(store, notYes)) > 0) {
    replies.push("I couldn't set aside the email I showed you, so it is still waiting: reply NO to drop it.");
  }
  return replies.length === 0 ? null : replies.join("\n");
}
