/**
 * AN ANSWER THAT SAYS IT IS STILL THERE NEEDS A LOOK IN THIS TURN (2026-11-19).
 *
 * A live 1:1 right-panel chat (the console client, the front door) was asked
 * to save a Gmail reply as a draft and not send it. Tex ran no tool and
 * answered "I already did this at 1:31 PM. … The reply is saved as a Gmail
 * draft in …. Nothing was sent." The earlier draft had been deleted. The
 * prompt tells it to trust its earlier answers, and the front door runs no
 * answer check, so the words went out as they were.
 *
 * This is a narrow code check, at most once a turn, like `untriedWeb.js`.
 * It reads the final answer for a claim that something is already done or
 * still in place (saved, sent, drafted, booked), and looks at the turn's own
 * calls: a turn that wrote, sent, held or looked at the thing says nothing.
 * A notes search is not a look at a draft or a calendar. A claim with no
 * call behind it gets one round to look or to do it again. The gateway never
 * writes on the model's behalf.
 */

import { offersAHeldChange } from "./claimCheck.js";

export const STANDS_NOTICE =
  "Before this goes: your answer says something is done, already done or still in place (saved, sent, drafted, booked), but nothing in this turn did it or looked at it. " +
  "An earlier answer was true when it was said; a draft can be deleted, an email sent or an event moved since. " +
  "If they asked for it again, do it again now with your tools, or look first (search their drafts, their sent mail or their calendar) and do it if it is gone, then answer from what this turn's calls returned. " +
  "Never say it is done or still there unless a call in this turn shows it.";

const ALREADY = [
  /\b(?:I|I['’]ve|I have|we|we['’]ve)\s+already\s+(?:did|done|made|saved|sent|drafted|created|booked|added|scheduled|put|set up|took care|handled|replied|emailed)\b/i,
  /\balready\s+(?:did|done)\s+(?:this|that|it)\b/i,
  /\b(?:this|that|it)(?:['’]s| is| was)\s+already\s+(?:done|saved|sent|drafted|booked|in)\b/i,
];
const STILL_THERE = [
  /\b(?:is|are|was|['’]s)\s+(?:already\s+|still\s+)?saved\s+(?:as|in|to)\s+(?:a\s+|your\s+|the\s+)?(?:gmail\s+)?drafts?\b/i,
  /\bsaved\s+(?:as|in|to)\s+(?:a\s+|your\s+)?(?:gmail\s+)?drafts?\b/i,
  /\b(?:still|already|is|are|['’]s)\s+(?:sitting|waiting)\s+in\s+(?:your\s+)?(?:gmail\s+)?(?:drafts|inbox|outbox|calendar)\b/i,
];
// Said of an email, a draft or an event, these claim it still stands; said of a note, a write in the turn backs them.
const STILL_IN_PLACE = /\b(?:is|are)\s+still\s+(?:there|in your|on your|saved|scheduled|booked|unsent)\b/i;
const NOTHING_SENT = /\bnothing\s+(?:was|has been|got)\s+sent\b(?!\s+yet)/i;
const FIRST_PERSON_DONE = /\bI(?:['’]ve| have)?\s+(?:just\s+)?(?:saved|sent|drafted|booked|scheduled|emailed)\b/i;
const WORLD_THING = /\b(?:drafts?|e-?mails?|gmail|inbox|messages?|repl(?:y|ies)|invites?|invitations?|events?|calendar|meetings?|bookings?)\b/i;
const NOT_DONE = /\b(?:couldn['’]?t|could not|can['’]?t|cannot|wasn['’]?t able|unable|not (?:saved|sent|done)|didn['’]?t (?:save|send))\b/i;
const THUMBS_ASK = /\b(?:reply|send|text)\s+👍|👍\s+(?:to|and)\b/;

// The note writes too: "I saved it to your notes" after a write that went through is true.
const ACTION = new Set(["send_email", "save_email_draft", "calendar_event", "slack_api", "app_change", "mail_agent", "send", "write", "write_note", "write_notes", "manage"]);
const CHECK = new Set(["search_email", "read_email", "read_calendar", "mail_check"]);
// Whole words, so a notes search for "present" or a fetch of a "mailchimp" page is not a look at their mail.
const LOOKS_AT_MAIL_OR_CALENDAR = /\b(?:e?mails?|drafts?|gmail|inbox|calendar|events?|sent)\b/i;

/** One call's step, as `wrap` records it: its name, whether it ran, and the action or held flag when it has them. */
export function stepOf(name, args, result) {
  return {
    name,
    ok: result?.isError !== true,
    ...(typeof args?.action === "string" ? { action: args.action } : {}),
    ...(result?.held === true ? { held: true } : {}),
    ...(name === "search" || name === "fetch" ? { args: args ?? {} } : {}),
  };
}

/** Whether the answer says something is already done or still in place, in its own words. */
export function claimsItStands(answer) {
  const said = String(answer ?? "");
  const sentences = said.split(/(?<=[.!?])\s+|\n+/).map((sentence) => sentence.trim()).filter((sentence) => sentence !== "" && !sentence.endsWith("?"));
  const already = sentences.some((sentence) => ALREADY.some((pattern) => pattern.test(sentence)));
  if (already) return true; // "I already did this" stands as a claim whatever else the answer says
  if (NOT_DONE.test(said)) return false; // an answer saying it is not done claims nothing
  // A preview still asking for their yes or 👍 is not a claim, and neither is an offer of a held change.
  if (!already && (offersAHeldChange(said) || THUMBS_ASK.test(said))) return false;
  return sentences.some((sentence) => [...ALREADY, ...STILL_THERE, NOTHING_SENT].some((pattern) => pattern.test(sentence)) || ((FIRST_PERSON_DONE.test(sentence) || STILL_IN_PLACE.test(sentence)) && WORLD_THING.test(sentence)));
}

/** Whether this turn's calls did, held or looked at the thing: a write that went through, a held change, or a mail or calendar read. */
export function checkedThisTurn(steps) {
  return (Array.isArray(steps) ? steps : []).some((step) => {
    if (step?.held === true) return true;
    if (step?.ok !== true) return false;
    const name = String(step.name ?? "");
    if (ACTION.has(name) || CHECK.has(name)) return true;
    return (name === "search" || name === "fetch") && LOOKS_AT_MAIL_OR_CALENDAR.test(JSON.stringify(step.args ?? {}));
  });
}

/** The notice when the answer claims a state this turn did not check (`claimsItStands`, `checkedThisTurn`); null otherwise. */
export function standsNotice(answer, steps) {
  return claimsItStands(answer) && !checkedThisTurn(steps) ? STANDS_NOTICE : null;
}

/** `{ wrap, wrapWeb, check }`, shaped like `untriedWebCheck`'s, for a console 1:1 (`frontDoorChecks`). */
export function standsCheck() {
  let noticed = false;
  const steps = [];
  return {
    /** The turn's own tools, so a write or a look is visible to the check. */
    wrap(callTool) {
      return async (name, args) => {
        const result = await callTool(name, args);
        steps.push(stepOf(name, args, result));
        return result;
      };
    },
    wrapWeb(web) {
      return web ?? null;
    },
    check(answer) {
      if (noticed) return null;
      const notice = standsNotice(answer, steps);
      if (notice !== null) noticed = true;
      return notice;
    },
  };
}
