/**
 * RESEARCH THAT STOPS SHORT OF THE ANSWER (self-review, 2026-10-26, a group
 * chat). Asked for three dinner options at about $10 a person for 30 people,
 * a background job texted that it was finished with only the mains priced
 * ("about $1 to $2 per person ... the sides, dessert and drinks are not
 * priced yet ... Next step is pricing the sides"). After "catering in NYC
 * only", the next answer listed caterers to check and ended "I'd try to get a
 * quote from each ... I can write these up in the chat's notes if you want".
 *
 * Both stop at a plan for the very looking they were asked to do. Looking up
 * a published menu or per-head price is Tex's to do; contacting a caterer
 * speaks for them and still waits for a yes. So:
 *
 * - An answer that says part of what was asked is still missing, names its
 *   own next step, or offers to keep looking gets one more round
 *   (`claimCheck.js`), told to do that part now.
 * - A background job whose last answer still stops short is not done: the
 *   gateway marks it `unfinished`, and the Worker gives it another turn
 *   (`apps/agent/src/jobRun.ts`) that builds on that answer, until its
 *   last turn, which says plainly what is missing.
 *
 * Phrases only; the hand-back judge (`handbackJudge.js`) catches the rest.
 */

import { MAX_JOB_ATTEMPTS } from "./background.js";

const LOOKING = String.raw`(?:priced|costed|checked|confirmed|compared|researched|verified|totalled|totaled|looked (?:up|into|at))`;

/** It says a piece of what was asked is still missing, or names its own next step. */
const SHORT = [
  /\bnext steps? (?:is|are|would be|will be|from here is)\s+(?:to\s+)?(?:price|pricing|cost|costing|check|checking|compare|comparing|research|researching|look|looking|find|finding|get|getting|confirm|confirming|call|calling|ask|asking|reach|reaching)\b/i,
  new RegExp(String.raw`(?:\bnot|n't)\s+(?:been\s+|yet\s+)?${LOOKING}\s+(?:\w+\s+){0,3}?yet\b`, "i"),
  new RegExp(String.raw`(?:\bnot|n't)\s+(?:been\s+)?yet\s+${LOOKING}\b`, "i"),
  /\bno (?:price|prices|pricing|cost|costs|quote|quotes|figure|figures|total|totals) (?:\w+\s+){0,3}?yet\b/i,
  new RegExp(String.raw`\b(?:I|we) (?:haven't|have not|didn't|did not) (?:yet\s+)?(?:priced|costed|checked|compared|researched|looked (?:up|into)|found prices for)\b`, "i"),
  /\b(?:I|we) (?:still )?(?:need|have) to (?:price|cost|check|compare|research|look up|look into|find prices)\b/i,
  /\bstill (?:needs?|has|have) to be (?:priced|costed|checked|compared|researched|looked up)\b/i,
  /\bisn't (?:confirmed|priced|known) yet\b|\b(?:full|total) [^.?!\n]{0,40}\b(?:isn't|is not|aren't|are not) (?:confirmed|priced|known|covered)\b/i,
];

/** It offers, or plans, the looking or writing it was asked to do instead of doing it. */
const OFFERS_MORE = [
  /\bI can (?:also )?(?:write (?:these|this|them|it|that) up|look (?:into|up)|dig (?:into|up|deeper|further)|price|research|find|compare|get (?:prices|quotes?|numbers)|check (?:prices|menus))\b[^.?!\n]{0,100}\bif (?:you|y'all|you all)(?:'d)? (?:want|like)\b/i,
  /\b(?:want|would you like) me to (?:look (?:into|up)|dig|price|research|find (?:prices|out)|compare|check (?:prices|menus)|write (?:these|this|them|it) up)\b/i,
  /\bI(?:'d| would) (?:try to |next |then |start by |want to )?(?:get (?:a )?quotes?|look up|price|research|compare (?:prices|quotes))\b/i,
  /\blet me know if you(?:'d)? (?:want|like) me to (?:look|dig|price|research|find|compare|check)\b/i,
];

function said(answer) {
  return String(answer ?? "").replace(/[‘’]/g, "'");
}

/** Whether an answer stops short of what was asked: missing parts, its own next step, or an offer to keep looking. */
export function stopsShort(answer) {
  const words = said(answer);
  return SHORT.some((pattern) => pattern.test(words)) || OFFERS_MORE.some((pattern) => pattern.test(words));
}

const FINISH =
  "Before this goes: your answer stops short of what they asked. It says part of it is still missing, names a next step, or offers to look further, " +
  "and that looking is yours to do. Do it now: search_web, open the pages that have the figures (a menu, a price list, a per-person price, a fee), " +
  "and give the answer they asked for in full, every part counted (a per-person cost includes the sides, drinks and anything else it is meant to cover), " +
  "with where each figure came from. Looking up published prices never needs their yes; only contacting someone (an email, a call, a quote request) does, so offer that as one line at the end if it helps. ";

/** The notice for an answer that stops short: a job is told to finish; a chat turn may also hand it to a job. */
export function finishNotice({ job = false } = {}) {
  return (
    FINISH +
    (job
      ? "This is a background job, so take the steps it needs; update the note you wrote with the full figures. "
      : 'If it will take many steps, start a background job for it (send { action: "background" }) and tell them in one line you are on it. ') +
    "If a figure truly isn't published anywhere you can reach, say in one line where you looked and give your best estimate, marked as one. " +
    "If your answer wasn't stopping short of anything they asked, send it again as it was."
  );
}

/**
 * Whether a job's final answer leaves it unfinished, so the Worker runs
 * another turn rather than texting it as done. Its last turn texts what it
 * has, missing parts named.
 */
export function unfinishedJob(job, answer) {
  return job !== null && job !== undefined && job.attempt < MAX_JOB_ATTEMPTS && stopsShort(answer);
}
