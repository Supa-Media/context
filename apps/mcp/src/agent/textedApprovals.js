/**
 * A texted yes or no settles what the texting thread's latest ask put to the
 * person (`privacy/egress.js`), before any model runs; moved out of
 * `route.js`, which calls it, to keep that file to one job.
 */

import { callToolForSession } from "../tools/session.js";
import { EMAIL_TOOL } from "../tools/email.js";
import { CALENDAR_TOOL } from "../tools/calendarWrite.js";
import { REPORT_TOOL } from "../tools/reportProblem.js";
import { FORWARD_RULE_TOOL } from "../tools/forwardRule.js";
import { doneLine } from "./doneLine.js";
import { folded } from "./folded.js";
import { canonicalToolName } from "../tools/advertised.js";
import { withoutHeldEcho, withoutWaitTalk } from "./heldEcho.js";
import { VAULT_PAY } from "../vault/pay.js";
import { armForText, disarmRecords, listPending, replayAsAsked, settlePending, withdrawPending } from "../tools/approvals.js";

/*
  What a texted yes to a new workspace leads to (the owner, 2026-10-20). No
  model runs on the yes, so the turn that would lay the workspace out and move
  the notes about it there never happens unless the reply offers it; the next
  "yes" then goes to the model, with this line in the conversation.
*/
const NEXT_AFTER_CREATE = "Want me to set up its folders and move your notes about it there?";

/** The lines a released call's done line is followed by. */
function afterYes(tool) {
  return canonicalToolName(tool) === "create_workspace" ? [NEXT_AFTER_CREATE] : [];
}

/**
 * How every ask asks (Dev2, 2026-10-21: "instead of asking users to say yes,
 * ask them to react like with a thumbs up", and later that day: "a thumbs up
 * should always be seen as an approval, the text should end with something
 * simple like 'give it a 👍 and i'll send'"). A 👍 or ❤️ that stays ten
 * seconds on the ask, or on any text of the reply that carried it, is the yes
 * (`apps/agent/src/thumbs.ts`, `thumbsUpIsYes`); a typed yes still works. In
 * a group only the asker's counts.
 */
export const SAY_YES = "Give it a 👍";

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
  String.raw`^\s*(?:(?:yes|yep|yeah|yup|ok|okay|sure|y)(?:${SEP}${RELEASE})+|(?:send it|send them|file it|send that|file that|send)(?:${SEP}${RELEASE})*)\s*[.!]*\s*$`,
  "i",
);

/*
  A yes said in a sentence (Dev2, 2026-10-22: "yes please send it already sent
  👍" got nothing, after a 👍 that got nothing). A text whose every word is
  one of these, with at least one that says yes or says to send it, is a yes.
  Any other word, "but", "to", a name, "not", sends it to the model, so "yes
  but send it to Sam" and "did you send it" are still not a yes.
*/
const SAYS_YES = new Set(["yes", "yess", "yesss", "yep", "yeah", "yea", "ya", "yup", "y", "\u{1F44D}", "\u2705", "\u2714"]);
const SAYS_SEND = new Set(["send", "file", "confirm", "confirmed", "approve", "approved"]);
const ALSO_SAID = new Set([
  ...SAYS_YES, ...SAYS_SEND,
  "ok", "okay", "k", "sure", "please", "pls", "plz", "it", "them", "that", "this", "now", "already", "just", "go", "ahead", "do",
  "for", "right", "away", "asap", "the", "message", "email", "dm", "text", "again", "thanks", "thank", "you", "ty", "sent", "so",
  "and", "then", "absolutely", "definitely", "of", "course", "lol", "haha", "\u{1F64F}", "\u{1F525}", "\u2764", "\u{1F44C}",
]);

/** The words of a short text, emoji as words of their own, punctuation dropped. */
function wordsOf(text) {
  return text
    .normalize("NFKC")
    .toLowerCase()
    .replace(/[\u{1F3FB}-\u{1F3FF}\uFE0F\u200D]/gu, "")
    .replace(/(\p{Extended_Pictographic}|\u2705|\u2714)/gu, " $1 ")
    .replace(/[^\p{L}\p{N}\p{Extended_Pictographic}\u2705\u2714]+/gu, " ")
    .trim()
    .split(" ")
    .filter(Boolean);
}

