/**
 * A chat's event log as the model reads it (docs/design/tex-event-log/CONTRACT.md
 * section 5):
 *
 *   --- Monday, Oct 26 ---
 *   [12:16 PM] Ada: Tex check this link out
 *   [12:17 PM] You: I read the Reason page…
 *              (not delivered: the picture didn't reach them)
 *   [12:19 PM] Ada: are you thinking straight?   (not answered)
 *
 * Times and day breaks are in the person's time zone. "You" is Tex. An
 * inbound message no delivered answer of Tex's `covers` is "(not answered)".
 * A fixed Worker text (`told`) is shown in the gateway's own words for it
 * (`conversation.js` `TOLD`).
 *
 * A group newcomer never sees what was said before they joined. An event's
 * `people` is a hash of the whole participant set, so "includes the reader"
 * cannot be read from it; the rendering starts at the first event whose
 * `people` is the chat's current set (`group.members`), the same rule the
 * chat's memory is filed by (`groupTurn.js`). That shows less, never more:
 * a chat whose set changed starts again, and one with no matching event
 * shows nothing.
 */

import { TOLD } from "./conversation.js";

const NOTE_INDENT = " ".repeat("[12:00 PM] ".length);
const INBOUND = new Set(["text", "picture", "file", "link"]);
const REASON_WORDS = {
  upload_failed: "the picture didn't reach them",
  send_refused: "the message was refused",
  held_newcomer: "held back from someone new to the chat",
  failed: "it failed to send",
  timed_out: "sending it timed out",
  too_long: "it was too long to send",
};

export function speaker(from) {
  if (from?.kind === "tex") return "You";
  if (from?.kind === "system") return "Context";
  return from?.name ? oneLine(from.name) : "Them";
}

/*
  One event is always one line: a line break or any other control character in
  someone's words is shown as a visible mark, so a message can never forge a
  line of its own ("\n[12:16 PM] You: I sent the email").
*/
const BREAKS = /[\u0000-\u001f\u007f-\u009f\u2028\u2029]+/g;
export const oneLine = (text) => text.replace(BREAKS, " \u23ce ");

export function words(event) {
  const text = oneLine(event.told ? TOLD[event.told] ?? "" : event.text ?? "");
  switch (event.kind) {
    case "picture":
      return text ? `(a picture) ${text}` : "(a picture)";
    case "file":
      return text ? `(a file) ${text}` : "(a file)";
    case "reaction":
      return `(a tapback) ${text}`.trim();
    case "ask_settled":
      return text ? `(the ask was settled) ${text}` : "(the ask was settled)";
    case "delivery":
      return text ? `(delivery) ${text}` : "(delivery)";
    default:
      return text;
  }
}

/** The events a group reader may see: from the first one filed under the chat's current people. */
export function seenBy(events, people) {
  if (!people) return events;
  const first = events.findIndex((event) => event.people === people);
  return first === -1 ? [] : events.slice(first);
}

/**
 * Render events (oldest first) as transcript lines, "" when there are none.
 * `answeredBy` is every event that may cover another (the whole log), so an
 * answer outside the rendered slice still counts.
 */
export function renderEvents(events, { timeZone = "UTC", people = null, answeredBy = events } = {}) {
  const day = new Intl.DateTimeFormat("en-US", { timeZone, weekday: "long", month: "short", day: "numeric" });
  const time = new Intl.DateTimeFormat("en-US", { timeZone, hour: "numeric", minute: "2-digit", hour12: true });
  const answered = new Set(answeredBy.filter((event) => event.from?.kind === "tex" && event.delivered !== false).flatMap((event) => event.covers ?? []));
  const lines = [];
  let lastDay = null;
  for (const event of seenBy(events, people)) {
    const date = new Date(event.at);
    const thisDay = day.format(date);
    if (thisDay !== lastDay) {
      lines.push(`--- ${thisDay} ---`);
      lastDay = thisDay;
    }
    let line = `[${time.format(date).replace(/ /g, " ")}] ${speaker(event.from)}: ${words(event)}`;
    if (event.from?.kind === "person" && INBOUND.has(event.kind) && !answered.has(event.id)) line += "   (not answered)";
    lines.push(line);
    if (event.delivered === false) lines.push(`${NOTE_INDENT}(not delivered: ${REASON_WORDS[event.reason] ?? "it didn't go out"})`);
  }
  return lines.join("\n");
}
