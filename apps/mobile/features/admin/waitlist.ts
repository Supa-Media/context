/**
 * The Waitlist tab's words and small arithmetic, kept apart from the screen
 * so the sentences somebody reads after a press are one place to change.
 *
 * Every sentence says what happened, in the counts the server returned —
 * `changed`, not the number of rows pressed. Pressing Let in on somebody
 * already let in changes nothing and mails nobody, and "Let 2 people in"
 * over a selection where one was already in would be a small lie.
 */

import { shortDay } from "./report";

export type WaitlistStatus = "waiting" | "admitted" | "removed";

/** One row, as `listWaitlist` returns it. */
export interface WaitlistRow {
  id: string;
  email: string;
  status: WaitlistStatus;
  joinedAt: number;
  source: string;
  useFor: string | null;
  admittedAt: number | null;
}

/** The three lists, in the order the filter shows them. */
export const WAITLIST_FILTERS: readonly { key: WaitlistStatus; label: string }[] = [
  { key: "waiting", label: "Waiting" },
  { key: "admitted", label: "Let in" },
  { key: "removed", label: "Removed" },
];

/** `1 person`, `2 people`. */
export function people(count: number): string {
  return count === 1 ? "1 person" : `${count} people`;
}

/** After Let in, on a row or a selection. */
export function admittedSentence(changed: number): string {
  if (changed === 0) return "Nobody new to let in.";
  return `Let ${people(changed)} in. They'll get an email.`;
}

/** After Remove. They are not told, so the sentence does not say they are. */
export function removedSentence(changed: number): string {
  if (changed === 0) return "Nobody was removed.";
  return `Removed ${people(changed)}.`;
}

/** A day of the month and a month, in UTC like the rest of the console. */
export function shortDate(at: number): string {
  return shortDay(new Date(at).toISOString().slice(0, 10));
}
