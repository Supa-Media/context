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
  /** The landing page (`/a` to `/c`) the person saw before joining, if recorded. */
  landing?: string;
  /** The ad that sent them, `meta / spring / video-2`, if recorded. */
  campaign?: string;
}

/** Joins per landing page and ad, as `waitlistLandingCounts` returns them. */
export interface LandingCount {
  landing: string;
  /** Absent on joins no ad sent. */
  campaign?: string;
  joined: number;
  admitted: number;
}

/** Who a row is: the address, or the phone it joined with. */
export function rowName(row: Pick<WaitlistRow, "email" | "phone">): string {
  return row.email ?? row.phone ?? "";
}

/**
 * Where a row came from as its small label, `page c`, `page b · meta / spring`,
 * or `null` when nothing was recorded.
 */
export function pageLabel(landing: string | undefined, campaign?: string): string | null {
  const parts = [landing === undefined ? null : `page ${landing}`, campaign ?? null].filter((part) => part !== null);
  return parts.length === 0 ? null : parts.join(" · ");
}

/** The one-line summary above the list, `Joined from: a 12 · b 4 · none 30`, or `null` for none yet. */
export function landingSentence(counts: readonly LandingCount[]): string | null {
  if (counts.length === 0) return null;
  const pages = new Map<string, number>();
  for (const count of counts) pages.set(count.landing, (pages.get(count.landing) ?? 0) + count.joined);
  return `Joined from: ${[...pages].map(([landing, joined]) => `${landing} ${joined}`).join(" · ")}`;
}

/** The second line, for joins an ad sent: `From ads: a meta / spring 5 · b x 2`, or `null` for none. */
export function adsSentence(counts: readonly LandingCount[]): string | null {
  const ads = counts.filter((count) => count.campaign !== undefined);
  if (ads.length === 0) return null;
  return `From ads: ${ads.map((count) => `${count.landing} ${count.campaign} ${count.joined}`).join(" · ")}`;
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
  return `Let ${people(changed)} in. They'll get an email, or a text if they joined by phone.`;
}

/** People let in by phone before Let in texted anyone, and never told. */
export function untoldSentence(count: number): string {
  return `${people(count)} let in by phone before we sent texts never heard they're in.`;
}

/** After Text them; `left` is more than one press could take. */
export function untoldTextedSentence(texted: number, left: number): string {
  if (texted === 0) return "Nobody left to text.";
  const more = left > 0 ? ` ${people(left)} left: press Text them again.` : "";
  return `Texted ${people(texted)} that they're in.${more}`;
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
