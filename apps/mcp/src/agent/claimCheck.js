/**
 * A TEXTED ANSWER IS CHECKED AGAINST WHAT THE TURN DID, ONCE, BEFORE IT GOES
 * (the owner, 2026-10-21).
 *
 * On 2026-10-21 Tex told the owner "It's on your to-do list now, at the top
 * under this week", and two texts later "I can't confirm I added it". Earlier
 * in the same chat the owner texted "never message me about github stuff
 * unless i ask" and Tex answered "Will do." with nothing written, so the next
 * check-in had nothing to honour. Both are words that say a change was made
 * when no change went through.
 *
 * So the turn's calls are watched (`wrap`), and its final answer is read
 * (`check`) for two things the gateway can tell for itself:
 *
 *   1. The answer says it added, saved or put something somewhere, and no
 *      write in this turn succeeded.
 *   2. Their text asks never to be texted about something unless they ask,
 *      and nothing in this turn changed `tex/attention.md` or
 *      `tex/heartbeat.md`, where that wish is kept (`checkIns.js`).
 *   3. The answer offers, in its own words, a calendar change or an email
 *      ("Want me to add 'Emmanuela/Sayo,' 7 to 8 pm today?") and nothing was
 *      held. Their yes to that reached a model, which only then raised the
 *      hold, and they were asked a second time (the owner, 2026-10-21: "This
 *      is annoying. why does this happen?"). The hold is raised with the
 *      offer instead, so the yes they give is the one that makes it. The same
 *      day, after that shipped, Tex texted its own preview of a forward ("To:
 *      … Forward of: …  Say yes and I'll send it.") with no question mark and
 *      nothing held; the owner's 👍 and "yes" on it only raised the hold, and
 *      they were asked a third time ("do you see how this is frustrating").
 *      So a preview in its own words, or a request for their yes or 👍 about
 *      an email, a calendar change or a bug report, counts as an offer too.
 *
 * Any one sends the model one more round with a notice saying what is
 * missing (`turn.js` `answerCheck`): it does the change, or says plainly that
 * it has not. The notice is given once a turn, so a check can never loop, and
 * the gateway never writes on the model's behalf: what is kept is still
 * written by a call the person's dispatcher allowed.
 */

import { toolDefinitions } from "../tools/registry.js";
import { ATTENTION_SETTINGS_PATH, HEARTBEAT_SETTINGS_PATH } from "./checkIns.js";

