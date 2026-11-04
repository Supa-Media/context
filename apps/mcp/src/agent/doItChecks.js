/**
 * DO THE READ, NEVER OFFER IT; ASK THE ADVISOR WHEN THEY SAY SO (Dev2's
 * 2026-11-04 morning chat, `docs/decisions/texting-assistant/do-the-read.md`).
 *
 * In one conversation Tex ended three answers with an offer to do a read it
 * could do itself ("I haven't searched your inbox. Want me to check?", "Want
 * me to read that thread?", "Want me to search it for their last message?"),
 * offered to draft an email instead of drafting it, and never asked the
 * advisor that Dev2 had asked it to ask. Its thinking quoted the old 12 s
 * nudge ("otherwise answer now") as the reason. The prompt already says a
 * step that reaches nobody else is Tex's to take (`chatVoice.js`
 * `DO_NOT_OFFER_LINE`), but the front door runs no reply checks
 * (`frontDoor.js`), so nothing held it to that.
 *
 * These two checks run on every texted turn, the front door's included, the
 * way the untried-web check does (`untriedWeb.js`): each is a regex over the
 * words and a flag on the turn's calls, so a turn that does the work pays
 * nothing, and each goes back at most once.
 *
 * - An answer that offers a read, search, check or draft (anything that
 *   reaches nobody else) gets one more round, told to do it now.
 * - A question that asks for the advisor, in a turn that has one and has not
 *   asked it, gets one more round, told to ask it now. The gateway decides
 *   this from their words, never the model.
 */

import { ADVISOR_TOOL } from "./advisor.js";

/**
 * They asked for Tex's advisor ("ask the advisor", "check with your advisor", "what does the advisor think").
 * "My advisor" is a person of theirs, never this one.
 */
