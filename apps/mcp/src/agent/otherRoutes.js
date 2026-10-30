/**
 * WHEN ONE SOURCE FAILS, TEX TRIES THE OTHERS BEFORE IT ANSWERS (the owner,
 * 2026-10-23).
 *
 * The owner texted "but planning center works now? am I serving sunday?"
 * while every Planning Center read was failing. Tex answered "Planning
 * Center still isn't answering, so I can't tell you whether you're serving
 * Sunday yet ... Once it answers, I'll check your serving schedule and text
 * you what I find. You can also check it yourself in the Planning Center app
 * or at planningcenteronline.com." Planning Center had emailed the schedule
 * to their Gmail days before; another assistant found it there ("Stage
 * Manager 2 in Brooklyn this Sunday, October 25, with a 7:30am call and 10am
 * service") and texted it on its own. The owner: "be more like dot".
 *
 * Two things went wrong, and the gateway can see both for itself:
 *
 *   1. The answer gave up after one source failed, with the other roads to
 *      the same answer (their mail, which apps email, their calendar, their
 *      notes, the app's own website in the browser) never tried. An answer
 *      that says it can't tell them, on a turn where a call failed or the
 *      answer itself says a source is down, gets one more round naming the
 *      roads this turn didn't take. Once a turn, so it never loops.
 *   2. It promised to text them later, and nothing in the turn would: no
 *      routine was written and no job started, so the promise was air. That
 *      gets one more round telling Tex to write the routine that keeps it,
 *      checking the source and those roads, and answering in this chat once
 *      it can. A routine that answers what they asked is a reply, never
 *      texting first.
 *
 * Neither reads a tool's result: only the names of the calls the turn made,
 * whether each worked, and the answer's own words.
 */

/** The roads to an answer, by the calls that take them. */
export const ROUTES = {
  email: { tools: ["search_email", "read_email"], how: "search their email for what that app or service sends (search_email with from: its domain, e.g. from:planningcenteronline.com, plus a word or date from their question; then read the newest), since most apps email schedules, receipts and changes" },
  calendar: { tools: ["read_calendar"], how: "read their calendar for the day they asked about (fetch calendar:)" },
  notes: { tools: ["search", "search_notes", "read_note"], how: "search their notes" },
  browser: { tools: ["browse", "open_page", "search_web"], how: "open the app's own website in your browser (browse) and sign in with their saved login (fill_login)" },
};

