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
 *   4. The answer says it couldn't open, read or reach something, and the
 *      turn had the web and never tried it. On 2026-10-22 Tex texted the
 *      owner "I couldn't open the LSB text for 28 or 29 from here", then,
 *      asked why, "I was wrong. I hadn't tried before I said it."
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
// "Say the word and I'll send it", "just say go", "let me know and I'll post it" (2026-10-22: a 👍 on each reached nothing).
const YES_ASK = /\b(?:say|reply|text|answer|send)\s+(?:yes|ok|okay|go)\b|\bsay the word\b|\bjust say\b|\blet me know (?:and|if)\b|\bgive (?:it|this|me) a\b|\u{1F44D}/iu;
/** What a yes or 👍 might be asked about that only a held call can make: "sending it again" too. */
const HELD_THING = /\b(?:send(?:ing)?|email(?:ing)?|forward(?:ing)?|calendar|schedul(?:e|ing)|book(?:ing)?|fil(?:e|ing)|bug|report|slack|dm|post(?:ing)?)\b/i;
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

/*
  What an offer is of, so the notice names only that call. On 2026-10-22 the
  owner asked about a receipt Tex had offered to email, and the notice that
  named "an email, a Slack message, a calendar change or a bug report" all at
  once was most likely what had Tex hold an old Slack test message from
  earlier in the chat instead, and answer that.
*/
const OFFER_KINDS = [
  { kind: "an email", tool: "send_email", test: (said) => PREVIEW_LINE.test(said) || /\b(?:email|e-mail|forward|reply to|write back|draft)\b/i.test(said) },
  { kind: "a Slack message", tool: "slack_api", test: (said) => SLACK_OFFER.test(said) || /\bslack\b/i.test(said) },
  { kind: "a calendar change", tool: "calendar_event", test: (said) => /\bcalendar\b/i.test(said) || (CALENDAR_CHANGE.test(said) && WHEN.test(said)) },
  { kind: "a bug report", tool: "report_problem", test: (said) => /\b(?:bug|report)\b/i.test(said) },
];

/** The kinds of held change an answer offers, by what its words name; every kind when they name none. */
export function offeredKinds(answer) {
  const said = String(answer ?? "");
  const named = OFFER_KINDS.filter((entry) => entry.test(said));
  return named.length > 0 ? named : OFFER_KINDS;
}

/** The notice for an offer of these kinds (`offeredKinds`). */
export function offerNotice(kinds = OFFER_KINDS) {
  const what = joinOr(kinds.map((entry) => entry.kind));
  const calls = joinOr(kinds.map((entry) => entry.tool));
  return (
    `Before this goes: you showed or offered, in your own words, ${what}, and nothing is held for their yes. ` +
    "A yes or 👍 to your words alone makes nothing, and they would be asked again. If that is what you offered and you know what it is, " +
    `make the call now (${calls}) with exactly what this answer offers: they are shown it with your answer, and their one yes or 👍 makes it. ` +
    "Only what this answer offers: never hold something from an earlier text instead. " +
    "Don't write out the email or ask for their yes yourself; the gateway does. " +
    "If something is missing, ask only for that. If you offered something else, send your answer again as it was."
  );
}

function joinOr(list) {
  return list.length <= 1 ? (list[0] ?? "") : `${list.slice(0, -1).join(", ")} or ${list.at(-1)}`;
}

export const OFFER_NOTICE = offerNotice();

