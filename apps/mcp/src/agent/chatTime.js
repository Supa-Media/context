/**
 * TIME IN CODE, NOT GUESSED BY THE MODEL (Dev2, 2026-11-11: group time awareness, plan v3 step 2 and 4).
 *
 * Every text Tex reads already carries its date (`withToday`, #3149). What it could not see was how long ago
 * that was, or that the chat had gone quiet in between: a four-day-old aside read like this morning's, and a
 * reply typed under a two-day-old text was answered as if it were about the newest one. Code works those out
 * and says them in words:
 *
 *  - each day the chat shows says how many days ago it was ("Monday, Nov 9 was 2 days ago");
 *  - a quiet stretch of four hours or more between two texts is marked where it happened;
 *  - the turn's own note says when the chat was quiet before this text, and when a text answers one from
 *    hours or days ago, so that conversation is the one picked back up.
 *
 * Ages change every text, so they are said only in the person's turn (`threadedTurn.js` `note`, `timeNote`), never
 * in the cached system prompt or the cached history (`turnPrompt.js`, `turn.js`). A quiet stretch is two texts'
 * own times, so it stays in the history.
 */

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;

/** A quiet stretch at least this long is marked between texts, and splits one conversation from the next. */
export const LULL_MS = 4 * HOUR;
/** A reply under a text at least this old is named as a reply to an old one. */
export const LATE_REPLY_MS = 6 * HOUR;

/** How long a span is, in words: "12 minutes", "5 hours", "2 days". */
export function spanWords(ms) {
  const minutes = Math.max(1, Math.round(ms / MINUTE));
  if (minutes < 90) return `${minutes} ${minutes === 1 ? "minute" : "minutes"}`;
  const hours = Math.round(ms / HOUR);
  if (hours < 36) return `${hours} hours`;
  const days = Math.round(ms / DAY);
  return `${days} ${days === 1 ? "day" : "days"}`;
}

/** How long ago, in words: "just now", "12 minutes ago", "2 days ago". */
export function agoWords(ms) {
  return ms < 2 * MINUTE ? "just now" : `${spanWords(ms)} ago`;
}

/** The calendar day of `at` in `timeZone`, as a number of days since 1970, so two of them subtract to whole days. */
function dayNumber(at, timeZone) {
  const parts = new Intl.DateTimeFormat("en-US", { timeZone, year: "numeric", month: "numeric", day: "numeric" }).formatToParts(new Date(at));
  const get = (type) => Number(parts.find((part) => part.type === type)?.value);
  return Math.round(Date.UTC(get("year"), get("month") - 1, get("day")) / DAY);
}

/** How many calendar days before `now` the day of `at` was, in words: "today", "yesterday", "3 days ago". */
export function dayAgo(at, now, timeZone = "UTC") {
  const days = dayNumber(now, timeZone) - dayNumber(at, timeZone);
  if (days <= 0) return "today";
  if (days === 1) return "yesterday";
  return `${days} days ago`;
}

const WHEN = (timeZone) => new Intl.DateTimeFormat("en-US", { timeZone, month: "short", day: "numeric", hour: "numeric", minute: "2-digit" });
const whenOf = (at, timeZone) => WHEN(timeZone).format(new Date(at)).replace(/ /g, " ");

/**
 * The turn's words about time, "" when there is nothing to say: how long the chat was quiet before the texts this
 * turn answers, and which old text any of them was typed under. Said in the person's turn (`runTheModel.js`
 * `turnNote`), never the cached system prompt.
 */
export function timeNote({ covered = [], shown = [], byId = new Map(), timeZone = "UTC" }) {
  const people = covered.filter((event) => event.from?.kind === "person" && Number.isFinite(event.at));
  if (people.length === 0) return "";
  const first = Math.min(...people.map((event) => event.at));
  const newest = Math.max(...people.map((event) => event.at));
  const lines = [];
  const before = shown.filter((event) => Number.isFinite(event.at) && event.at < first && event.kind !== "reaction" && event.kind !== "delivery").at(-1);
  if (before !== undefined && first - before.at >= LULL_MS) {
    lines.push(`Before this text the chat had been quiet for ${spanWords(first - before.at)} (the last text before it was ${whenOf(before.at, timeZone)}). Treat it as a fresh start unless it picks up something from before.`);
  }
  for (const event of people) {
    const to = typeof event.replyTo === "string" ? byId.get(event.replyTo) : undefined;
    if (to === undefined || !Number.isFinite(to.at) || newest - to.at < LATE_REPLY_MS) continue;
    lines.push(`This text replies to a message from ${whenOf(to.at, timeZone)}, ${agoWords(newest - to.at)}: pick that conversation back up, not just the newest one.`);
    break;
  }
  return lines.join("\n");
}