/** Whether a text is a yes said in a sentence; `strict` wants a yes word or a word saying to send it, never "ok" or "sure" alone. */
function sentenceYes(text, strict = false) {
  const words = wordsOf(text);
  if (words.length === 0 || words.length > 12 || !words.every((word) => ALSO_SAID.has(word))) return false;
  if (words.some((word) => SAYS_YES.has(word) || SAYS_SEND.has(word))) return true;
  // "go ahead", "do it": a release in two words, as before; never for an email.
  return !strict && (words.includes("ahead") || (words.includes("do") && words.includes("it")));
}

export function approvalVerdict(text) {
  if (typeof text !== "string") return null;
  if (YES.test(text) || RELEASED_YES.test(text) || sentenceYes(text)) return "approve";
  if (NO.test(text)) return "deny";
  return null;
}

/**
 * The line a texted answer ends with when the turn held something for the
 * person. Said the way a person would ask (Dev, 2026-10-18: "“Text YES to
 * send” seems very robotic"), and ending the way Dev2 asked on 2026-10-21:
 * "Give it a 👍 and I'll send it." A typed yes still works.
 */
export function askLine(asked) {
  // An email is shown whole: the person can allow only the copy they read (`emailGate.js`).
  const emails = asked.filter((record) => record.tool === EMAIL_TOOL && typeof record.detail === "string");
  if (asked.length === 1 && asked[0].tool === CALENDAR_TOOL && typeof asked[0].detail === "string") {
    return `Here's the change I'd make:\n\n${clean(asked[0].detail)}\n\n${SAY_YES} and I'll make the change.`;
  }
  if (asked.length === 1 && asked[0].tool === REPORT_TOOL && typeof asked[0].detail === "string") {
    return `Here's the bug report I'd send to the Context team:\n\n${clean(asked[0].detail)}\n\n${SAY_YES} and I'll send it.`;
  }
  if (asked.length === 1 && asked[0].tool === FORWARD_RULE_TOOL && typeof asked[0].detail === "string") {
    return `Here's what I'd keep doing:\n\n${clean(asked[0].detail)}\n\n${SAY_YES} and I'll start.`;
  }
  // A card at a checkout, in the gateway's words: the card and the site, never the model's (`vault/pay.js`).
  if (asked.length === 1 && asked[0].kind === VAULT_PAY) {
    return `Before I pay, I need your OK to ${clean(asked[0].summary).replace(/^let Tex /, "")}. ${SAY_YES} and I'll fill it in.`;
  }
  if (emails.length > 0 && emails.length === asked.length) {
    const copies = emails.map((record) => clean(record.detail)).join("\n\n---\n\n");
    return `${emails.length === 1 ? "Here's the email" : "Here are the emails"} I'd send:\n\n${copies}\n\n${SAY_YES} and I'll send ${emails.length === 1 ? "it" : "them"}.`;
  }
  const what = asked.map((record) => (typeof record.detail === "string" ? `${record.summary}:\n\n${clean(record.detail)}\n\n` : record.summary)).join("; ");
  return `Before I ${asked.length === 1 ? "do that" : "do those"}, I need your OK: ${what}. ${SAY_YES} and I'll go ahead.`;
}

/** Fewer words than this quoted cannot tell one ask from another. */
const MIN_QUOTED = 24;

/**
 * Whether a 👍 or ❤️ tapback is a yes to what is waiting: only when the words
 * it was on are the ask the person was shown for exactly what is armed now
 * (Dev2, 2026-10-21). A like on an older ask, or on any other text, is not.
 */
