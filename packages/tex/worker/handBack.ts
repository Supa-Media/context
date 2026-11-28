/**
 * A line a background job wrote that the person must see now: a sign-in code, or a link to sign in or approve
 * something at (Dev2, 2026-11-05: a computer job got two GitHub device codes and neither was texted;
 * `@supa products/tex/research/computer-job-signin-code-2026-11-24.md`, options A and B).
 *
 * A cloud job's progress line is texted when it holds a link (`jobRun.ts` `onProgress`), because that line is one the
 * model chose to send. What a computer's Claude Code or Codex says between its steps is its own narration, full of
 * links it read, so a link alone is not enough there: it must come with words that hand something to the person.
 * A code is always enough, since a job names one only to have it entered somewhere.
 *
 * Only ever a yes or no about the words: the line itself goes to the chat's coordinator turn as the job's report
 * (`jobTexts.ts`), which writes what is texted. Never logged: a code is a secret while it is valid.
 */

const LINK = /https?:\/\/\S+/i;
/** A device code as GitHub, Microsoft and most CLIs print it: two groups of four, upper case, with a digit in it. */
const DEVICE_CODE = /\b(?=[A-Z0-9]{4}-[A-Z0-9]{4}\b)(?=[A-Z-]{0,8}\d)[A-Z0-9]{4}-[A-Z0-9]{4}\b/;
/** "code", "one-time code", "PIN", "passcode", "OTP", then a short token with a digit, within a few words; never an exit or status code. */
const NAMED_CODE = /(?<!\b(?:exit|status|error|return|response|http|zip|area|country|source)[ -])\b(?:code|passcode|pin|otp)\b[^\n]{0,30}?\b(?=[A-Za-z0-9-]{0,16}\d)[A-Za-z0-9]{3,10}(?:-[A-Za-z0-9]{3,10})?\b/i;
/** Words that hand the link to the person: open it, sign in, approve, enter, authorize. */
const HANDS_OVER = /\b(?:sign(?:ing)?[ -]?in|log(?:ging)?[ -]?in|login|authori[sz]e|approve|verify|verification|enter|device|open (?:this|the link)|tap|waiting (?:for|on) (?:you|them|your|their))\b/i;

/** Whether the line hands the person something to do now: a sign-in code, or a link with words that hand it over. */
export function isHandBack(text: string): boolean {
  if (DEVICE_CODE.test(text) || NAMED_CODE.test(text)) return true;
  return LINK.test(text) && HANDS_OVER.test(text);
}

/** At most this many hand-backs are passed on from one part: a runaway narrator never floods the chat. */
export const MAX_HAND_BACKS = 3;
/** A hand-back is cut to this length: the code and its link are in its first lines. */
export const MAX_HAND_BACK = 600;
