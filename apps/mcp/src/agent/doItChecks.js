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
 * This check runs on every texted turn, the front door's included, the way
 * the untried-web check does (`untriedWeb.js`): a question that asks for the
 * advisor, in a turn that has one and has not asked it, gets one more round,
 * told to ask it now. The gateway decides this from their words, never the
 * model, and it goes back at most once.
 *
 * The regex over the answer that sent back any "want me to read/draft …?" is
 * gone (Dev2's pick, 2026-11-05): in the core benchmark it sent back "Yes, skip
 * it. You're in Lisbon … Want me to draft a message to the band?", a right
 * answer, and Tex replaced the take with only the draft. Whether an answer
 * offered work instead of doing it is the reply judge's `offered_instead`
 * check (`replyJudge.js`), which reads the whole turn rather than a phrase.
 */

import { ADVISOR_TOOL } from "./advisor.js";

/**
 * They asked for Tex's advisor ("ask the advisor", "check with your advisor", "what does the advisor think").
 * "My advisor" is a person of theirs, never this one.
 */
const NAMES_ADVISOR = /\b(?:ask|check with|run (?:it|this|that) (?:by|past)|consult|loop in|get|what (?:does|would|did))\s+(?:the |your |ur |tex'?s )?advisor\b|\b(?:the|your|ur) advisor (?:think|say|says|said)\b/i;

export const ADVISOR_NOTICE =
  "Before this goes: they asked you to ask your advisor, and you haven't. Ask it now (ask_advisor; it sees this whole turn), " +
  "then answer with what it said, in your own words.";

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
      return typeof inner?.check === "function" ? await inner.check(answer) : null;
    },
  };
}