const NAMES_ADVISOR = /\b(?:ask|check with|run (?:it|this|that) (?:by|past)|consult|loop in|get|what (?:does|would|did))\s+(?:the |your |ur |tex'?s )?advisor\b|\b(?:the|your|ur) advisor (?:think|say|says|said)\b/i;

/** Work that reaches nobody else, offered back as a question instead of done. Sending, booking or paying is not here: that still waits. */
const OFFERED_READ = [
  /\b(?:want|would you like|do you want|should|shall)\s+(?:me\s+to|I)\s+(?:also\s+|go\s+(?:ahead\s+and\s+)?|quickly\s+)?(?:check|read|search|look|open|pull(?:\s+up)?|find|dig|scan|go\s+through|review|draft|write\s+(?:up|out)?|summari[sz]e)\b/i,
  /\b(?:let me know|tell me|just say)\s+if\s+you(?:'d)?\s+(?:want|like)\s+me\s+to\s+(?:check|read|search|look|open|pull|find|dig|scan|go\s+through|review|draft|summari[sz]e)\b/i,
  // "Want me to keep looking in the brand notes?" (a customer's group chat, 2026-11-04): going on with a search is a search.
  /\b(?:want|would you like|do you want|should|shall)\s+(?:me\s+to|I)\s+(?:keep|continue|carry\s+on|go\s+on)\s+(?:looking|searching|digging|checking|reading|trying)\b/i,
  /\b(?:want|would you like|do you want|should|shall)\s+(?:me\s+to|I)\s+(?:look|search|dig|check)\s+(?:further|more|deeper|elsewhere|again)\b/i,
  /\bI\s+(?:haven't|have not|didn't|did not)\s+(?:yet\s+)?(?:searched|checked|read|opened|looked(?:\s+(?:at|in|through))?)\b[^.?!\n]{0,80}[.?!]?\s*(?:want|should|shall)\b/i,
];

export const READ_NOTICE =
  "Before this goes: you offered to read, search, check or draft something instead of doing it. That reaches nobody else, so it is yours to do: " +
  "do it now with your tools and answer with what you found or the draft itself. Never ask whether to look something up. " +
  "Only what reaches another person (sending, booking, paying, a call) waits for their yes.";

export const ADVISOR_NOTICE =
  "Before this goes: they asked you to ask your advisor, and you haven't. Ask it now (ask_advisor; it sees this whole turn), " +
  "then answer with what it said, in your own words.";

/**
 * Said it couldn't find something and sent them to a person instead ("Jo or
 * Sam would know", "ask Sam"): in a customer's group chat (2026-11-04) the
 * person named was the one asking, after a single search of the notes.
 */
const COULD_NOT_FIND = /\b(?:couldn't|could not|can't|cannot|didn't|did not|wasn't able to|unable to)\s+(?:find|locate|see|spot|track\s+down)\b|\b(?:don't|doesn't|do not|does not)\s+say\s+where\b|\bno\s+(?:note|mention|record)\s+of\b/i;
const SENDS_TO_PERSON = /\b(?:would|should|might|may|will)\s+know\b|\b(?:[Aa]sk|[Cc]heck\s+with)\s+(?!me\b|you\b|them\b)[A-Z@][\w-]*/;

export const PERSON_NOTICE =
  "Before this goes: you said you couldn't find it and pointed them at a person. First look everywhere you can reach: other words in the notes (the name, the file type, the folder), " +
  "this chat's earlier messages, the web, and a site you can open with a saved login. Say who would know only after that, never to the person asking, and say in a few words where you looked.";

/**
 * An answer that only thanks or acknowledges, in a turn that used no tool,
 * to words that weren't themselves a thanks (a customer's group chat,
 * 2026-11-04: told where the file Tex couldn't find lives, Tex answered
 * "Thanks, Jon. That helps." and did nothing with it).
 */
/** What an acknowledgment is made of; whatever is left, but for one name, is more than one. */
const ACK_WORDS = /\b(?:ok(?:ay)?|got it|noted|thanks?(?: you)?(?: so much)?|thx|ty|great|perfect|cool|nice|good to know|understood|will do|sounds good|that(?:'s| is)? (?:helpful|useful|great|good to know)|that helps|appreciate (?:it|that)|makes sense|I'll (?:remember|keep) (?:that|it)(?: in mind)?)\b/gi;
const THEIR_ACK = /^\s*(?:(?:ok(?:ay)?|k|got it|thanks?(?: you)?|thx|ty|great|perfect|cool|nice|lol|haha|yes|yep|yeah|no|nope|sure|👍|🙏|❤️|😂)[\s,.!]*)+$/i;

export const CARRY_ON_NOTICE =
  "Before this goes: you only acknowledged their message and used no tool. If it gives you something toward an ask you couldn't finish or a question you asked, carry that ask on now: " +
  "go where it points with your tools, save what it told you to the workspace note it belongs in so nobody has to say it again, and answer with the result. " +
  "If you can't reach where it points (an app with no connection or saved login), say so plainly in one line and the one way to let you in. " +
  "If it truly needs nothing from you, send your answer again as it was.";

/** Whether an answer says it couldn't find something and sends them to a person. */
export function sendsToAPerson(answer) {
  const words = String(answer ?? "").replace(/[‘’]/g, "'");
  return COULD_NOT_FIND.test(words) && SENDS_TO_PERSON.test(words);
}

/** Whether an answer only thanks or acknowledges, to words that were more than a thanks. At most one name ("Thanks, Jo") is left over. */
export function onlyAcknowledges(answer, question) {
  const words = String(answer ?? "").replace(/[‘’]/g, "'").trim();
  const theirs = String(question ?? "").replace(/[‘’]/g, "'").trim();
  if (words === "" || words.length > 120 || theirs === "" || THEIR_ACK.test(theirs)) return false;
  if (!new RegExp(ACK_WORDS.source, "i").test(words)) return false;
  const left = words.replace(ACK_WORDS, " ").split(/[^\p{L}\p{N}@'-]+/u).filter((word) => /[\p{L}\p{N}]/u.test(word));
  return left.length === 0 || (left.length === 1 && /^(?:@[\p{L}\p{N}]|\p{Lu})/u.test(left[0]));
}

/** Whether an answer offers back a read, search, check or draft. */
export function offersARead(answer) {
  const words = String(answer ?? "").replace(/[‘’]/g, "'");
  return OFFERED_READ.some((pattern) => pattern.test(words));
}

/** Whether their words ask for the advisor. */
export function namesTheAdvisor(question) {
  return NAMES_ADVISOR.test(String(question ?? ""));
}

/**
 * `{ wrapLocal, check }` around a turn's other answer check (`claimCheck.js`
 * or `untriedWeb.js`, or none): `wrapLocal` watches the turn's own tools for
 * the advisor; `check` runs these first, then the other's.
 */
export function doItChecks({ question, inner = null }) {
  const advisorAsked = namesTheAdvisor(question);
  let hasAdvisor = false;
  let askedAdvisor = false;
  let readNoticed = false;
  let advisorNoticed = false;
  let personNoticed = false;
  let carryNoticed = false;
  return {
    wrapLocal(local) {
      return (Array.isArray(local) ? local : []).map((entry) => {
        if (entry?.tool?.name !== ADVISOR_TOOL || typeof entry.call !== "function") return entry;
        hasAdvisor = true;
        return { ...entry, call: (...args) => ((askedAdvisor = true), entry.call(...args)) };
      });
    },
    // `turn.steps`: the calls this turn has made so far (`turn.js`); unknown counts as some, so nothing is sent back on a guess.
    async check(answer, turn = {}) {
      if (advisorAsked && hasAdvisor && !askedAdvisor && !advisorNoticed) {
        advisorNoticed = true;
        return ADVISOR_NOTICE;
      }
      if (!readNoticed && offersARead(answer)) {
        readNoticed = true;
        return READ_NOTICE;
      }
      if (!personNoticed && sendsToAPerson(answer)) {
        personNoticed = true;
        return PERSON_NOTICE;
      }
      if (!carryNoticed && turn?.steps === 0 && onlyAcknowledges(answer, question)) {
        carryNoticed = true;
        return CARRY_ON_NOTICE;
      }
      return typeof inner?.check === "function" ? await inner.check(answer, turn) : null;
    },
  };
}
