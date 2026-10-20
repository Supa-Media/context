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
  /** When the answer was last written from the status page; `null` for one given at joining. */
  useForAt: number | null;
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

/**
 * The line beside the answer search: `7 people mention “calendar”`, `131 of
 * 214 waiting answered`, `No answers mention “zebra”.` A scan the server cut
 * short says "at least", because the oldest rows were not read.
 */
export function filterSentence(
  search: string,
  answered: boolean,
  result: { matches: number; capped: boolean },
  total: number | null,
): string | null {
  const term = search.trim();
  const atLeast = result.capped ? "at least " : "";
  if (term !== "") {
    if (result.matches === 0) return result.capped ? `No recent answers mention “${term}”.` : `No answers mention “${term}”.`;
    const verb = result.matches === 1 ? "mentions" : "mention";
    return `${atLeast}${people(result.matches)} ${verb} “${term}”`.replace(/^a/, "A");
  }
  if (!answered) return null;
  if (total === null || result.capped) return `${atLeast}${people(result.matches)} answered`.replace(/^a/, "A");
  return `${result.matches} of ${total} answered`;
}

/** An answer cut around a search term, so the term can be marked where it appears. */
export function highlightParts(text: string, term: string): { text: string; hit: boolean }[] {
  const needle = term.trim().toLowerCase();
  if (needle === "") return [{ text, hit: false }];
  const parts: { text: string; hit: boolean }[] = [];
  const lower = text.toLowerCase();
  let from = 0;
  for (let at = lower.indexOf(needle); at !== -1; at = lower.indexOf(needle, from)) {
    if (at > from) parts.push({ text: text.slice(from, at), hit: false });
    parts.push({ text: text.slice(at, at + needle.length), hit: true });
    from = at + needle.length;
  }
  if (from < text.length) parts.push({ text: text.slice(from), hit: false });
  return parts;
}

/** `edited 2h ago`, `edited 3d ago`, for an answer changed after joining. */
export function editedAgo(at: number, now: number): string {
  const minutes = Math.max(0, Math.round((now - at) / 60_000));
  if (minutes < 60) return minutes <= 1 ? "edited just now" : `edited ${minutes}m ago`;
  const hours = Math.round(minutes / 60);
  if (hours < 48) return `edited ${hours}h ago`;
  return `edited ${Math.round(hours / 24)}d ago`;
}
