/**
 * Every word auto-organize puts on screen, in one place.
 *
 * Plain and short, and about the workspace rather than the machinery: never
 * "model", "inference" or a vendor's name, and "workspace", never "brain". The
 * reasons themselves come from the server as one clause about the notes ("Its
 * fix merged 2 days ago"); this file frames them.
 */

import type { OrganizerKind, OrganizerSuggestion, SweepWhy } from "./types";

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
  foundBody: "Nothing has moved. Have a look and keep what’s right.",
  show: "Show me",
  later: "Later",
};

export function sweepReadingTitle(slug: string): string {
  return `Tidying up ${slug.startsWith("@") ? slug : `@${slug}`}`;
}

export function sweepCount({ read, total }: { read: number; total: number }): string {
  return `${Math.min(read, total)} of ${total} notes`;
}

/** "Found 4 projects that look done and 7 inbox notes to file". */
export function sweepFoundTitle(found: Record<OrganizerKind, number>): string {
  const parts: string[] = [];
  if (found.done > 0) {
    parts.push(`${found.done} ${plural(found.done, "project that looks done", "projects that look done")}`);
  }
  if (found.archive > 0) {
    parts.push(`${found.archive} ${plural(found.archive, "finished project", "finished projects")} to archive`);
  }
  if (found.file > 0) {
    parts.push(`${found.file} ${plural(found.file, "inbox note", "inbox notes")} to file`);
  }
  if (parts.length <= 1) return `Found ${parts[0] ?? "nothing to tidy"}`;
  return `Found ${parts.slice(0, -1).join(", ")} and ${parts[parts.length - 1]}`;
}

export function suggestionsLine(n: number): string {
  return `${n} ${plural(n, "suggestion", "suggestions")}`;
}

export function phoneLine(n: number): string {
  return `${suggestionsLine(n)} to look over`;
}

export const reviewCopy = {
  phoneOpen: "Look over",
};

/** The row's second line: the question, with its reason. */
export function reviewMeta(s: OrganizerSuggestion): string {
  switch (s.kind) {
    case "done":
      return `Mark done? ${s.reason}`;
    case "archive":
      return `Archive? ${s.reason}`;
    case "file":
      return s.target === undefined ? s.reason : `File in ${s.target.title}?`;
  }
}

/** The sweep card's preview: what it found, stated rather than asked. */
export function previewWhy(s: OrganizerSuggestion): string {
  if (s.kind === "done") return `Looks done. ${s.reason}`;
  return reviewMeta(s);
}

/** "0-inbox/meetings" → "Inbox › Meetings": a folder as a person names it. */
export function placeName(path: string): string {
  const folders = path.split("/").slice(0, -1);
  if (folders.length === 0) return "the top level";
  return folders
    .map((segment) => {
      const words = segment.replace(/^\d+-/, "").replace(/[-_]+/g, " ").trim();
      return words.charAt(0).toUpperCase() + words.slice(1);
    })
    .join(" › ");
}

/** The row's heading: what will happen, as a verb. */
export function actionLine(s: OrganizerSuggestion): string {
  switch (s.kind) {
    case "done":
      return "Mark as done";
    case "archive":
      return "Move to Archive";
    case "file":
      return s.target === undefined ? "File it" : `Move to ${s.target.title}`;
  }
}

/** The row's last line: from where to where, or why. */
export function whereLine(s: OrganizerSuggestion): string {
  switch (s.kind) {
    case "done":
      return s.reason;
    case "archive":
      return s.reason ? `${s.reason.replace(/[.!?]?$/, ".")} Nothing is deleted.` : "Nothing is deleted.";
    case "file":
      return s.target === undefined
        ? s.reason
        : `From ${placeName(s.path)} to ${placeName(`${s.target.path}/x`)}`;
  }
}

/** The row's buttons, said as what they do. */
export function acceptButton(s: OrganizerSuggestion): string {
  return s.kind === "done" ? "Mark done" : s.kind === "archive" ? "Archive" : "Move";
}
export const skipButton = "Skip";

export function acceptLabel(s: OrganizerSuggestion): string {
  switch (s.kind) {
    case "done":
      return `Mark done: ${s.title}`;
    case "archive":
      return `Archive: ${s.title}`;
    case "file":
      return s.target === undefined ? `File ${s.title}` : `File ${s.title} in ${s.target.title}`;
  }
}

export function dismissLabel(s: OrganizerSuggestion): string {
  return `Not now: ${s.title}`;
}

export function acceptedToast(s: OrganizerSuggestion): string {
  switch (s.kind) {
    case "done":
      return `Marked ${s.title} done.`;
    case "archive":
      return `Archived ${s.title}.`;
    case "file":
      return s.target === undefined ? `Filed ${s.title}.` : `Filed ${s.title} in ${s.target.title}.`;
  }
}

const OFFER_REASON: Record<OrganizerKind, string> = {
  done: "You’ve marked 3 projects done.",
  archive: "You’ve archived 3 finished projects.",
  file: "You’ve filed 3 inbox notes.",
};

/** After the third accept of one kind: why we are asking, then the question. */
export function offerToast(kind: OrganizerKind): string {
  return `${OFFER_REASON[kind]} Do this automatically from now on?`;
}

export const offerAction = "Yes, automatically";

/** Our sentence for a press that did not go through. Never the server's. */
export const resolveFailed = "That did not go through. The note may have changed; have another look.";
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
  lookOver: "Look over",
};

export function sortRunning({ read, total }: { read: number; total: number }): string {
  return total === 0 ? "Sorting now…" : `Sorting now · ${sweepCount({ read, total })}`;
}

/** "Sorted 3 hours ago. 4 suggestions waiting." */
export function sortDone(ago: string, pending: number): string {
  const waiting = pending > 0 ? `${suggestionsLine(pending)} waiting.` : "Nothing waiting.";
  return `Sorted ${ago}. ${waiting}`;
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
