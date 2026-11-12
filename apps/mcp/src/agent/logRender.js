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
 * inbound message no delivered answer `covers`, and no older than the newest
 * message a delivered answer covers, is "(not answered)". One older than what
 * Tex has since answered is history, not a to-do (Dev, 2026-11-03: a 9:14 ask
 * still tagged at 10:47 took a new "send me a link" for itself). A text that
 * lands while Tex answers an earlier one is newer than all it covered, so it
 * stays tagged.
 * A fixed Worker text (`told`) is shown in the gateway's own words for it
 * (`conversation.js` `TOLD`).
 *
 * A group newcomer never sees what was said before they joined. An event's
 * `people` is a hash of the whole participant set, so "includes the reader"
 * cannot be read from it; the rendering is only the latest unbroken run of
 * events whose `people` is the chat's current set (`group.members`), the
 * same rule the chat's memory is filed by (`groupTurn.js`). It starts after
 * the last event under any other set, or none, so someone who left and came
 * back never sees what was said while they were gone. That shows less, never
 * more: a chat whose set changed starts again, and one whose newest event is
 * not under the current set shows nothing.
 */

import { TOLD } from "./conversation.js";
import { dayAgo, LULL_MS, spanWords } from "./chatTime.js";

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
  // A message another of their agents asked Tex to pass on (`sentOnItsOwn.js`): that agent's words, never Tex's or theirs.
  if (from?.kind === "agent") return "Their other agent, passed on by you";
  if (from?.kind === "system") return "Context";
  // A person is always "@name" ("@someone" unnamed): no name, a look-alike of "You" included, renders as Tex's or Context's label.
  const name = typeof from?.name === "string" ? oneLine(from.name).replace(/^@+/, "") : "";
  return `@${name || "someone"}`;
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
      if (event.heard === "voice") return text ? `(a voice message) ${text}` : "(a voice message)";
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


/** When the newest of these answered messages came in, `-Infinity` for none. */
export function newestAt(events, answered) {
  let newest = -Infinity;
  for (const event of events) if (answered.has(event.id) && Number.isFinite(event.at) && event.at > newest) newest = event.at;
  return newest;
}

/**
 * Render events (oldest first) as transcript lines, "" when there are none.
 * `answeredBy` is every event that may cover another (the whole log), so an
 * answer outside the rendered slice still counts. `tools` maps a turn to the
 * tools it used (`ledgerHistory.js`): its names follow Tex's first line of
 * that turn, names only.
 */
export function renderEvents(events, { timeZone = "UTC", answeredBy = events, tools = null, tags = null, now = null, lulls = Number.isFinite(now) } = {}) {
  const day = new Intl.DateTimeFormat("en-US", { timeZone, weekday: "long", month: "short", day: "numeric" });
  const time = new Intl.DateTimeFormat("en-US", { timeZone, hour: "numeric", minute: "2-digit", hour12: true });
  const all = [...answeredBy, ...events];
  const answered = new Set(all.filter((event) => event.from?.kind === "tex" && event.delivered !== false).flatMap((event) => event.covers ?? []));
  const newestAnswered = newestAt(all, answered);
  const byId = new Map(all.map((event) => [event.id, event]));
  const lines = [];
  const named = new Set();
  let lastDay = null;
  let lastAt = null;
  // With `now`: each day says how long ago it was. With `lulls` (on with `now`): a quiet stretch of four hours or more
  // is marked where it happened, which never changes, so the threaded log keeps it and says the days' ages in the
  // person's turn instead (`threadedTurn.js`, `chatTime.js`).
  const aged = Number.isFinite(now);
  for (const event of events) {
    const date = new Date(event.at);
    const thisDay = day.format(date);
    if (lulls && lastAt !== null && event.at - lastAt >= LULL_MS) lines.push(`(quiet for ${spanWords(event.at - lastAt)})`);
    if (thisDay !== lastDay) {
      lines.push(aged ? `--- ${thisDay} (${dayAgo(event.at, now, timeZone)}) ---` : `--- ${thisDay} ---`);
      lastDay = thisDay;
    }
    if (event.kind !== "reaction" && event.kind !== "delivery") lastAt = event.at;
    let line = `[${time.format(date).replace(/ /g, " ")}] ${speaker(event.from)}: ${words(event)}`;
    if (event.from?.kind === "person" && INBOUND.has(event.kind) && event.at >= newestAnswered && !answered.has(event.id)) line += "   (not answered)";
    const tag = tags?.get(event.id);
    if (typeof tag === "string") line += `   [${tag}]`; // its conversation (`conversationThreads.js`)
    lines.push(line);
    if (event.delivered === false) lines.push(`${NOTE_INDENT}(not delivered: ${REASON_WORDS[event.reason] ?? "it didn't go out"})`);
    if (typeof event.why === "string" && event.why !== "") lines.push(`${NOTE_INDENT}(${oneLine(event.why)})`);
    const replied = replyingTo(event, byId, time);
    if (replied !== "") lines.push(`${NOTE_INDENT}(${replied})`);
    const used = event.from?.kind === "tex" && typeof event.turn === "string" && !named.has(event.turn) ? tools?.get(event.turn) : undefined;
    if (Array.isArray(used) && used.length > 0) {
      named.add(event.turn);
      lines.push(`${NOTE_INDENT}(used: ${used.map((name) => oneLine(String(name)).slice(0, 64)).join(", ")})`);
    }
  }
  return lines.join("\n");
}

/**
 * What a reply was typed under, in words (Dev2, 2026-11-05: "quote the full text it was in response to"): the
 * message `replyTo` names, as this rendering shows it, so an answer held back stays held back
 * (`ledgerHistory.js`). One outside what is shown is named without its words. "" when it is no reply.
 */
export function replyingTo(event, byId, time = TIME_OF("UTC")) {
  if (typeof event?.replyTo !== "string") return "";
  const to = byId.get(event.replyTo);
  if (to === undefined) return "replying to an earlier message not shown here";
  const whose = to.from?.kind === "tex" ? "your" : to.from?.kind === "system" ? "Context's" : `${speaker(to.from)}'s`;
  return `replying to ${whose} ${time.format(new Date(to.at)).replace(/ /g, " ")} message: "${words(to)}"`;
}

/** A time-of-day formatter in a time zone, as the rendering writes times. */
export const TIME_OF = (timeZone) => new Intl.DateTimeFormat("en-US", { timeZone, hour: "numeric", minute: "2-digit", hour12: true });
