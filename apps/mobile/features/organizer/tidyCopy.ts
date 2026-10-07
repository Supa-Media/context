/**
 * Every word the What changed page's Tidy up tab puts on screen (boards 10
 * and 11 of the What changed canvas, 2026-10-07): the suggestions about
 * notes the owner already has, grouped by what they would do.
 *
 * Same rules as `./copy.ts`. A title or folder name comes out of somebody's
 * bucket, so it is contained wherever it is spoken.
 */

import { isolateForDisplay } from "@context/shared/src/displayText.cjs";
import { placeName } from "./copy";
import type { OrganizerKind, OrganizerSuggestion } from "./types";

export const tidyCopy = {
  tabInbox: "From your inbox",
  tabTidy: "Tidy up",
  lede: "Suggestions for your notes. Nothing changes until you say so.",
  inboxLede: "Read from the meetings, email and chats that land in your inbox.",
  heroTitle: "Notes you already have that could be put away",
  heroLede: "Each one is a tap, and each one has an Undo.",
  progress: (done: number, all: number) => `${done} of ${all} done`,
  allTidy: "All tidy",
  allTidyLede: "Nothing to tidy right now. New ones show up here as your notes change.",
  loading: "Reading your notes…",
  failed: "These did not load. Check your connection and try again.",
  skip: "Skip",
  undo: "Undo",
  undone: "Put back",
  more: (n: number) => `${n} more`,
  less: "Show fewer",
  settings: "Tidy up settings",
  didMany: (done: readonly OrganizerSuggestion[]) => {
    const n = done.length;
    const kind = done[0]?.kind;
    if (n === 1) return handled(done[0]);
    if (kind === "done") return `Marked ${n} projects done. Each one has an Undo here.`;
    if (kind === "archive") return `Archived ${n} notes. Nothing was deleted.`;
    return `Moved ${n} notes. Each one has an Undo here.`;
  },
};

export interface TidyGroup {
  kind: OrganizerKind;
  title: string;
  lede: string;
  /** The button that answers the whole group. */
  all: (n: number) => string;
  /** The button on one row. */
  one: string;
}

/** The groups, in the order the page draws them. */
export const TIDY_GROUPS: readonly TidyGroup[] = [
  {
    kind: "done",
    title: "Looks finished",
    lede: "Mark these projects done. They move to Done on the board.",
    all: (n) => (n === 2 ? "Mark both done" : `Mark all ${n} done`),
    one: "Done",
  },
  {
    kind: "file",
    title: "Belongs somewhere else",
    lede: "Move these notes out of your inbox, next to what they’re about.",
    all: (n) => (n === 2 ? "Move both" : `Move all ${n}`),
    one: "Move",
  },
  {
    kind: "archive",
    title: "Quiet for a while",
    lede: "Put these in Archive. Nothing is deleted.",
    all: (n) => (n === 2 ? "Archive both" : `Archive all ${n}`),
    one: "Archive",
  },
];

/** "Projects › Custom domains": where a move would put it, or `null` when it has nowhere named to go. */
export function moveTo(s: OrganizerSuggestion): string | null {
  return s.kind === "file" && s.target !== undefined ? isolateForDisplay(placeName(`${s.target.path}/x`)) : null;
}

/** The line a row leaves behind once it is answered: "Code decomposition marked done". */
export function handled(s: OrganizerSuggestion | undefined): string {
  if (s === undefined) return "";
  const title = isolateForDisplay(s.title);
  if (s.kind === "done") return `${title} marked done`;
  if (s.kind === "archive") return `${title} archived`;
  return s.target === undefined ? `${title} moved` : `${title} moved to ${isolateForDisplay(s.target.title)}`;
}

/** The line a skipped row leaves behind. */
export function skipped(s: OrganizerSuggestion): string {
  return `${isolateForDisplay(s.title)} skipped`;
}
