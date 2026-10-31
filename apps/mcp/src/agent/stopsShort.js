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
import { STILL_WORKING_NOTICE, stillWorking } from "./stillWorking.js";

const LOOKING = String.raw`(?:priced|costed|checked|confirmed|compared|researched|verified|totalled|totaled|looked (?:up|into|at))`;

/** It says a piece of what was asked is still missing, or names its own next step. */
const SHORT = [
  /\bnext steps? (?:is|are|would be|will be|from here is)\s+(?:to\s+)?(?:price|pricing|cost|costing|check|checking|compare|comparing|research|researching|look|looking|find|finding|get|getting|confirm|confirming|call|calling|ask|asking|reach|reaching)\b/i,
  new RegExp(String.raw`(?:\bnot|n't)\s+(?:been\s+|yet\s+)?${LOOKING}\s+(?:\w+\s+){0,3}?yet\b`, "i"),
  new RegExp(String.raw`(?:\bnot|n't)\s+(?:been\s+)?yet\s+${LOOKING}\b`, "i"),
  /\bno (?:price|prices|pricing|cost|costs|quote|quotes|figure|figures|total|totals) (?:\w+\s+){0,3}?yet\b/i,
  new RegExp(String.raw`\b(?:I|we) (?:haven't|have not|didn't|did not) (?:yet\s+)?(?:priced|costed|checked|compared|researched|looked (?:up|into)|found prices for)\b`, "i"),
  // "I'd still need to look up the rest: two more Manhattan venues" (guest group chat, 2026-10-27).
  /\b(?:I|we)(?:'d| would)? (?:still )?(?:need|have) to (?:price|cost|check|compare|research|look up|look into|look for|find)\b/i,
  /\bstill (?:needs?|has|have) to be (?:priced|costed|checked|compared|researched|looked up)\b/i,
  // A figure given up on because one page lacked it (bench gh-112: "Seoul Box: no prices listed").
  /\bno (?:[A-Z][\w']*\s+){0,3}(?:prices?|pricing|menu prices|hours) (?:are |is )?(?:listed|posted|published|shown|online|to give)\b|\bno menu with prices\b/i,
  /\b(?:prices?|pricing|hours) (?:(?:are|is) not|aren't|isn't|not) (?:listed|posted|published|shown|online)\b/i,
  /\bisn't (?:confirmed|priced|known) yet\b|\b(?:full|total) [^.?!\n]{0,40}\b(?:isn't|is not|aren't|are not) (?:confirmed|priced|known|covered)\b/i,
];

/** It offers, or plans, the looking or writing it was asked to do instead of doing it. */
const OFFERS_MORE = [
  // "... if you want", or held for a pick: "I can look up hours for one you pick" (Dev2's 1:1, 2026-10-26).
  /\bI can (?:also )?(?:write (?:these|this|them|it|that) up|look (?:into|up)|dig (?:into|up|deeper|further)|price|research|find|compare|get (?:prices|quotes?|numbers)|check (?:prices|menus|hours|reviews))\b[^.?!\n]{0,100}(?:\bif (?:you|y'all|you all)(?:'d)? (?:want|like)\b|\b(?:you|y'all) (?:pick|choose)\b)/i,
  /\b(?:want|would you like) me to (?:look (?:into|up)|dig|price|research|find (?:prices|out)|compare|check (?:prices|menus|hours|reviews)|write (?:these|this|them|it) up)\b/i,
  /\bI(?:'d| would) (?:try to |next |then |start by |want to )?(?:get (?:a )?quotes?|look up|price|research|compare (?:prices|quotes))\b/i,
  /\blet me know if you(?:'d)? (?:want|like) me to (?:look|dig|price|research|find|compare|check)\b/i,
  // Options dropped and not replaced: "Want me to find two more that no church uses on Sundays, to make five again?"
  /\b(?:(?:want|would you like) me to|I can|I could|shall I|should I) (?:also )?(?:find|look for|dig up|track down) (?:you )?(?:\w+\s+){0,2}?(?:more|others|another)\b/i,
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
  "Before this goes: your answer stops short of what they asked. It says part of it is still missing, names a next step, offers to look further, or gives fewer options than they asked for, " +
  "and that looking is yours to do. Do it now: search_web, open the pages that have the figures (a menu, a price list, opening hours, a per-person price, a fee), " +
  "and give the answer they asked for in full, every part counted (a per-person cost includes the sides, drinks and anything else it is meant to cover), " +
  "as many options as they asked for (each one you dropped replaced by another that fits), " +
  "with where each figure came from. Looking up published prices never needs their yes; only contacting someone (an email, a call, a quote request) does, so offer that as one line at the end if it helps. ";

/** The notice for an answer that stops short: a job is told to finish; a chat turn may also hand it to a job. */
export function finishNotice({ job = false, answer = "" } = {}) {
  // A job ending on "I'm still filling it in" has no research left short: it has the whole task left (`stillWorking.js`).
  if (job && stillWorking(answer)) return STILL_WORKING_NOTICE + "If it was already finished and reported in full, send it again as it was.";
  return (
    FINISH +
    (job
      ? "This is a background job, so take the steps it needs; update the note you wrote with the full figures. "
      : 'If it will take many steps, start a background job for it (send { action: "background" }) and tell them in one line you are on it. ') +
    "A list page without the figure is not where it lives: open each place's own page, or search the place by name, for every place you name, not one they pick. " +
    "If a figure truly isn't published anywhere you can reach, say in one line where you looked and give your best estimate, marked as one. " +
    "If your answer wasn't stopping short of anything they asked, send it again as it was."
  );
}

/*
  FEWER OPTIONS THAN ASKED (self-review 9d98ef, a guest group chat,
  2026-10-27). Asked to "compare 5 different venue options in manhattan",
  Tex dropped two that churches already meet in on Sundays and answered
  "That leaves three venues". Asked for a number, the answer that says it has
  fewer has stopped short as surely as one with a figure missing.
*/
const COUNT = String.raw`(\d{1,2}|one|two|three|four|five|six|seven|eight|nine|ten|twelve|fifteen|twenty)`;
const THINGS = String.raw`(?:options?|venues?|places?|spots?|spaces?|halls?|rooms?|caterers?|restaurants?|hotels?|vendors?|ideas?|choices|picks|candidates|churches|schools|shops?|stores?)`;
const ASKED_COUNT = new RegExp(String.raw`\b${COUNT}\s+(?:[\w'-]+\s+){0,3}?${THINGS}\b`, "i");
const HAS_COUNT = new RegExp(
  String.raw`\b(?:(?:that|which|this) )?leaves? (?:me |us |you )?(?:with )?(?:only |just )?${COUNT} (?:[\w'-]+\s+){0,2}?${THINGS}\b|\b(?:I )?(?:only |just )?found (?:only |just )?${COUNT} ${THINGS}|\bonly ${COUNT} (?:[\w'-]+\s+){0,2}?${THINGS}\b`,
  "i",
);
const NUMBER_WORDS = { one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8, nine: 9, ten: 10, twelve: 12, fifteen: 15, twenty: 20 };

function countOf(word) {
  const n = Number(word);
  return Number.isInteger(n) ? n : (NUMBER_WORDS[String(word).toLowerCase()] ?? null);
}

/** Whether they asked for a number of options and the answer says it is left with fewer. */
export function fewerThanAsked(answer, question = "") {
  const asked = said(question).match(ASKED_COUNT);
  const left = said(answer).match(HAS_COUNT);
  if (!asked || !left) return false;
  const want = countOf(asked[1]);
  const have = countOf(left.slice(1).find((group) => group !== undefined));
  return want !== null && have !== null && have < want;
}

/*
  A JOB THAT ENDS ON ITS OWN NEXT STEP (the owner's review, 2026-10-26). A
  booking job texted "I still can't finish ... Next I'll reload the checkout,
  fill in the passenger details, and then ask you to allow the Chase card",
  and stopped: the next step it named was its own to take. A job's answer
  that names what it will do next has not done it.
*/
const NEXT_STEP = /(?:^|[.!?]\s+|\n)(?:so\s+)?next,?\s+I(?:'ll| will| am going to|'m going to)\s+(?!text|let you know|tell you|send you)/i;

/** Whether a job's answer names the next thing it will do, or says it is still doing it (`stillWorking.js`), rather than doing it. */
export function announcesNextStep(answer) {
  return NEXT_STEP.test(said(answer)) || stillWorking(answer);
}

/**
 * Whether a job's final answer leaves it unfinished, so the Worker runs
 * another turn rather than texting it as done. Its last turn texts what it
 * has, missing parts named.
 */
export function unfinishedJob(job, answer) {
  return job !== null && job !== undefined && job.attempt < MAX_JOB_ATTEMPTS && (stopsShort(answer) || announcesNextStep(answer));
}

/*
  A pick made for them, with the choice that changes the search left as an
  aside: "I'd cook it ... If you'd rather have it catered, tell me which
  town", "... which town is it in?", "Catering's the other option if you'd
  rather not cook" (hand-back bench case 9, gh-94 to gh-98, 2026-10-26,
  after the prompt already said to ask first). Asked for options, an answer
  that offers the other road with "if you'd rather" has guessed the brief:
  the open question is the whole reply until they answer it.
*/
const WANTS_OPTIONS = /\b(?:options?|ideas?|suggest(?:ions?)?|recommend(?:ations?)?|choices)\b|\b(?:find|research|pick|choose)\b[^.?!\n]{0,40}\b(?:for|places?|spots?|caterers?|restaurants?)\b/i;
const OTHER_ROAD = /\bif you(?:'d| would) rather\b|\bthe other option\b|\bor I can (?:look|find|search|price)\b/i;
// gh-107: cooking costed from grocery prices, never asked, then "which store do you shop at?".
const COOKED = /\b(?:I'd cook|cook it|grocer(?:y|ies)|recipes?|home-?cooked)\b/i;
const ASKED_TO_COOK = /\b(?:cook|recipe|make|grocer|bake)/i;

/** Whether an answer to a request for options guesses the brief: the other road left as an aside, or cooking nobody asked for. */
export function picksBeforeAsking(answer, question = "") {
  const words = said(answer);
  if (!WANTS_OPTIONS.test(said(question))) return false;
  return OTHER_ROAD.test(words) || (COOKED.test(words) && !ASKED_TO_COOK.test(said(question)));
}

export const ASK_FIRST_NOTICE =
  "Before this goes: your answer picks for them, then leaves the choice that changes the whole search (\"if you'd rather ...\") as an aside. " +
  "Send only the question that settles it, in one line, with no options or pick of your own; once they answer, find and price the options for what they chose. " +
  "If your answer wasn't picking before asking, send it again as it was.";
