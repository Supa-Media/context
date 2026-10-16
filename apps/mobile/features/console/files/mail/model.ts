/**
 * The words the mail section is drawn with (`extension.ts`), kept apart from
 * the DOM so they can be tested on their own.
 */

import { EVERYONE, type MailEvent } from "@context/shared/src/mail.cjs";

/** "4 min ago", "2 h ago", "yesterday", or a date. */
export function agoLabel(at: string, now: number = Date.now()): string {
  const time = Date.parse(at);
  if (Number.isNaN(time)) return "";
  const minutes = Math.max(0, Math.floor((now - time) / 60_000));
  if (minutes < 1) return "just now";
  if (minutes < 60) return `${minutes} min ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours} h ago`;
  if (hours < 48) return "yesterday";
  return new Date(time).toLocaleDateString(undefined, { month: "short", day: "numeric" });
}

/** The time beside one entry: the clock today, the date and the clock before. */
export function timeLabel(at: string, now: number = Date.now()): string {
  const time = Date.parse(at);
  if (Number.isNaN(time)) return "";
  const date = new Date(time);
  const clock = date.toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" });
  if (date.toDateString() === new Date(now).toDateString()) return clock;
  // An English month name either way, so a reader and a test both know it is a date.
  const month = date.toLocaleDateString("en-US", { month: "short" });
  return `${month} ${date.getDate()}, ${clock}`;
}

function listed(names: string[]): string {
  if (names.length <= 1) return names.join("");
  return `${names.slice(0, -1).join(", ")} and ${names[names.length - 1]}`;
}

/** The one line the folded section shows. */
export function foldedSummary(events: MailEvent[], now: number = Date.now()): string {
  const messages = events.filter((event) => event.kind === "mail");
  if (messages.length === 0) {
    const joined = [...new Set(events.map((event) => event.from))];
    return joined.length ? `Mail · ${listed(joined)} joined` : "Mail";
  }
  const last = messages[messages.length - 1];
  return `Mail · ${messages.length} · last from ${last.from} ${agoLabel(last.at, now)}`;
}

/** Who a message from this box can go to: everyone, then each name that joined. */
export function recipients(events: MailEvent[]): string[] {
  const names = events.filter((event) => event.kind === "joined").map((event) => event.from);
  return [EVERYONE, ...new Set(names.filter((name) => !name.startsWith("@")))];
}
