/**
 * Whether an answer offers a held change: a calendar change, an email, a Slack message or a bug report, asked in the
 * answer's own words, which only a yes may make. `claimCheck.js` holds its notice on it (`offerNotice`) and the
 * gateway's liked-preview check (`tools/likedPreview.js`) reads it the same way, so both sides name one offer alike.
 */

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
// "Say the word and I'll send it", "just say go", "let me know and I'll post it" (2026-10-22: a 👍 on each reached nothing).
// "Text me yourself with a yes and I'll send it" (2026-11-26, a group's shared mailbox: nothing held, so a yes sent nothing).
const YES_ASK = /\b(?:say|reply|text|answer|send)\s+(?:yes|ok|okay|go)\b|\bsay the word\b|\bjust say\b|\blet me know (?:and|if)\b|\bgive (?:it|this|me) a\b|\bwith\s+(?:a|your|their|his|her)\s+(?:yes|ok|okay)\b|\b(?:gives?|sends?)\s+(?:a|your|their|his|her|me)\s+(?:yes|ok|okay|go-ahead)\b|\u{1F44D}/iu;
/** What a yes or 👍 might be asked about that only a held call can make: "sending it again" too. */
const HELD_THING = /\b(?:send(?:ing)?|email(?:ing)?|forward(?:ing)?|calendar|schedul(?:e|ing)|book(?:ing)?|fil(?:e|ing)|bug|report|slack|chat|dm|post(?:ing)?)\b/i;
/*
  A calendar change asked for in the answer's own words: "Sunday, November 1,
  3 to 5 pm, at Bethesda. Say yes and I'll add it." (2026-10-22 5:04 PM). The
  verb was "add", which `HELD_THING` doesn't name, so nothing was held, their
  "yes" reached a model that only then raised the hold, and they were asked a
  second time for a 👍. "Add" with a day or time is a calendar change unless
  it names their own list or notes.
*/
const CALENDAR_ASK = {
  test: (said) => CALENDAR_CHANGE.test(said) && WHEN.test(said) && (/\bcalendar\b/i.test(said) || !NOT_CALENDAR.test(said)),
};
/**
 * A Slack message offered in the answer's own words (2026-10-22: "I'd DM Jo
 * on Acme Slack: …", with nothing held, so the 👍 on it reached nothing).
 */
const SLACK_OFFER =
  /\b(?:I['’]d|I would|I['’]ll|I will|want me to|shall I|should I|do you want me to)\s+(?:DM|message|post|send|reply)\b[^\n]{0,160}?\b(?:Slack|DM)\b/i;

/** Whether an answer offers a calendar change, an email or a bug report: as a question, a preview, or a request for their yes. */
function offersAHeldChange(answer) {
  const said = String(answer ?? "");
  if (PREVIEW_LINE.test(said) || SLACK_OFFER.test(said)) return true;
  if (YES_ASK.test(said) && (HELD_THING.test(said) || CALENDAR_ASK.test(said))) return true;
  for (const [, offered] of said.matchAll(OFFER)) {
    if ((CALENDAR_CHANGE.test(offered) && WHEN.test(offered) && (/\bcalendar\b/i.test(offered) || !NOT_CALENDAR.test(offered))) || EMAIL_SEND.test(offered)) return true;
  }
  return false;
}

module.exports = { offersAHeldChange, PREVIEW_LINE, SLACK_OFFER, CALENDAR_CHANGE, WHEN };
