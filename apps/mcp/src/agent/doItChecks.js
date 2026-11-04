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
  /\bI\s+(?:haven't|have not|didn't|did not)\s+(?:yet\s+)?(?:searched|checked|read|opened|looked(?:\s+(?:at|in|through))?)\b[^.?!\n]{0,80}[.?!]?\s*(?:want|should|shall)\b/i,
];

export const READ_NOTICE =
  "Before this goes: you offered to read, search, check or draft something instead of doing it. That reaches nobody else, so it is yours to do: " +
  "do it now with your tools and answer with what you found or the draft itself. Never ask whether to look something up. " +
  "Only what reaches another person (sending, booking, paying, a call) waits for their yes.";

export const ADVISOR_NOTICE =
  "Before this goes: they asked you to ask your advisor, and you haven't. Ask it now (ask_advisor; it sees this whole turn), " +
  "then answer with what it said, in your own words.";

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
  return {
    wrapLocal(local) {
      return (Array.isArray(local) ? local : []).map((entry) => {
        if (entry?.tool?.name !== ADVISOR_TOOL || typeof entry.call !== "function") return entry;
        hasAdvisor = true;
        return { ...entry, call: (...args) => ((askedAdvisor = true), entry.call(...args)) };
      });
    },
    async check(answer) {
      if (advisorAsked && hasAdvisor && !askedAdvisor && !advisorNoticed) {
        advisorNoticed = true;
        return ADVISOR_NOTICE;
      }
      if (!readNoticed && offersARead(answer)) {
        readNoticed = true;
        return READ_NOTICE;
      }
      return typeof inner?.check === "function" ? await inner.check(answer) : null;
    },
  };
}