/** Words that say a change to their notes, list or calendar was made. */
const CLAIMS = [
  /\b(?:it'?s|that'?s|this is|they'?re)\s+(?:now\s+)?(?:on|in)\s+(?:your|the)\s+(?:to-?do|list|calendar|notes?)\b/i,
  /\bI(?:'ve| have)?\s+(?:just\s+|now\s+|also\s+)?(?:added|saved|noted|logged|put|written down|wrote down|scheduled|updated|muted)\b/i,
  /\b(?:added|saved|put)\s+(?:it|that|this|them)\s+(?:to|on|in(?:to)?)\s+your\b/i,
];

/** "never message me about github stuff unless i ask", "stop texting me about deploys", "no more pings about CI". */
const MUTE_ASK =
  /\b(?:never|don'?t|do not|stop|no more|quit)\b[^.?!\n]{0,40}?\b(?:messag|text|ping|bother|notify|notif|tell|updat|alert)\w*\b[^.?!\n]{0,25}?\babout\b/i;

/*
  An offer to make a change only a yes may make: a question to them about
  adding, moving or cancelling something at a day or time or on their
  calendar, or about sending, forwarding or replying to an email.
*/
const OFFER = /\b(?:want me to|shall I|should I|do you want me to|would you like me to|ok(?:ay)? (?:if I|to))\b([^?]{0,200})\?/gi;
const CALENDAR_CHANGE = /\b(?:add|put|schedule|book|block|move|reschedule|cancel)\b/i;
const WHEN =
  /\b(?:calendar|today|tonight|tomorrow|monday|tuesday|wednesday|thursday|friday|saturday|sunday|\d{1,2}(?::\d{2})?\s*(?:am|pm)|\d{1,2}(?::\d{2})?\s*(?:to|-|\u2013)\s*\d{1,2})\b/i;
/** Their own list or notes, which take no yes: "add a to-do for Friday". */
const NOT_CALENDAR = /\b(?:to-?dos?|list|notes?|reminders?)\b/i;
const EMAIL_SEND = /\b(?:email|e-mail|forward|reply to|write back|file (?:a|the|it|that)|send (?:it|that|this|the (?:email|reply|note)|(?:an? )?(?:email|reply))|send \w+ (?:an? )?(?:email|note|reply))\b/i;

/** An email laid out in the answer's own words: "To: …", "Subject: …", "Forward of: …". */
const PREVIEW_LINE = /^\s*(?:to|cc|subject|forward(?:ing)? of|fwd)\s*:/im;
/** Asking for their yes or 👍 in the answer's own words. */
const YES_ASK = /\b(?:say|reply|text|answer)\s+(?:yes|ok)\b|\u{1F44D}/iu;
/** What a yes or 👍 might be asked about that only a held call can make. */
const HELD_THING = /\b(?:send|email|forward|calendar|schedule|book|file|bug|report|slack|dm|post)\b/i;
/**
 * A Slack message offered in the answer's own words (2026-10-22: "I'd DM Jo
 * on Acme Slack: …", with nothing held, so the 👍 on it reached nothing).
 */
const SLACK_OFFER =
  /\b(?:I['’]d|I would|I['’]ll|I will|want me to|shall I|should I|do you want me to)\s+(?:DM|message|post|send|reply)\b[^\n]{0,160}?\b(?:Slack|DM)\b/i;

export const OFFER_NOTICE =
  "Before this goes: you showed or offered, in your own words, an email, a Slack message, a calendar change or a bug report, and nothing is held for their yes. " +
  "A yes or 👍 to your words alone makes nothing, and they would be asked again. If that is what you offered and you know what it is, " +
  "make the call now (send_email, slack_api, calendar_event or report_problem) with exactly that: they are shown it with your answer, and their one yes or 👍 makes it. " +
  "Don't write out the email or ask for their yes yourself; the gateway does. " +
  "If something is missing, ask only for that. If you offered something else, send your answer again as it was.";

export const CLAIM_NOTICE =
  "Before this goes: your answer says something was added or saved, but no change to their notes went through in this turn. " +
  "If they asked for it, make the change now with your tools and then answer. If you can't, answer again saying plainly that it is not done, " +
  "and never say a change is made unless a call for it succeeded.";

export const MUTE_NOTICE =
  `Before this goes: they asked not to be texted about something unless they ask, and nothing was kept. Add the plain words such texts ` +
  `would say (for "github stuff": github) to \`mute:\` in the front matter of ${ATTENTION_SETTINGS_PATH} now, creating it if it is missing; ` +
  "that also silences your own check-ins. " +
  "Then say in a few words what you muted, never just \"Will do.\"";

/** Whether an answer says a change was made. */
export function claimsAChange(answer) {
  const said = String(answer ?? "");
  return CLAIMS.some((pattern) => pattern.test(said));
}

/** Whether an answer offers a calendar change, an email or a bug report: as a question, a preview, or a request for their yes. */
export function offersAHeldChange(answer) {
  const said = String(answer ?? "");
  if (PREVIEW_LINE.test(said) || SLACK_OFFER.test(said)) return true;
  if (YES_ASK.test(said) && HELD_THING.test(said)) return true;
  for (const [, offered] of said.matchAll(OFFER)) {
    if ((CALENDAR_CHANGE.test(offered) && WHEN.test(offered) && (/\bcalendar\b/i.test(offered) || !NOT_CALENDAR.test(offered))) || EMAIL_SEND.test(offered)) return true;
  }
  return false;
}

/** Whether their text asks never to be texted about something. */
export function asksToMute(question) {
  return MUTE_ASK.test(String(question ?? ""));
}

function isWrite(name) {
  const tool = toolDefinitions().find((entry) => entry.name === name);
  return tool !== undefined && tool.annotations?.readOnlyHint !== true;
}

const KEPT_WISHES = new Set([ATTENTION_SETTINGS_PATH, HEARTBEAT_SETTINGS_PATH]);

/**
 * The watcher for one texted turn: `wrap` the turn's dispatcher, then pass
 * `check` to `runTurn` as `answerCheck`. `check` answers a notice, at most
 * once, or null to let the answer go.
 */
export function claimCheck({ question }) {
  let wrote = false;
  let keptWish = false;
  let held = false;
  let noticed = false;
  return {
    wrap(callTool) {
      return async (name, args) => {
        const result = await callTool(name, args);
        if (result?.held === true) held = true;
        if (result?.isError !== true && isWrite(name)) {
          wrote = true;
          const path = typeof args?.path === "string" ? args.path.trim().replace(/^\/+/, "").toLowerCase() : "";
          if (KEPT_WISHES.has(path)) keptWish = true;
        }
        return result;
      };
    },
    check(answer) {
      if (noticed) return null;
      const notice =
        asksToMute(question) && !keptWish
          ? MUTE_NOTICE
          : claimsAChange(answer) && !wrote
            ? CLAIM_NOTICE
            : offersAHeldChange(answer) && !held
              ? OFFER_NOTICE
              : null;
      if (notice !== null) noticed = true;
      return notice;
    },
  };
}