/** "I can't tell you", "couldn't check", "no way to know": the answer gave up. */
const GAVE_UP = [
  /\b(?:can't|cannot|can not|couldn't|could not|am unable to|'m unable to|wasn't able to|was unable to|have no way to|no way to)\s+(?:yet\s+)?(?:tell|say|confirm|check|see|know|find out|get|look up|pull up|reach|read|load)\b/i,
  /\b(?:don't|do not)\s+(?:know|have)\s+(?:yet\s+)?(?:whether|if|that|your)\b/i,
];

/** "Planning Center still isn't answering", "the connection is failing": the answer says a source is down. */
const SOURCE_DOWN = [
  /\b(?:isn't|is not|wasn't|was not|aren't|are not|still isn't|still not)\s+(?:answering|responding|working|loading|connecting|connected|available|reachable|coming back)\b/i,
  /\b(?:is|was|are|keeps?|kept)\s+(?:down|failing|erroring|timing out|broken)\b/i,
  /\b(?:connection|app|server|api|integration)\s+(?:is\s+)?(?:failing|failed|down|erroring)\b/i,
];

const words = (answer) => String(answer ?? "").replace(/[‘’]/g, "'");

/** Whether an answer says it couldn't answer them. */
export function givesUp(answer) {
  const said = words(answer);
  return GAVE_UP.some((pattern) => pattern.test(said));
}

/** Whether an answer says one of its sources is down. */
export function saysSourceIsDown(answer) {
  const said = words(answer);
  return SOURCE_DOWN.some((pattern) => pattern.test(said));
}

/** The roads this turn never took, given the calls it made as `{ name, ok }`. */
export function untriedRoutes(steps = []) {
  const ran = new Set(steps.map((step) => step.name));
  return Object.keys(ROUTES).filter((route) => !ROUTES[route].tools.some((tool) => ran.has(tool)));
}

/** One more round, naming the roads not taken. */
export function otherRoutesNotice(untried) {
  const roads = untried.map((route) => ROUTES[route].how);
  return (
    "Before this goes: one source failed and your answer gives up, but there are other ways to the same answer you haven't tried this turn. " +
    `Try them now: ${roads.join("; ")}. ` +
    "Then answer with the best you found and say where you read it (\"from Planning Center's email of Oct 20\"), and say plainly if it could be out of date. " +
    "Never tell them to check it themselves while one of those ways is untried. " +
    "Only if every way failed, say in one line what you tried, and write a routine that texts them the answer in this chat once the source works again. " +
    "If your answer wasn't giving up on their question, send it again as it was."
  );
}

/**
 * "Once it answers, I'll check your serving schedule and text you what I find." A word may carry a
 * clock time: "I'll check the log at 4:30 and text you" (a tester's chat, 2026-10-27) slipped past while
 * words were letters only.
 */
const PROMISE =
  /\b(?:I'll|I will|I'm going to|I am going to)\s+(?:[\w'’,:]+\s+){0,8}?(?:text|message|ping|tell|let|get back to|update|circle back to)\s+you\b/i;
/**
 * "I'll send the organized breakdown … within the next 10–15 minutes" (2026-10-24): a promise of work by a
 * time, with no "text you" in it. Tex had started nothing, and said so only when asked what 医保 meant.
 */
const TIMED_PROMISE =
  /\b(?:I'll|I will|I'm going to|I am going to)\b[^.!?\n]{0,240}?\b(?:within|in)(?:\s+(?:the next|the|about|around))?\s+(?:\d+|a few|a couple of)(?:\s*(?:-|\u2013|to)\s*\d+)?\s*(?:minutes?|mins?|hours?|hrs?)\b/i;
/**
 * "I'll keep trying every hour through Monday" (a tester's chat, 2026-10-25): a promise
 * to retry on a schedule, which nothing in the turn had set up.
 */
const RETRY_PROMISE =
  /\b(?:I'll|I will|I'm going to|I am going to)\s+(?:keep\s+(?:trying|retrying|checking|at it)|(?:try|retry|check)(?:\s+(?:it|that|this))?\s+again\b[^.!?\n]{0,80}?\b(?:later|tomorrow|tonight|every|each|hourly|until|through)\b|(?:try|retry|check)\b[^.!?\n]{0,80}?\b(?:every|each)\s+(?:\d+\s+|few\s+)?(?:minutes?|hours?|days?|morning|night)\b)/i;
/**
 * A check-in at a set time: "I'll check with you tonight" (a tester's chat, 2026-10-26), "I'll check the log
 * at 4:30" (2026-10-27). Neither says "text you", and in both Tex set nothing to come back.
 */
const AT_A_TIME =
  /\b(?:at\s+\d{1,2}(?::\d{2})?\s*(?:am|pm|a\.m|p\.m)?(?!\s*%)|tonight|tomorrow(?!['’]s)|this\s+(?:morning|afternoon|evening)|later\s+(?:today|tonight|on|this)|in\s+the\s+(?:morning|afternoon|evening)|on\s+(?:mon|tues|wednes|thurs|fri|satur|sun)day|by\s+(?:\d{1,2}(?::\d{2})?|noon|end of (?:the )?day|tonight|tomorrow)|end of (?:the )?day|after (?:lunch|dinner|work|your meeting))\b/i;
const CHECK_IN_PROMISE =
  /\b(?:I'll|I will|I'm going to|I am going to)\s+(?:[\w'’,:]+\s+){0,4}?(?:(?:text|message|ping|call)\s+you|check\s+(?:in|back|on|with\s+you)|follow\s+up|remind\s+you|ask\s+you|circle\s+back|come\s+back\s+to\s+you|reach\s+out|check|look|review|confirm|see\s+(?:how|if|whether))\b/i;
/** A later that's theirs or Tex's in-turn work: "once you say yes", "when you're back". */
const THEIR_LATER = /\b(?:once|when|after|if)\s+you\b|\byes\b|\u{1F44D}/iu;

const sentences = (answer) => words(answer).split(/\n+|(?<=[.!?])\s+(?=[A-Z0-9"“(])/);

/** Whether a sentence promises a check-in at a set time: a reminder for that time keeps it. */
const checksInAt = (sentence) => CHECK_IN_PROMISE.test(sentence) && AT_A_TIME.test(sentence) && !THEIR_LATER.test(sentence);

/** Whether an answer promises to text them later about something. */
export function promisesLater(answer) {
  return sentences(answer).some(
    (sentence) => ((PROMISE.test(sentence) || TIMED_PROMISE.test(sentence) || RETRY_PROMISE.test(sentence)) && !THEIR_LATER.test(sentence)) || checksInAt(sentence),
  );
}

/** Whether an answer promises a check-in at a set time ("tonight", "at 4:30"). */
export function promisesCheckInAt(answer) {
  return sentences(answer).some(checksInAt);
}

/** The calls that keep a promise to text later: a job, a delegated job, or a routine written. */
export const KEEPS_A_PROMISE = new Set(["start_background_job", "delegate", "steer_background_job"]);

export const LATER_NOTICE =
  "Before this goes: your answer promises to text them later, but nothing in this turn will. " +
  "Keep it now: write a routine note under tex/routines/hourly/ (never more often) with `until:` in its front matter naming what answers their question, " +
  "whose body says to try the source again and the other ways to the answer (their email from that app, their calendar, their notes, the app's website in your browser), " +
  "text them the answer in this chat with where it came from once it has one, and answer SKIP until then. Or start a background job if it is long work happening now. " +
  "Then send your answer, saying when you'll check. If the promise was about something already running, send your answer again as it was. " +
  // 2026-10-29: a count blocked on a sign-in only the person could finish became an hourly check nobody asked for.
  "But if they didn't ask to be told later, or nothing can change until they do something (a sign-in, a code, an approval, access only they can give), set nothing: " +
  "take the promise out and say plainly what is in the way.";

/** A check-in promised for a set time: a one-off reminder at that time keeps it, or the promise goes. */
export const CHECK_IN_NOTICE =
  "Before this goes: your answer promises to check in with them at a set time, but nothing in this turn will. " +
  "Keep it now: write a one-off routine note under tex/routines/once/ with `at:` in its front matter set to that date and time in their local time " +
  "(\"tonight\" with no hour is 8:00 pm, \"tomorrow\" with no hour is 9:00 am), whose body says what to check and what to ask them, so it texts them then in this chat. " +
  "Then send your answer, saying when you'll check. If a routine you can see already does it, send your answer again as it was. If you can't set it, take the promise out of your answer rather than send one nothing keeps.";

/** The notice for a promise nothing in the turn keeps, or null when the answer makes none. */
export function laterNotice(answer) {
  if (promisesCheckInAt(answer)) return CHECK_IN_NOTICE;
  return promisesLater(answer) ? LATER_NOTICE : null;
}
