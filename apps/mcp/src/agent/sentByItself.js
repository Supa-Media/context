/**
 * What Tex texted a person by itself, shown in the chat's log (2026-11-02).
 *
 * A texted turn is shown the chat's event log (`loggedTurn.js`), which the
 * texting Worker fills as texts come in and as replies go out. A check-in, a
 * routine's text or a ping another agent asked for goes out on its own path
 * (`apps/agent/src/routines.ts` `textRoutine`), which logs no event: only the
 * person's record (`history.js`) keeps it, as an exchange whose question
 * begins "(Not a text from them." So a person who answered a check-in with
 * "yes please" was asked "Yes to what?": the check-in was in the record, and
 * the turn was shown the log alone.
 *
 * The record is already read on every turn (`turnHistory`), so this reads
 * nothing more: each such exchange from the log's window that the log does not
 * already hold is placed in it, at its time, as Tex's own text. Whether it is
 * trusted is the record's word for it (`tainted`), never the log's turn
 * records, which no check-in has.
 */

/** Every exchange Tex started without a text from them begins with this (`heartbeat.js`, `conversation.js`, `attention.js`). */
const BY_ITSELF = /^\(Not a text from them\./;

/** The log keeps a day (`log.js`): an exchange older than this before the newest covered text is past it. */
export const WINDOW_MS = 24 * 3_600_000;

/** Enough of a text to know the log already holds it: a reply is logged in parts (`textsFromAnswer`). */
const SAME = 60;

const key = (text) => String(text ?? "").replace(/\s+/g, " ").trim().slice(0, SAME);

/**
 * The record's texts Tex sent by itself, as log events for `renderEvents`, and
 * whether any of them is tainted. `events` is the chat's whole log, `newest`
 * the time of the newest text this turn answers.
 */
export function sentByItself(record, events, { chat, newest }) {
  const turns = Array.isArray(record) ? record : [];
  const logged = new Set(events.filter((event) => event.from?.kind === "tex" && typeof event.text === "string").map((event) => key(event.text)).filter(Boolean));
  const shown = [];
  let tainted = false;
  turns.forEach((turn, index) => {
    const answer = turns[index + 1];
    if (turn?.role !== "user" || typeof turn.text !== "string" || !BY_ITSELF.test(turn.text)) return;
    if (answer?.role !== "assistant" || typeof answer.text !== "string" || answer.text.trim() === "") return;
    if (!Number.isFinite(turn.at) || turn.at > newest || turn.at < newest - WINDOW_MS) return;
    const words = answer.text.trim();
    // A job's report or a fixed line was replied as a text, so the log holds it already.
    if (logged.has(key(words)) || [...logged].some((held) => held.length >= 20 && words.replace(/\s+/g, " ").includes(held))) return;
    if (answer.tainted === true) tainted = true;
    shown.push({ id: `record-${index}`, at: turn.at, chat, from: { kind: "tex" }, kind: "text", text: words, delivered: true, byItself: true });
  });
  return { shown, tainted };
}

/** The log's events with the record's own texts placed at their times, oldest first. */
export function withSentByItself(events, extra) {
  if (extra.length === 0) return events;
  return [...events, ...extra].sort((a, b) => a.at - b.at);
}
