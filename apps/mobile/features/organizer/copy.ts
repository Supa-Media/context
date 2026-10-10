/**
 * Every word auto-organize puts on screen, in one place.
 *
 * Plain and short, and about the workspace rather than the machinery: never
 * "model", "inference" or a vendor's name, and "workspace", never "brain". The
 * reasons themselves come from the server as one clause about the notes ("Its
 * fix merged 2 days ago"); this file frames them.
 */

import type { OrganizerKind, SweepWhy } from "./types";

/** The name automatic changes are recorded under in Activity. */
export const ORGANIZER_ACTOR = "Context organizer";

const plural = (n: number, one: string, many: string) => (n === 1 ? one : many);

export const includedLine = {
  title: "Auto-organize",
  tag: "Included",
  body: "Context reads your notes and suggests what to file, mark done and archive. It starts when Premium does, and you can turn it off anytime.",
};

export const sweepCopy = {
  readingBody: "Reading your projects and inbox. Nothing moves without you.",
};

export function sweepReadingTitle(slug: string): string {
  return `Tidying up ${slug.startsWith("@") ? slug : `@${slug}`}`;
}

export function sweepCount({ read, total }: { read: number; total: number }): string {
  return `${Math.min(read, total)} of ${total} notes`;
}

export function phoneLine(n: number): string {
  return `${n} ${plural(n, "change", "changes")} to look over`;
}

export const reviewCopy = {
  phoneOpen: "Look over",
};

/** Our sentence for an Undo that did not go through. Never the server's. */
export const undoFailed = "That could not be undone just now.";

export const settingsCopy = {
  title: "Auto-organize",
  body: "Suggests what to file, mark done and archive in this workspace. Nothing moves until you say so.",
  withoutAsking: "Without asking",
  withoutAskingHint: "Things you’ve told Context to just do. Each one shows in Activity with an Undo.",
  offNote:
    "Turning it off stops it right away and clears waiting suggestions. What you accepted or dismissed stays in your storage with your notes.",
  memberNote: "Only the owner can turn auto-organize on or off.",
  on: "On",
  off: "Off",
};

/** Why it didn't finish, in the owner's terms. */
export const sortWhy: Record<SweepWhy, string> = {
  daily_cap: "It reached today’s limit and will carry on tomorrow.",
  no_answers: "The sorting service didn’t answer.",
  error: "It couldn’t read your notes.",
  switched_off: "Sorting is paused on our side.",
  disabled: "Sorting is paused on our side.",
  unconfigured: "Sorting is paused on our side.",
  not_premium: "Sorting comes with Premium.",
};

/** The card's status line: whether it is sorting, and when it last did. */
export const sortCopy = {
  never: "Hasn’t sorted yet.",
  failed: (ago: string, why?: SweepWhy) => {
    const line = `The last sort didn’t finish (${ago}).`;
    return why ? `${line} ${sortWhy[why]}` : line;
  },
  sortNow: "Sort now",
  tryAgain: "Try again",
};

export function sortRunning({ read, total }: { read: number; total: number }): string {
  return total === 0 ? "Sorting now…" : `Sorting now · ${sweepCount({ read, total })}`;
}

/** "Sorted 3 hours ago." */
export function sortDone(ago: string): string {
  return `Sorted ${ago}.`;
}

/** The "Without asking" switches, in the order they are drawn. */
export const KIND_LABELS: Record<OrganizerKind, string> = {
  done: "Mark finished projects done",
  archive: "Archive finished projects",
  file: "File inbox notes",
};

export const existingCopy = {
  body: "Premium now includes auto-organize. From tomorrow, Context reads your notes and suggests what to file and mark done. Nothing moves without you.",
  off: "Turn off",
  ok: "Got it",
};