/*
  HANDING THE WORK BACK (the owner, 2026-10-22: "Tex should never suggest the
  user should do something themselves that Tex has the access and capability
  to do ... this is the biggest insult to get from a personal assistant").
  That day Tex had found a receipt in the owner's Gmail, lost it by the next
  text, searched once, and then texted "Forward Google's receipt from your
  Public Worship Gmail to me, or give me its subject line" and "Check Google
  Voice's billing history". An answer that tells them to find, forward, check
  or look something up gets one more round telling Tex to do it itself. A
  step only they can take (a code, a captcha, a payment, a sign-in link Tex
  sent) is not handing back.
*/
const HANDBACK = [
  /\bforward\b[^.?!\n]{0,80}?\bto me\b/i,
  /\bforward me\b/i,
  /\bsend me\b[^.?!\n]{0,40}?\b(?:receipt|email|subject|screenshot|copy|pdf|file|link|invoice|id|address|number)\b/i,
  /\b(?:give|tell|text) me\s+(?:its|the|that|their|her|his)\s+(?:\w+\s+)?(?:subject|sender|date|id|address|link|number|url)\b/i,
  /\byou(?:'ll| will)?\s+(?:need to|have to|can|could|should|might want to|may want to|'d need to|would need to)\s+(?:check|look|search|find|forward|download|log ?in|sign in|open|send|pull up|dig up|go to|grab|contact|ask)\b/i,
];
/*
  A FILE ON A SITE IS TEX'S TO DOWNLOAD AND ATTACH (2026-10-22). Tex texted "I
  can't put a file from the admin console into an email myself. Tap the
  download arrow next to September, attach it to the draft to Kansi". The
  browse `download` step and `attach` on the email tools do exactly that, so
  these hand it back even with a "tap" in them, which otherwise marks a step
  only the person can take.
*/
const FILE_HANDBACK = [
  /\b(?:can't|cannot|can not|am unable to|'m unable to|have no way to)\s+(?:put|attach|add|include|download|save|get)\b[^.?!\n]{0,80}?\b(?:files?|pdfs?|invoices?|receipts?|statements?|attachments?)\b/i,
  /\b(?:can't|cannot|can not)\s+(?:put|attach|add|include)\b[^.?!\n]{0,80}?\b(?:into|in|to|on)\s+(?:an?|the|your|that)\s+(?:email|draft|message|reply)\b/i,
  /\b(?:tap|click|press|hit)\s+(?:the|its|that)\s+(?:\w+\s+)?download\b/i,
  /(?:^|,\s*|\b(?:and|then|please|just)\s+)attach (?:it|them|the \w+|that \w+|this \w+)\s+(?:to|in|on)\s+(?:the|your|that|a)\s+(?:\w+\s+)?(?:email|draft|message|reply)\b/i,
];
/** A sentence that opens by telling them to go and do it. */
const HANDBACK_IMPERATIVE =
  /^(?:please\s+|maybe\s+|just\s+|so\s+)?(?:check|look (?:up|in|at|through|for)|search|find|dig up|pull up|go to|head to|download|grab|forward|log ?in|sign in|open up|reach out to|contact)\b(?![-'])/i;
/** What only they can do, a link Tex sent them for it, or their yes to an ask (`heldEcho.js` drops talk of that). */
const THEIRS_TO_DO =
  /\bhttps?:\/\/|\b(?:the|this|that) link\b|\b(?:code|captcha|pay|card|password|passcode|verification|two-factor|2fa|confirm|confirmation|approve|approval|yes|tap|take over)\b|\u{1F44D}/iu;

/** Whether an answer tells them to do something Tex's own tools could. */
export function handsWorkBack(answer) {
  const sentences = String(answer ?? "")
    .replace(/[\u2018\u2019]/g, "'")
    .split(/\n+|(?<=[.!?])\s+/)
    .map((sentence) => sentence.trim())
    .filter(Boolean);
  return sentences.some(
    (sentence) =>
      FILE_HANDBACK.some((pattern) => pattern.test(sentence)) ||
      (!THEIRS_TO_DO.test(sentence) && (HANDBACK_IMPERATIVE.test(sentence) || HANDBACK.some((pattern) => pattern.test(sentence)))),
  );
}

export const HANDBACK_NOTICE =
  "Before this goes: your answer asks them to find, forward, check or look something up, and that is yours to do. " +
  "Never ask them to do what your own tools can: search their email yourself again, a different way each time (search_email by the sender with from:, " +
  "an amount or number, a date range with after: and before:, one or two words, each connected mailbox), read their notes, or open the site in your browser and sign in with a saved login. " +
  "A file on a site (an invoice or receipt PDF, a statement) is yours to take: a browse download step saves it, and attach on send_email or save_email_draft puts it in the email. " +
  "If their mail doesn't have it, go where else it lives: Gmail on the web in your browser, or the account, admin or billing page it came from (a billing history, an admin console), signed in with their saved login. " +
  "An email you texted about earlier is still there: find it again. Do it now, then answer with what you did or found. " +
  "Ask them only for what truly needs them: a sign-in code, a captcha, a payment, a choice, or a fact only they know. " +
  "If it will take many steps, start a background job for it rather than handing it back. " +
  "If you tried every way and still can't, say in one line what you tried, and ask one specific question. " +
  "If those words were not asking them to do anything (their own to-do list, or what someone else said), send your answer again as it was.";

export const CLAIM_NOTICE =
  "Before this goes: your answer says something was added or saved, but no change to their notes went through in this turn. " +
  "If they asked for it, make the change now with your tools and then answer. If you can't, answer again saying plainly that it is not done, " +
  "and never say a change is made unless a call for it succeeded.";

/** "I couldn't open the LSB text", "I can't access that page", "I wasn't able to pull it up". */
const CANT_REACH =
  /\b(?:couldn['’]?t|could not|can['’]?t|cannot|can not|wasn['’]?t able to|was unable to|am unable to|unable to)\s+(?:open|load|read|reach|access|get to|get at|pull up)\b/i;

export const TRY_NOTICE =
  "Before this goes: your answer says you couldn't open or read something, but you didn't try anything on the web in this turn. " +
  "If it is on the web, try it now with search_web and open_page (or browse), then answer from what you read and name the page's address if they asked where it came from. " +
  "Say you couldn't only after a try failed, and say what failed. If it was never a web thing, send your answer again as it was.";

/** Whether an answer says it couldn't open, read or reach something. */
export function saysItCouldNot(answer) {
  return CANT_REACH.test(String(answer ?? ""));
}

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
  if (YES_ASK.test(said) && (HELD_THING.test(said) || CALENDAR_ASK.test(said))) return true;
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
  let hadWeb = false;
  let triedWeb = false;
  let handedBack = false;
  return {
    /** The turn's web (`turnWeb.js`), watched for whether anything on it was tried. */
    wrapWeb(web) {
      if (web === null) return null;
      hadWeb = true;
      return { ...web, call: (name, args) => ((triedWeb = true), web.call(name, args)) };
    },
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
      // Handing work back is checked on its own, once, beside the others: an
      // answer that offers an email can still ask them to go and find it.
      if (!handedBack && handsWorkBack(answer)) {
        handedBack = true;
        return HANDBACK_NOTICE;
      }
      if (noticed) return null;
      const notice =
        asksToMute(question) && !keptWish
          ? MUTE_NOTICE
          : claimsAChange(answer) && !wrote
            ? CLAIM_NOTICE
            : offersAHeldChange(answer) && !held
              ? offerNotice(offeredKinds(answer))
              : hadWeb && !triedWeb && saysItCouldNot(answer)
                ? TRY_NOTICE
                : null;
      if (notice !== null) noticed = true;
      return notice;
    },
  };
}
