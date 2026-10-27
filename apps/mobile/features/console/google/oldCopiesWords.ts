/**
 * What the Old copies row and page say (board b1 of `remove-copies`, approved
 * by Dev2 2026-10-21): the copies Context made of mail, calendar and chat
 * before it stopped, hidden from the notes and still in Download as folders.
 * Plain functions, so every sentence is checked without rendering.
 */

/** The server's `oldCopies.summary`, as the console reads it. */
export interface OldCopiesSummary {
  state: "hiding" | "hidden" | "deleting" | "deleted";
  days: number;
  contacts: number;
  files: number;
  firstDay: string | null;
  lastDay: string | null;
  since: number;
  /** Why hiding is waiting: a row-move refusal (`busy`, `not_served`, `not_keyed`), or `null`. */
  problem: string | null;
  addresses: string[];
}

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

const count = (n: number) => n.toLocaleString("en-US");
const plural = (n: number, one: string, many: string) => `${count(n)} ${n === 1 ? one : many}`;

/** `2026-09-07` as "Sep 7". */
export function shortDay(day: string): string {
  const [, month, date] = day.split("-").map(Number);
  return `${MONTHS[month - 1]} ${date}`;
}

/** A moment as "Oct 22", in the reader's own day. */
function shortDate(at: number): string {
  const when = new Date(at);
  return `${MONTHS[when.getMonth()]} ${when.getDate()}`;
}

/** "a", "a and b", "a, b and c". */
function listed(words: readonly string[]): string {
  if (words.length <= 1) return words.join("");
  return `${words.slice(0, -1).join(", ")} and ${words[words.length - 1]}`;
}

/** The row's title, and the page's: what is there, by what a person would call it. */
export function oldCopiesTitle(summary: OldCopiesSummary): string {
  if (summary.days + summary.contacts + summary.files === 0) return "Copies of mail, calendar and chat";
  if (summary.days > 0) return `${plural(summary.days, "day", "days")} of mail, calendar and chat`;
  if (summary.contacts > 0) return plural(summary.contacts, "contact page", "contact pages");
  return plural(summary.files, "mail attachment", "mail attachments");
}

/** The line under the row in Mail and calendar. */
/** Why hiding is waiting, in words: what holds it, and that it is tried again. */
function waitingLine(problem: string): string {
  const why =
    problem === "busy"
      ? "Another move in this workspace is still running"
      : problem === "not_served" || problem === "not_keyed"
        ? "Your notes are still being set up"
        : "Something stopped it";
  return `Not hidden yet. ${why}; Context tries again every 10 minutes.`;
}

export function oldCopiesRowLine(summary: OldCopiesSummary): string {
  if (summary.state === "deleting") return "Deleting them now.";
  if (summary.state === "hiding" && summary.problem !== null) return waitingLine(summary.problem);
  if (summary.state === "hiding") return "Being hidden from your notes, search and AI now. Still in Download as folders.";
  return `Copied before ${shortDate(summary.since)}. Hidden from your notes, search and AI. Still in Download as folders.`;
}

/** The page's opening card: where they came from, which days, and that the originals are untouched. */
export function oldCopiesFrom(summary: OldCopiesSummary): string {
  const from = summary.addresses.length > 0 ? `From ${listed(summary.addresses)}` : "";
  const span = summary.firstDay !== null && summary.lastDay !== null
    ? summary.firstDay === summary.lastDay
      ? shortDay(summary.firstDay)
      : `${shortDay(summary.firstDay)} to ${shortDay(summary.lastDay)}`
    : "";
  const head = [from, span].filter(Boolean).join(", ");
  return `${head ? `${head}. ` : ""}Your mail is still in Gmail; these are only Context's copies.`;
}

export const KEEP_TITLE = "Keep them hidden";
export const KEEP_LINE = "Nothing changes. They stay in your storage and in Download as folders.";
export const DELETE_TITLE = "Delete the copies";

/** What goes, said before the second press: "696 days and 1,306 contact pages". */
export function whatGoes(summary: OldCopiesSummary): string {
  const parts = [
    summary.days > 0 ? plural(summary.days, "day", "days") : null,
    summary.contacts > 0 ? plural(summary.contacts, "contact page", "contact pages") : null,
    summary.files > 0 ? plural(summary.files, "attachment", "attachments") : null,
  ].filter((part): part is string => part !== null);
  return listed(parts);
}

/** The red line under Delete the copies, before and after the first press. */
export function deleteLine(summary: OldCopiesSummary, armed: boolean): string {
  if (summary.state === "hiding") return "Available once they are all hidden.";
  if (summary.state === "deleting") return "Deleting them now.";
  return armed
    ? `Press again to delete ${whatGoes(summary)}. This can't be undone.`
    : `Deletes ${whatGoes(summary)} from your storage. This can't be undone.`;
}
