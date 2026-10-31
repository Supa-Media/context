/**
 * A JOB THAT ENDS SAYING IT IS STILL WORKING (a tester's 1:1 chat,
 * 2026-10-31). Asked to fill in a job-site profile, a background job ran for
 * forty seconds and ended its turn on "I'm filling in the profile from your
 * resume, and I'll text you each answer before anything goes in". A job's
 * answer is its last word: when its turn ends, nothing of it is running, so
 * that sentence promised work nobody would do. The Worker marked the job
 * done, the chat's own turn passed the promise on as "still filling it in"
 * for twenty minutes, and then said it couldn't see what the job had done.
 *
 * So for a job's turn only (a chat turn may say "on it" beside a job it
 * started):
 *
 * - An answer that says the job's own work is still going ("I'm filling in",
 *   "still working on it") or promises to text them more of its results
 *   later ("I'll text you each answer") is not a report. The claim check
 *   (`claimCheck.js`, through `announcesNextStep`) sends it back once, with
 *   `STILL_WORKING_NOTICE`, and the Worker gives a job that still ends that
 *   way another part (`unfinishedJob`).
 * - A job's last part that still ends that way is reported as ended without
 *   finishing (`incomplete`, `jobEnded` in `background.js`), never as done,
 *   so the coordinator and the live view both see it stopped.
 *
 * Phrases only, as `stopsShort.js` is.
 */

/** The job's own work, named as still going on: "I'm filling in", "still working on it", "in progress". */
const GOING_ON = [
  /\b(?:I'm|I am|I've been|I have been)\s+(?:still\s+|now\s+|currently\s+|busy\s+)?(?:filling(?:\s+(?:in|out))?|working(?:\s+(?:on|through))?|going\s+through|finishing|completing|doing|putting\s+together|pulling\s+together|drafting|writing\s+up|applying|signing\s+(?:you\s+)?up|setting\s+(?:it\s+|you\s+)?up|entering|answering|uploading|submitting|searching|researching|gathering|compiling|building|preparing)\b/i,
  /\bstill\s+(?:filling|working|going\s+through|going|at\s+it|on\s+it|in\s+progress|running|processing|finishing|drafting|searching|researching)\b/i,
  /\b(?:is|are|it's)\s+(?:still\s+)?(?:in\s+progress|underway|under\s+way)\b/i,
  /\b(?:I'm|I am)\s+on\s+(?:it|the\s+[\w\s-]{1,30}?\s+(?:step|page|section|screen|part))\b/i,
];

/** A promise to send more of its results later: "I'll text you each answer", "I'll report back", "I'll let you know once it's done". */
const MORE_LATER =
  /\b(?:I'll|I will|I'm going to|I am going to)\s+(?:[\w'-]+\s+){0,2}?(?:text|send|message|ping|show|update|report\s+back|get\s+back|let\s+you\s+know|keep\s+you\s+posted)\b[^.!?\n]{0,60}?\b(?:each|every|as\s+I|as\s+(?:it|they|soon\s+as)|once\s+(?:I|it|that|they|the)|when\s+(?:I|it|that|they|the|I'm|it's)|the\s+(?:answers?|rest|results?|draft|details)|with\s+(?:the|each|every)|before\s+(?:anything|I|it)|back\b|posted\b)/i;

function said(answer) {
  return String(answer ?? "").replace(/[‘’]/g, "'");
}

/** A promise kept by something set up to run later: a routine, a reminder, a repeating check. */
const KEPT_LATER = /\b(?:routines?|reminders?|every\s+(?:day|morning|evening|night|hour|week|month)|daily|weekly|hourly)\b/i;

const sentences = (words) => words.split(/\n+|(?<=[.!?])\s+/);

/** Whether a job's answer says its own work is still going, or promises more of it later, instead of reporting what it did. */
export function stillWorking(answer) {
  return sentences(said(answer)).some(
    (sentence) => !KEPT_LATER.test(sentence) && (GOING_ON.some((pattern) => pattern.test(sentence)) || MORE_LATER.test(sentence)),
  );
}

export const STILL_WORKING_NOTICE =
  "Before this goes: this answer is the job's last word, and it says the work is still going or that you'll text them more of it later. " +
  "When this turn ends nothing of the job is running, so nobody would do that work or send those texts. Do the work now: open the browser or the notes again " +
  "and carry the task through to its end (everything that needs their yes waits for it: fill everything in, then stop at the button that sends it). " +
  "Then report plainly what you actually did: every answer or field you filled in, word for word, where it is (the page, the note's link), " +
  "what is waiting for their yes, and anything you couldn't do and why. Never say you are still working, or that you will text them later. ";
