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
  /** One of the two is set: how the person joined (a phone since 2026-10-09). */
  email: string | null;
  phone: string | null;
  status: WaitlistStatus;
  joinedAt: number;
  source: string;
  useFor: string | null;
  admittedAt: number | null;
  /** The landing page (`/a` to `/e`) the person saw before joining, if recorded. */
  landing?: string;
}

/** Joins per landing page, as `waitlistLandingCounts` returns them. */
export interface LandingCount {
  landing: string;
  joined: number;
  admitted: number;
}

/** Who a row is: the address, or the phone it joined with. */
export function rowName(row: Pick<WaitlistRow, "email" | "phone">): string {
  return row.email ?? row.phone ?? "";
}

/** A row's landing page as its small label, `page c`, or `null` when none was recorded. */
export function pageLabel(landing: string | undefined): string | null {
  return landing === undefined ? null : `page ${landing}`;
}

/** The one-line summary above the list, `Joined from: a 12 · b 4 · none 30`, or `null` for none yet. */
export function landingSentence(counts: readonly LandingCount[]): string | null {
  if (counts.length === 0) return null;
  return `Joined from: ${counts.map((count) => `${count.landing} ${count.joined}`).join(" · ")}`;
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
