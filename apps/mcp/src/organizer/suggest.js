/**
 * Auto-organize: answers and facts in, suggestions out.
 *
 * Three kinds, each with the rule that makes it:
 *
 * - **done** — an open project Jev reads as finished, where the note itself
 *   backs that up: it says the work shipped, or every checklist item is
 *   ticked, and it lists no open next steps.
 * - **archive** — a project whose status already says it is finished and whose
 *   folder has been quiet for `ARCHIVE_QUIET_DAYS`. No model is asked: this is
 *   arithmetic on facts the listing already has.
 * - **file** — an inbox note whose best destination is a folder rather than
 *   "leave it", chosen with at least even odds.
 *
 * A suggestion is only ever a proposal. Nothing here moves or writes a note.
 */

import { destinationKey, spokenSpan } from "./questions.js";

export const ARCHIVE_QUIET_DAYS = 14;
const FILE_MIN_PROBABILITY = 0.5;

/** A short stable id: FNV-1a over what the suggestion is about. */
export function suggestionId(kind, path, target = "") {
  let hash = 0x811c9dc5;
  for (const char of `${kind}\u0000${path}\u0000${target}`) {
    hash ^= char.codePointAt(0);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return `${kind}-${hash.toString(16).padStart(8, "0")}`;
}

/** The one reason shown under the project, in words a person would use. */
function doneReason(facts, answers) {
  const total = facts.boxes.done + facts.boxes.open;
  if (total > 0 && facts.boxes.open === 0) return "Every step is ticked off";
  if (answers.shipped.noul >= 0.5) {
    return facts.quiet !== null && facts.quiet >= 7
      ? `It says the work shipped, and it's been quiet for ${spokenSpan(facts.quiet)}`
      : "It says the work shipped";
  }
  return "It reads as finished";
}

export function doneSuggestion(project, facts, answers) {
  if (!facts.status || facts.closed || facts.optedOut) return null;
  if (answers?.stage?.choice !== "done") return null;
  const total = facts.boxes.done + facts.boxes.open;
  const allTicked = total > 0 && facts.boxes.open === 0;
  if (!(answers.shipped?.noul >= 0.5 || allTicked)) return null;
  if (!(answers.open_steps?.noul < 0.5)) return null;
  return {
    id: suggestionId("done", project.frontPath),
    kind: "done",
    path: project.frontPath,
    title: facts.title,
    reason: doneReason(facts, answers),
    status: facts.status,
    etag: project.etag ?? null,
  };
}

export function archiveSuggestion(project, facts) {
  if (!facts.closed || facts.optedOut) return null;
  if (facts.quiet === null || facts.quiet < ARCHIVE_QUIET_DAYS) return null;
  return {
    id: suggestionId("archive", project.path),
    kind: "archive",
    path: project.path,
    title: facts.title,
    reason: `Done, and quiet for ${spokenSpan(facts.quiet)}`,
    etag: project.kind === "note" ? project.etag ?? null : null,
  };
}

export function fileSuggestion(note, title, destinations, answers) {
  const answer = answers?.destination;
  if (!answer || answer.choice === "stay") return null;
  const index = destinations.findIndex((_, at) => destinationKey(at) === answer.choice);
  if (index === -1) return null;
  if (!((answer.probabilities?.[answer.choice] ?? 0) >= FILE_MIN_PROBABILITY)) return null;
  const target = destinations[index];
  // Already there, or a folder filed into itself: nothing to suggest.
  if (note.path.startsWith(`${target.path}/`)) return null;
  return {
    id: suggestionId("file", note.path, target.path),
    kind: "file",
    path: note.path,
    title,
    reason: note.meeting ? "A meeting about it" : "",
    target: { path: target.path, title: target.title },
    etag: note.etag ?? null,
  };
}
