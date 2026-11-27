/**
 * A texted yes or no settles what the texting thread's latest ask put to the
 * person (`privacy/egress.js`), before any model runs; moved out of
 * `texEntryPoint.js`, which calls it, to keep that file to one job.
 */

import { callToolForSession } from "../../../../apps/mcp/src/tools/session.js";
import { doneLine } from "./doneLine.js";
import { folded } from "./folded.js";
import { canonicalToolName } from "../../../../apps/mcp/src/tools/advertised.js";
import { withoutHeldEcho, withoutWaitTalk } from "./heldEcho.js";
import { VAULT_PAY } from "../../../../apps/mcp/src/vault/pay.js";
import { EVERY_CHAT, armForText, disarmChat, disarmRecords, disarmTexting, listPending, replayAsAsked, settlePending, withdrawPending } from "../../../../apps/mcp/src/tools/approvals.js";

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

/** A text that is nothing but yes, or nothing but no; anything else goes to the model. */
const YES = /^\s*(?:yes|yes please|yep|yeah|yup|ok|okay|k|sure|do it|go ahead|go for it|confirm|confirmed|approve|approved|allow|y|sounds good|looks good|perfect|lgtm|\u{1F44C})\s*[.!]*\s*$/iu;
const NO = /^\s*(?:no|nope|no thanks|don'?t|cancel|stop|deny|denied|never ?mind|forget it|drop it|n|\u{1F44E}[\u{1F3FB}-\u{1F3FF}]?)\s*[.!]*\s*$/iu;

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
  // "send the draft" is the in-app approval card's reply (Dev2, 2026-11-20). "draft" alone is no verdict: it says no yes and no send.
  "draft", "drafts",
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

/** Whether a text is a yes said in a sentence. */
function sentenceYes(text) {
  const words = wordsOf(text);
  if (words.length === 0 || words.length > 12 || !words.every((word) => ALSO_SAID.has(word))) return false;
  if (words.some((word) => SAYS_YES.has(word) || SAYS_SEND.has(word))) return true;
  // "go ahead", "do it": a release in two words.
  return words.includes("ahead") || (words.includes("do") && words.includes("it"));
}

export function approvalVerdict(text) {
  if (typeof text !== "string") return null;
  if (YES.test(text) || RELEASED_YES.test(text) || sentenceYes(text)) return "approve";
  if (NO.test(text)) return "deny";
  return null;
}

/*
  TEX ASKS IN ITS OWN WORDS (Dev2, 2026-11-26: "remember our rule for hardcoded lines"). A held call hands Tex the
  facts and the exact copy (`apps/mcp/src/tools/heldFacts.js`), and Tex's answer is the ask. The gateway no longer
  writes a card under it; it checks the one thing the person's OK rests on: every held copy is in the text, whole.
  A copy Tex left out or reworded is added below its words as the copy itself, data and no wording, so the person
  always reads exactly what a 👍 makes. The text that goes is kept on the records (`shown_text`), and a tapback is a
  yes only on that text (`onArmedAsk`), as the card's words used to be compared.
*/

/** Letters and digits only, one space apart: how two copies of one text are compared. */
const plain = (value) => folded(String(value ?? ""));

/** Whether `text` holds `copy` whole, word for word, ignoring punctuation, case and line breaks. */
export function holdsCopy(text, copy) {
  const want = plain(copy);
  return want === "" || ` ${plain(text)} `.includes(` ${want} `);
}

/** What a held record shows the person: its copy, or for a call with none (a handle claim), the gateway's summary of it. */
const copyOf = (record) => clean(String(typeof record.detail === "string" && record.detail.trim() !== "" ? record.detail : (record.summary ?? ""))).trim();

/** Tex's words with every held copy it did not show whole added below, as the copies themselves; "" for nothing. */
export function withCopies(told, asked) {
  const words = String(told ?? "").trim();
  const missing = asked.map(copyOf).filter((copy) => copy !== "" && !holdsCopy(words, copy));
  return [words, ...missing].filter(Boolean).join("\n\n");
}

/** The text an ask went out as: Tex's words kept on its records, or, for one armed before they were kept, its copies. */
export function shownAsk(records) {
  const kept = records.map((record) => record?.shown_text).find((text) => typeof text === "string" && text !== "");
  if (kept !== undefined) return kept;
  return records.map((record) => (typeof record?.detail === "string" ? record.detail : String(record?.summary ?? ""))).join("\n\n");
}

/** Fewer words than this quoted cannot tell one ask from another. */
const MIN_QUOTED = 24;

/**
 * Whether a 👍 or ❤️ tapback is a yes to what is waiting: only when the words
 * it was on are the ask the person was shown for exactly what is armed now
 * (Dev2, 2026-10-21). A like on an older ask, or on any other text, is not.
 */
export async function thumbsUpIsYes(store, session, quoted, { who = null, chat = null } = {}) {
  if (quoted?.tapback !== "Liked" && quoted?.tapback !== "Loved") return false;
  return await onArmedAsk(store, session, quoted.words, { who, chat, event: "thumbs_up" });
}

/**
 * Whether a 👎 tapback is a no to what is waiting, on the same terms as a 👍's
 * yes (a new tester, 2026-10-30: a 👍 or 👎 should answer a yes-or-no). Left
 * to the model, a 👎 dropped nothing, and a later "yes" still sent the email.
 */
export async function thumbsDownIsNo(store, session, quoted, { who = null, chat = null } = {}) {
  if (quoted?.tapback !== "Disliked") return false;
  return await onArmedAsk(store, session, quoted.words, { who, chat, event: "thumbs_down" });
}

/** Whether these quoted words are the ask shown for exactly what is armed now. */
async function onArmedAsk(store, session, quotedWords, { who, chat, event }) {
  const words = folded(quotedWords);
  if (words.length < MIN_QUOTED) return false;
  const armed = (await listPending(store, { userId: session.actorUserId, texting: true, chat })).map(({ record }) => record);
  // The text the ask went out as, or the quote cut short; or words holding every armed copy whole (an ask armed
  // before its text was kept, whose card showed the copy): either way they 👍'd exactly what a yes makes.
  const shown = folded(shownAsk(armed));
  const copies = armed.every((record) => typeof record.detail === "string" && record.detail.trim() !== "") && armed.every((record) => holdsCopy(quotedWords, record.detail));
  const matched = armed.length > 0 && (shown === words || shown.startsWith(words) || copies);
  // Without its words: enough to tell a tapback on nothing armed from one on other words (2026-10-22).
  console.log(JSON.stringify({ event, armed: armed.length, matched, length: words.length }));
  return matched;
}

/** The longest ask holding an email: one text, under the 3,000 a text keeps (`packages/tex/worker/clients.ts`). */
export const TEXTED_ASK_CAP = 2_900;

/**
 * What a turn's answer ends with, and the part of it texted exactly as
 * written. The person may allow only what they read, so an ask that would not
 * fit in one text is withdrawn (and `asked` emptied) rather than cut.
 *
 * Every ask goes out verbatim, in a text of its own, whether or not it holds
 * an email. Handed back as part of the answer instead, it is the model's
 * prose that decides whether the person ever reads it:
 * `packages/tex/worker/format.ts` keeps three texts and folds every later
 * paragraph into the third, and `packages/tex/worker/clients.ts` sends at most
 * 3,000 characters of each, so a long answer cuts the ask line off its own
 * end. The record stays armed for twelve hours either way, and a bare "yes"
 * afterwards releases what the person never saw. A handle claim is the ask
 * this matters most for: it holds no email, it is the one ask the deployment
 * switch still makes (`../../../../apps/mcp/src/tools/session.js`), and a claimed handle is never
 * given back.
 */
export async function textedAsk(store, session, asked, told = "", { stale = null, chat = null } = {}) {
  /*
    In a group, Tex's question may be put to anyone in it, in anyone's turn, a
    chat routine's or a check-in's too, so it stops every ask armed in the chat
    from listening, not only the asker's: a bare yes there now answers it
    (Dev2, 2026-11-02). Which member a question is put to is not told apart,
    which is the safe direction; the asks this reply arms are kept.
  */
  if (chat !== null && /\?/.test(told)) await disarmChat(store, { chat, keep: asked.map((record) => record.id) }).catch(() => {});
  if (asked.length === 0) {
    // Asks their text corrected, with nothing new drawn, are dropped (`claimCheck.js` rule 6): `stale` names them.
    if (Array.isArray(stale) && stale.length > 0) return { ask: await dropStale(store, session, stale), verbatim: [] };
    // Tex asked something else, so a bare yes now answers that, never an older ask (`textedSettle.js`).
    // Awaited, never handed to the host's deferral: `askOvertaken` counts only Tex's texts sent by
    // themselves, so for a reply that asks something this disarm is the whole protection, and a
    // deferral is "an optimisation it may not get, never where the work happens" (`http/route.js`).
    // Unconditional: a reading taken before the model (`frontDoor.js`) is older than anything a job, a routine or the
    // heartbeat armed while the model ran, and this is the only check between such an ask and a bare yes.
    if (/\?/.test(told)) await disarmTexting(store, { userId: session.actorUserId }).catch(() => {});
    return { ask: null, verbatim: [] };
  }
  // In a group chat a bare "yes" is chat; a reply to the ask, or "Tex, yes", reaches Tex (`groupTurn.js`).
  // Tex's own words are the ask, with any held copy it did not show whole added as the copy itself (`withCopies`).
  // A retelling of a held email in its words comes out first, so the person reads one copy, the one a yes sends (`heldEcho.js`).
  const ask = withCopies(withoutHeldEcho(told, asked), asked);
  const ids = asked.map((record) => record.id);
  const holdsEmail = asked.some((record) => typeof record.detail === "string");
  if (ask !== "" && ask.length <= TEXTED_ASK_CAP) {
    // Raised unarmed (`../../../../apps/mcp/src/tools/approvals.js`): armed only now that the ask
    // goes out whole, so an ask that is dropped instead leaves nothing a yes
    // can reach, even if withdrawing it below fails.
    try {
      await armForText(store, { userId: session.actorUserId, ids, chat, shown: ask });
      return { ask, verbatim: [ask], whole: true };
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
 * Drop the asks their text corrected (`ids`), when the turn drew nothing new:
 * the next yes must never make the one they just corrected (Dev2,
 * 2026-10-26). Only those: another ask still waiting is theirs to answer.
 * Said in the gateway's words, and honestly when one could not be dropped.
 */
async function dropStale(store, session, ids) {
  const wanted = new Set(ids);
  // Every chat: these are named by id, and dropping one armed elsewhere is the safe direction.
  const waiting = (await listPending(store, { userId: session.actorUserId, texting: true, chat: EVERY_CHAT })).filter(({ record }) => wanted.has(record.id));
  if (waiting.length === 0) return null;
  const stuck = await disarmRecords(store, waiting);
  console.log(JSON.stringify({ event: "ask_superseded", asks: waiting.length, stuck }));
  const what = waiting.map(({ record }) => clean(String(record.summary ?? record.tool)).slice(0, 200)).join("; ");
  if (stuck > 0) return `I couldn't withdraw the earlier one (${what}). Text "no" so it isn't sent, then tell me what to send instead.`;
  return `I haven't sent the earlier one (${what}), so nothing goes out on a yes to it. Tell me what to send instead and I'll show it to you.`;
}

/**
 * The texted answer: the model's words, then the ask. An email the ask shows
 * whole is taken out of the model's words first (`heldEcho.js`), so the person
 * reads one copy, the one a YES sends, and so is any talk of the yes being
 * waited on somewhere else: the ask is right below.
 */
export function answerWithAsk(told, ask, asked, whole = false) {
  if (ask === null) return told;
  // Tex's own words with the copies are the ask, sent as they are (`textedAsk`).
  if (whole) return ask;
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

/*
  Any yes releases what the ask showed, an email included: "yes", "ok",
  "sure", "go ahead", "sounds good" (Dev2, 2026-10-22, asked: a bare "ok" to
  "Give it a 👍 and I'll send it" used to be set aside, the email dropped and
  asked about again). What is not a yes still goes to the model: "ok
  thanks", "yes but to Sam".
*/

/**
 * Settle what this thread's latest ask put to the person, as their text said.
 * Returns the reply, or null when nothing was waiting — in which case the text
 * is an ordinary one and the model answers it.
 */
export async function settleByText(store, session, verdict, { chat = null } = {}) {
  // Only what this thread asked about, lately, and not since moved on from: a
  // yes here never releases a call some other client raised that the person was
  // not told of, nor one asked in another chat. Every record left armed was
  // asked in the thread's latest ask, and the ask line named all of them, so
  // one yes answers all of them.
  const waiting = await listPending(store, { userId: session.actorUserId, texting: true, chat });
  if (waiting.length === 0) return null;
  const replies = [];
  for (const entry of [...waiting].reverse()) {
    const { record } = entry;
    // A card's yes lets the model go on to fill it, so it is settled before this (`textedPay.js`).
    if (record.kind === VAULT_PAY) continue;
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
  return replies.length === 0 ? null : replies.join("\n");
}