export async function thumbsUpIsYes(store, session, quoted) {
  if (quoted?.tapback !== "Liked" && quoted?.tapback !== "Loved") return false;
  const words = folded(quoted.words);
  if (words.length < MIN_QUOTED) return false;
  const armed = (await listPending(store, { userId: session.actorUserId, texting: true })).map(({ record }) => record);
  const matched = armed.length > 0 && [armed, [...armed].reverse()].some((order) => {
    const shown = folded(askLine(order));
    return shown === words || shown.startsWith(words);
  });
  // Without its words: enough to tell a 👍 on nothing armed from one on other words (2026-10-22).
  console.log(JSON.stringify({ event: "thumbs_up", armed: armed.length, matched, length: words.length }));
  return matched;
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
 * end. The record stays armed for twelve hours either way, and a bare "yes"
 * afterwards releases what the person never saw. A handle claim is the ask
 * this matters most for: it holds no email, it is the one ask the deployment
 * switch still makes (`../tools/session.js`), and a claimed handle is never
 * given back.
 */
export async function textedAsk(store, session, asked) {
  if (asked.length === 0) return { ask: null, verbatim: [] };
  // In a group chat a bare "yes" is chat; a reply to the ask, or "Tex, yes", reaches Tex (`groupTurn.js`).
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
 * reads one copy, the one a YES sends, and so is any talk of the yes being
 * waited on somewhere else: the ask is right below.
 */
export function answerWithAsk(told, ask, asked) {
  if (ask === null) return told;
  const said = withoutWaitTalk(withoutHeldEcho(told, asked));
  // The model's one line about what it held ("Adding it for Sunday, Nov 1") says what the ask
  // says, as a second text (Dev2, 2026-10-22: "should be merged into 1"); more than that is kept.
  return said === "" || saysOnlyWhatIsAsked(said) ? ask : `${said}\n\n${ask}`;
}

/*
  The line the model is told to write about a held call ("Drafted it again,
  the same joke note to Sayo", "Adding it for Sunday, Nov 1"): one short
  paragraph, no question, saying what Tex drafted or is doing. Anything else
  ("Her quotes were for 6:30, so she may send a new one for 7.") is news and
  stays above the ask.
*/
const ASK_ECHO_MAX = 240;
const ABOUT_THE_HELD =
  /^(?:drafted|drafting|adding|added|sending|here(?:'|’)?s|ready|got it|ok(?:ay)?|sure|done)\b|\bI(?:'|’)?(?:ve|ll|d|m)?\s+(?:have\s+|will\s+|would\s+)?(?:drafted|draft|wrote|written|add|added|adding|send|sending|put|prepared|made|set up|lined up)\b/i;
function saysOnlyWhatIsAsked(said) {
  return said.length <= ASK_ECHO_MAX && !/\n\s*\n/.test(said) && !said.includes("?") && ABOUT_THE_HELD.test(said.trim());
}

/*
  What a released call that failed tells the person. Slack's refusal for a
  permission the connection was never given is written for the model ("Ask the
  person to reconnect Slack …"), so it is said to them in their terms
  (2026-10-22: the Slack app had been asked for im:write and mpim:write).
*/
const SLACK_SCOPE = /^Slack hasn't given this connection permission for \S+ yet(?: \(it needs ([^)]{1,80})\))?/;

/** "Not sent: …" for a released call that failed, in words the person can act on. */
export function notDone(summary, said) {
  const scope = SLACK_SCOPE.exec(said);
  if (scope !== null) {
    const needs = scope[1] ? ` (it needs ${scope[1]})` : "";
    return (
      `Not sent: Slack hasn't given me permission for that yet${needs}. ` +
      "Reconnect Slack in Context's Settings, under Apps Tex uses, then ask me again and I'll send it."
    );
  }
  return `I tried to ${summary}, but: ${said}`;
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
const strictYes = (text) => EMAIL_YES.test(text) || RELEASED_YES.test(text) || sentenceYes(text, true);
const YES_ONLY = new Set([EMAIL_TOOL, CALENDAR_TOOL, REPORT_TOOL, FORWARD_RULE_TOOL]);

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
    // A card's yes lets the model go on to fill it, so it is settled before this (`textedPay.js`).
    if (record.kind === VAULT_PAY) continue;
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
    if (settled.result?.isError === true) replies.push(notDone(record.summary, said));
    else replies.push(doneLine(record.summary), ...afterYes(record.tool));
  }
  // An email or calendar change the text did not say YES to is disarmed now: when the text settled
  // something else, no model turn follows to disarm it, and a later bare yes must not reach it.
  if ((await disarmRecords(store, notYes)) > 0) {
    replies.push("I couldn't set aside what I showed you, so it is still waiting: reply NO to drop it.");
  }
  return replies.length === 0 ? null : replies.join("\n");
}
