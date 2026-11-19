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
  /\b(?:drafts?|repl(?:y|ies)|e-?mails?|messages?|events?)(?:['’]s| is| are)\s+still\s+(?:there|in)\b/i,
  /\b(?:put|left|placed)\s+(?:it|them|the\s+\w+)\s+in\s+(?:your\s+)?(?:gmail\s+)?drafts\b/i,
  /\b(?:is|are|was|['’]s)\s+(?:already\s+|still\s+)?saved\s+(?:as|in|to)\s+(?:a\s+|your\s+|the\s+)?(?:gmail\s+)?drafts?\b/i,
  /\bsaved\s+(?:as|in|to)\s+(?:a\s+|your\s+)?(?:gmail\s+)?drafts?\b/i,
  /\b(?:still|already|is|are|['’]s)\s+(?:sitting|waiting)\s+in\s+(?:your\s+)?(?:gmail\s+)?(?:drafts|inbox|outbox|calendar)\b/i,
];
// Said of an email, a draft or an event, these claim it still stands; said of a note, a write in the turn backs them.
const STILL_IN_PLACE = /\b(?:is|are)\s+still\s+(?:there|in your|on your|saved|scheduled|booked|unsent)\b/i;
const NOTHING_SENT = /\bnothing\s+(?:was|has been|got)\s+sent\b(?!\s+yet)/i;
const FIRST_PERSON_DONE = /\bI(?:['’]ve| have)?\s+(?:just\s+)?(?:saved|sent|drafted|booked|scheduled|emailed)\b/i;
const WORLD_THING = /\b(?:drafts?|e-?mails?|gmail|inbox|messages?|repl(?:y|ies)|invites?|invitations?|events?|calendar|meetings?|bookings?)\b/i;
const NOT_DONE = /\b(?:couldn['’]?t|could not|can['’]?t|cannot|wasn['’]?t able|unable|not (?:saved|sent|done)|didn['’]?t (?:save|send)|not yet|nothing(?:['’]s| is| has been)\s+(?:saved|sent|drafted|booked)\b)/i;
const THUMBS_ASK = /\b(?:reply|send|text)\s+👍|👍\s+(?:to|and)\b/;

// WHAT KIND OF THING A CALL DID OR LOOKED AT (2026-11-19, the second live miss after #3769: a mail search of the inbox,
// made to summarize an email, backed "I already saved the draft"). Keyed by tool name, with the v2 `send` action and the
// `search` / `fetch` targets read from the call's args. `act` did it or held it for their yes; `look` read its current state.
// A kind a claim is about is backed only by an act or a look of that same kind.
// The writes and sends a turn may have made, for an answer that names no kind.
const ACTION = new Set(["send_email", "save_email_draft", "calendar_event", "slack_api", "google_chat", "app_change", "mail_agent", "send", "write", "write_note", "write_notes", "manage"]);
const SEEN_ARGS = 400;
const argsOf = (step) => (typeof step?.args === "string" ? step.args : JSON.stringify(step?.args ?? {}));
const said = (step) => `${step.action ?? ""} ${argsOf(step)}`.toLowerCase();
// A mail search or read: the old names, the v2 `search` with `email: true`, a fetch of an `email:` id, or a search written in Gmail's own syntax.
const MAIL_LOOK = (n, step) => n === "search_email" || n === "read_email" || ((n === "search" || n === "fetch") && /"email":true|email:|\b(?:in|label):/i.test(argsOf(step)));
const DRAFT_LOOK = /\b(?:in:drafts?|label:drafts?|drafts?)\b/;
const SENT_LOOK = /\b(?:in:sent|label:sent|sent)\b/;
export const KINDS = [
  // A draft: saving one, or a mail search or read that is about their drafts.
  // An email held for their yes is "drafted" in their words too ("I drafted a reply to Jo" over a held send).
  { kind: "draft", act: (n, step) => n === "save_email_draft" || (n === "send" && step.action === "email_draft") || (step.held === true && (n === "send_email" || (n === "send" && step.action === "email"))), look: (n, step) => MAIL_LOOK(n, step) && DRAFT_LOOK.test(said(step)) },
  // An email sent: sending one, or a look at their sent mail.
  { kind: "email", act: (n, step) => n === "send_email" || n === "mail_agent" || (n === "send" && step.action === "email"), look: (n, step) => MAIL_LOOK(n, step) && SENT_LOOK.test(said(step)) },
  // A chat or DM message: Google Chat or Slack, sent or held, or the conversation read.
  { kind: "chat", act: (n, step) => (n === "google_chat" && step.action !== "spaces") || n === "slack_api" || (n === "send" && (step.action === "google_chat" || step.action === "slack")), look: (n, step) => n === "read_google_chat" || (n === "fetch" && /"chat:/.test(argsOf(step))) || (n === "slack_api" && /conversations\.(?:history|replies)/.test(argsOf(step))) },
  // A calendar event: a change, or a calendar read.
  { kind: "calendar", act: (n, step) => n === "calendar_event" || (n === "send" && step.action === "calendar"), look: (n, step) => n === "read_calendar" || (n === "fetch" && /calendar:/.test(argsOf(step))) },
  // A note: a write that went through.
  { kind: "note", act: (n) => n === "write" || n === "write_note" || n === "write_notes" || n === "manage" || n === "app_change", look: (n, step) => n === "read_note" || n === "read_notes" || n === "search_notes" || ((n === "fetch" || n === "search") && !/"email":true|email:|chat:|calendar:|https?:/i.test(argsOf(step))) },
];
// The words that name each kind in an answer or in their ask. An answer about none of them is about whatever their ask named.
const KIND_WORDS = {
  draft: /\bdrafts?\b|\bdrafted\b/i,
  chat: /\b(?:google chat|chat message|DMs?|direct message|space|slack|channel)\b/i,
  calendar: /\b(?:calendar|events?|invites?|invitations?|meetings? (?:on|to) (?:your|the) calendar|booked|booking|scheduled|rsvp)\b/i,
  email: /\b(?:e-?mails?|emailed|gmail|repl(?:y|ied|ies))\b/i, // a bare "send it" names no kind: their ask then does
  note: /\bnotes?\b/i,
};

/** One call's step, as `wrap` records it: its name, whether it ran, its action, whether it was held, and its args in short. */
export function stepOf(name, args, result) {
  let seen = "";
  try {
    seen = JSON.stringify(args ?? {}).slice(0, SEEN_ARGS);
  } catch {
    seen = "";
  }
  return {
    name,
    ok: result?.isError !== true,
    ...(typeof args?.action === "string" ? { action: args.action } : {}),
    ...(result?.held === true ? { held: true } : {}),
    args: seen,
  };
}

/** The kinds a text is about (`KIND_WORDS`): a draft claim names drafts, a DM claim the chat. */
export function kindsIn(text) {
  const words = String(text ?? "");
  const kinds = Object.entries(KIND_WORDS).filter(([, pattern]) => pattern.test(words)).map(([kind]) => kind);
  // "a draft reply" is a draft, not an email sent; "the reply in Gmail drafts" too.
  return kinds.includes("draft") ? kinds.filter((kind) => kind !== "email") : kinds;
}

// RELIES ON AN EARLIER TURN: a sentence that points back (already, earlier, before, previous, still waiting, again,
// twice, a second one) and says this turn did not do it, or is waiting on an earlier yes. Wording only picks the
// sentence; whether it stands is decided by the turn's calls (`backedThisTurn`).
const POINTS_BACK = /\b(?:already|earlier|(?:from|did|done|sent|made|saved|asked) before|previous(?:ly)?|last time|still waiting|still pending|again|twice|a second (?:one|time|copy|draft|message)|another (?:one|copy|draft))\b/i;
const ACT = "(?:make|made|send|sent|save|saved|draft|drafted|create|book|add|post|message|text|email|do|redo|resend|schedule|write|put)";
const HOLDS_BACK = new RegExp(
  `\\b(?:(?:didn['’]?t|did not|won['’]?t|will not|not going to|no need to|don['’]?t need to|shouldn['’]?t|skip(?:ped)?)\\s+(?:\\w+\\s+){0,2}?${ACT}|instead of|rather than|holding off|(?:waiting|wait) (?:on|for) (?:your|their|a|the) (?:👍|yes|ok(?:ay)?|go(?:-ahead)?|approval|thumbs|confirmation)|(?:is|are|was|['’]s|you['’]re|you are|we['’]re) (?:already )?(?:in|there)\\b)`,
  "i",
);
// Their message asks Tex to do something in the world or in their notes, so a skip or a wait that rests on an earlier turn matters.
const ASKS_TO_ACT = /\b(?:draft|send|text|message|dm|e-?mail|reply|respond|book|schedule|save|add|invite|post|write|put|create|make|remind|resend|redo|again|chat|ping|tell)\b/i;

// "I sent you the options": the text to them is the reply itself, not an action in the world.
const TO_THEM = /\b(?:sent|send|sending|texted|text)\s+you\b/i;

/** Whether the answer rests on an earlier turn: a skip, a refusal or a wait that points back, in one sentence. */
export function reliesOnEarlier(answer) {
  const sentences = String(answer ?? "").split(/(?<=[.!?])\s+|\n+/).map((sentence) => sentence.trim()).filter((sentence) => sentence !== "" && !TO_THEM.test(sentence));
  return sentences.some((sentence) => !sentence.endsWith("?") && POINTS_BACK.test(sentence) && HOLDS_BACK.test(sentence));
}

/** Whether the answer says something is already done or still in place, in its own words. */
export function claimsItStands(answer) {
  const said = String(answer ?? "");
  const sentences = said.split(/(?<=[.!?])\s+|\n+/).map((sentence) => sentence.trim()).filter((sentence) => sentence !== "" && !sentence.endsWith("?") && !TO_THEM.test(sentence));
  const already = sentences.some((sentence) => ALREADY.some((pattern) => pattern.test(sentence)));
  if (already) return true; // "I already did this" stands as a claim whatever else the answer says
  if (NOT_DONE.test(said)) return false; // an answer saying it is not done claims nothing
  // A preview still asking for their yes or 👍 is not a claim, and neither is an offer of a held change.
  if (!already && (offersAHeldChange(said) || THUMBS_ASK.test(said)) && !reliesOnEarlier(said)) return false;
  return sentences.some((sentence) => [...ALREADY, ...STILL_THERE, NOTHING_SENT].some((pattern) => pattern.test(sentence)) || ((FIRST_PERSON_DONE.test(sentence) || STILL_IN_PLACE.test(sentence)) && WORLD_THING.test(sentence)));
}

/** Whether this turn's calls did, held or looked at something of one of `kinds`; with no kind named, whether any call did or held something. */
export function backedThisTurn(steps, kinds = []) {
  const list = Array.isArray(steps) ? steps : [];
  const wanted = KINDS.filter((entry) => kinds.includes(entry.kind));
  return list.some((step) => {
    const name = String(step?.name ?? "");
    const counted = step?.held === true || step?.ok === true;
    if (!counted) return false;
    if (wanted.length === 0) return step.held === true || KINDS.some((entry) => entry.act(name, step)) || ACTION.has(name);
    return wanted.some((entry) => entry.act(name, step) || (step.ok === true && entry.look(name, step)));
  });
}


/** Kept for callers of #3769's name: whether any of this turn's calls did, held or looked at anything (no kind). */
export function checkedThisTurn(steps) {
  return backedThisTurn(steps, []);
}

/** The notice when the answer claims, skips or waits on something this turn did not do or look at, of the same kind; null otherwise. `question` is their ask. */
export function standsNotice(answer, steps, question = "") {
  // A skip or a wait counts when their ask is to do something; with no ask known (a unit's call), the answer's words decide.
  const relies = reliesOnEarlier(answer) && (String(question ?? "").trim() === "" || ASKS_TO_ACT.test(String(question)));
  if (!claimsItStands(answer) && !relies) return null;
  const named = kindsIn(answer);
  const kinds = named.length > 0 ? named : kindsIn(question);
  return backedThisTurn(steps, kinds) ? null : STANDS_NOTICE;
}

/** What goes instead of an answer that still rests on an earlier turn after its one send-back, or of an empty or dropped retry (`standsGate` `final`). Never empty. */
export const STANDS_HONEST =
  "I couldn't confirm this turn that what I did earlier is still in place, so I won't count on it. Want me to redo it now?";

/**
 * The stands gate every chat turn's model reply passes (`runTheModel.js`): its `wrap` sees every call the turn makes,
 * whichever door or checker runs; `check` sends a draft back once; `final` is the fail-closed end, run on the answer
 * the turn returns (the last round's included, which `turn.js` does not check). A second unbacked claim, skip or wait
 * is replaced with `STANDS_HONEST`, never sent as it is; and once the gate has sent a draft back, a retry that comes
 * back empty, as silence, or with the rounds spent is replaced too, so the gate never leaves a turn with no reply
 * (2026-11-19). The gateway never does the Gmail or Chat action itself.
 */
export function standsGate({ question = "" } = {}) {
  let noticed = false;
  const steps = [];
  return {
    steps,
    wrap(callTool) {
      return async (name, args) => {
        const result = await callTool(name, args);
        steps.push(stepOf(name, args, result));
        return result;
      };
    },
    check(answer) {
      if (noticed) return null;
      const notice = standsNotice(answer, steps, question);
      if (notice !== null) noticed = true;
      return notice;
    },
    /** `ended`: `{ exhausted, silent }`, how the turn ended: out of rounds, or settled as saying nothing. */
    final(answer, ended = {}) {
      const empty = typeof answer !== "string" || answer.trim() === "";
      if (noticed && (empty || ended.exhausted === true || ended.silent === true)) return STANDS_HONEST; // the gate's send-back must never cost them the reply
      if (empty) return null;
      return standsNotice(answer, steps, question) === null ? null : STANDS_HONEST;
    },
  };
}

/** `{ wrap, wrapWeb, check }`, shaped like `untriedWebCheck`'s, for a console 1:1 (`frontDoorChecks`). */
export function standsCheck({ question = "" } = {}) {
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
      const notice = standsNotice(answer, steps, question);
      if (notice !== null) noticed = true;
      return notice;
    },
  };
}
