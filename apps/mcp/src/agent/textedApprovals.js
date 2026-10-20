/**
 * A texted yes or no settles what the texting thread's latest ask put to the
 * person (`privacy/egress.js`), before any model runs; moved out of
 * `route.js`, which calls it, to keep that file to one job.
 */

import { callToolForSession } from "../tools/session.js";
import { EMAIL_TOOL } from "../tools/email.js";
import { CALENDAR_TOOL } from "../tools/calendarWrite.js";
import { REPORT_TOOL } from "../tools/reportProblem.js";
import { doneLine } from "./doneLine.js";
import { withoutHeldEcho } from "./heldEcho.js";
import { armForText, disarmRecords, listPending, replayAsAsked, settlePending, withdrawPending } from "../tools/approvals.js";

/** A text that is nothing but yes, or nothing but no; anything else goes to the model. */
const YES = /^\s*(?:yes|yes please|yep|yeah|yup|ok|okay|sure|do it|go ahead|go for it|confirm|confirmed|approve|approved|allow|y)\s*[.!]*\s*$/i;
const NO = /^\s*(?:no|nope|no thanks|don'?t|cancel|stop|deny|denied|never ?mind|forget it|drop it|n)\s*[.!]*\s*$/i;

/*
  A yes said the way people say it (Dev, 2026-10-19: "yes, send it, yes, file
  it, yes, please. These all count as yes"): a yes word followed only by
  phrases that release what was shown, or one of those phrases alone. A fixed
  list, anchored at both ends, so "yes but send it to Sam" is still more than
  a yes and goes to the model.
*/
// Each says to go ahead. Courtesies alone ("ok thanks", "great") are an
// acknowledgement, not a send, so they are left out on purpose.
const RELEASE =
  String.raw`(?:please|send it|send them|send that|send|file it|file that|file|do it|go ahead|go for it|make the change|book it|add it|` +
  String.raw`looks good|sounds good)`;
const SEP = String.raw`[\s,.!-]+`;
const RELEASED_YES = new RegExp(
  String.raw`^\s*(?:(?:yes|yep|yeah|yup|ok|okay|sure|y)(?:${SEP}${RELEASE})+|(?:send it|send them|file it|send that|file that)(?:${SEP}${RELEASE})*)\s*[.!]*\s*$`,
  "i",
);

export function approvalVerdict(text) {
  if (typeof text !== "string") return null;
  if (YES.test(text) || RELEASED_YES.test(text)) return "approve";
  if (NO.test(text)) return "deny";
  return null;
}

/**
 * The line a texted answer ends with when the turn held something for the
 * person. Said the way a person would ask (Dev, 2026-10-18: "“Text YES to
 * send” seems very robotic"); an email, a calendar change and a bug report
 * still go only on a bare yes, so those lines say "just say yes".
 */
export function askLine(asked) {
  // An email is shown whole: the person can allow only the copy they read (`emailGate.js`).
  const emails = asked.filter((record) => record.tool === EMAIL_TOOL && typeof record.detail === "string");
  if (asked.length === 1 && asked[0].tool === CALENDAR_TOOL && typeof asked[0].detail === "string") {
    return `Here's the change I'd make:\n\n${clean(asked[0].detail)}\n\nLook good? Just say yes and I'll make the change.`;
  }
  if (asked.length === 1 && asked[0].tool === REPORT_TOOL && typeof asked[0].detail === "string") {
    return `Here's the bug report I'd send to the Context team:\n\n${clean(asked[0].detail)}\n\nLook good? Just say yes and I'll send it.`;
  }
  if (emails.length > 0 && emails.length === asked.length) {
    const copies = emails.map((record) => clean(record.detail)).join("\n\n---\n\n");
    return `${emails.length === 1 ? "Here's the email" : "Here are the emails"} I'd send:\n\n${copies}\n\nLook good? Just say yes and I'll send ${emails.length === 1 ? "it" : "them"}.`;
  }
  const what = asked.map((record) => (typeof record.detail === "string" ? `${record.summary}:\n\n${clean(record.detail)}\n\n` : record.summary)).join("; ");
  return `Before I ${asked.length === 1 ? "do that" : "do those"}, I need your OK: ${what}. Should I go ahead?`;
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

/**
 * The texted answer: the model's words, then the ask. An email the ask shows
 * whole is taken out of the model's words first (`heldEcho.js`), so the person
 * reads one copy, the one a YES sends.
 */
export function answerWithAsk(told, ask, asked) {
  if (ask === null) return told;
  const said = withoutHeldEcho(told, asked);
  return said === "" ? ask : `${said}\n\n${ask}`;
}

/** Control characters and bidi overrides out of words the model wrote, before a person reads them. */
function clean(text) {
  return text.replace(/[\u0000-\u0008\u000b-\u001f\u007f\u202a-\u202e\u2066-\u2069]/g, "");
}

/**
 * An email, a calendar change or a bug report goes only on the word it asked
 * for, or a yes that says to send it: "yes", "yes please", "yes, file it",
 * "ok send it". A bare "ok" or "sure" is not a yes.
 */
const EMAIL_YES = /^\s*yes\s*[.!]*\s*$/i;
const strictYes = (text) => EMAIL_YES.test(text) || RELEASED_YES.test(text);
const YES_ONLY = new Set([EMAIL_TOOL, CALENDAR_TOOL, REPORT_TOOL]);

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
    if (verdict === "approve" && YES_ONLY.has(record.tool) && !strictYes(texted)) {
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
    // voice line the judge has), in the past tense (`doneLine.js`). What went
    // wrong still says what the tool said.
    replies.push(settled.result?.isError === true ? `I tried to ${record.summary}, but: ${said}` : doneLine(record.summary));
  }
  // An email or calendar change the text did not say YES to is disarmed now: when the text settled
  // something else, no model turn follows to disarm it, and a later bare yes must not reach it.
  if ((await disarmRecords(store, notYes)) > 0) {
    replies.push("I couldn't set aside what I showed you, so it is still waiting: reply NO to drop it.");
  }
  return replies.length === 0 ? null : replies.join("\n");
}
