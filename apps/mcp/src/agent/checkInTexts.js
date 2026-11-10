/**
 * WHAT A CHECK-IN READS OF THE CHAT, AND WHAT THE CHAT KEEPS OF A CHECK-IN
 * (`heartbeat.js`, split out 2026-11-10).
 *
 * A look is shown the last texts with them, each with when it was sent in
 * their time, and may name one to continue (`[continues N]`). The chat keeps,
 * above a check-in's text, the text it went under, its last thinking and its
 * day's log, so a later turn can say why it texted
 * (`docs/decisions/texting-assistant/dates-everywhere.md`).
 */

import { localStamp, readTimeZone } from "./localNow.js";

/** The words a check-in's text is kept under in the texting conversation, in place of a question. */
export const CHECK_IN_QUESTION =
  "(Not a text from them. This was your own check-in: you looked through their workspace on your own and texted them what follows.)";

/** Whether a kept question is a check-in's line (`CHECK_IN_QUESTION`, with what `checkInAbout` adds after it). */
export function isCheckInLine(text) {
  return typeof text === "string" && text.startsWith(CHECK_IN_QUESTION);
}

/** How much of the check-in's own thinking the chat keeps as its reason, and of the text it went under. */
const MAX_REASON_CHARS = 600;
const MAX_UNDER_CHARS = 200;

/**
 * What the chat keeps above a check-in's text: the fixed line, the text it went
 * under when it was sent as a reply, the reason in its own last thinking, and
 * where the whole look is logged. 2026-11-09: a 10 am check-in "corrected" a
 * Sunday text under it, and asked why at 10:33, the chat turn had only the
 * fixed line and said it couldn't see what drove it.
 */
export function checkInAbout({ continues = null, reason = "", log = null } = {}) {
  const one = (text, max) => {
    const said = String(text ?? "").replace(/\s+/g, " ").trim();
    return said.length > max ? `${said.slice(0, max - 1)}…` : said;
  };
  const under = continues ? one(continues, MAX_UNDER_CHARS) : "";
  const why = one(reason, MAX_REASON_CHARS);
  return [
    CHECK_IN_QUESTION,
    under ? `It went as a reply under your earlier text "${under}".` : "",
    why ? `Your thinking just before you texted it: "${why}"` : "",
    log ? `The whole look, what it read and every step, is in ${log}.` : "",
  ]
    .filter(Boolean)
    .join(" ");
}

/** The look's last thinking before its answer: the reason it texted, in its own words. */
export function lastThinking(events) {
  const thoughts = (Array.isArray(events) ? events : []).filter((event) => event?.kind === "thinking" && typeof event.text === "string" && event.text.trim() !== "");
  return thoughts.at(-1)?.text ?? "";
}

/** How many of the last texts with them a look is shown, and how much of each. */
export const RECENT_TEXTS_SHOWN = 10;
const RECENT_TEXT_CHARS = 400;

/**
 * The last texts with them (the `texts` conversation the texting assistant
 * answers from), as a look reads them: their words, and yours, with your own
 * check-ins marked. Dev, 2026-10-19, nudged at 3:02 pm about a hold Tex had
 * flagged at 1:12 and talked through with them at 1:23: "does it not check?
 * ... why isn't there continuity in the chat".
 */
export function recentTextLines(history, timeZone = null) {
  return recentTexts(history, timeZone).map((shown) => shown.line);
}

/**
 * The same last texts, each with its line as shown (numbered from 1, so the
 * look can say which one it continues) and the turn's whole text, which goes
 * back to the texting Worker as `continues` so the check-in is sent as a
 * reply under that text in the person's iMessage chat (Dev, 2026-10-19:
 * "even if it should be in the same thread, why isn't there continuity").
 */
export function recentTexts(history, timeZone = null) {
  const shown = [];
  const turns = Array.isArray(history) ? history.slice(-RECENT_TEXTS_SHOWN * 2) : [];
  const zone = readTimeZone(timeZone);
  // A text's time is its question's: only a person's side is kept with one, and Tex's answer goes with it (`conversation.js`).
  let at = null;
  for (let i = 0; i < turns.length; i += 1) {
    const turn = turns[i];
    if (turn?.role === "user") at = Number.isFinite(turn.at) ? turn.at : null;
    if (typeof turn?.text !== "string") continue;
    if (turn.role === "user" && isCheckInLine(turn.text)) continue;
    const checkIn = turn.role === "assistant" && isCheckInLine(turns[i - 1]?.text);
    const said = turn.text.replace(/\s+/g, " ").trim();
    const clipped = said.length > RECENT_TEXT_CHARS ? `${said.slice(0, RECENT_TEXT_CHARS - 1)}…` : said;
    // Undated, Sunday's "the tournament is today" read on Monday as a mistake to correct (2026-11-09).
    const when = at !== null && zone !== null ? ` (${localStamp(at, zone)})` : "";
    shown.push({ who: `${turn.role === "user" ? "Them" : checkIn ? "You (a check-in)" : "You"}${when}`, said: clipped, text: turn.text });
  }
  return shown.slice(-RECENT_TEXTS_SHOWN).map((item, index) => ({ line: `[${index + 1}] ${item.who}: ${item.said}`, text: item.text }));
}

/** How a look names the text it continues: `[continues 3]` at the very start of its answer. */
const CONTINUES_MARKER = /^\s*\[\s*continues\s+(\d{1,3})\s*\]\s*/i;
/** The Worker matches on a text's opening words, so this much of it is enough. */
const MAX_CONTINUES_CHARS = 1_000;

/**
 * The look's answer with its `[continues N]` marker taken off (it is never
 * sent, logged or kept), and the whole text of the shown line it names, or
 * null: no marker, or a number that names no shown line.
 */
export function continuesFrom(answer, recent) {
  const said = String(answer ?? "");
  const match = CONTINUES_MARKER.exec(said);
  if (match === null) return { answer: said, continues: null };
  const picked = Array.isArray(recent) ? recent[Number(match[1]) - 1] : undefined;
  return { answer: said.slice(match[0].length), continues: typeof picked?.text === "string" ? picked.text.slice(0, MAX_CONTINUES_CHARS) : null };
}
