/**
 * Auto-organize, as the control plane describes it.
 *
 * These mirror `api.functions.organizer.*` (the contract lives with the
 * backend, in `apps/convex/functions/organizer.ts`). They are declared here
 * rather than read from the generated API so the app can be built, and can
 * draw nothing, before the backend exists in a deployment — see
 * `organizerApi.ts`.
 */

/** What a suggestion would do: mark a project done, archive it, or file an inbox note. */
export type OrganizerKind = "done" | "archive" | "file";

export const ORGANIZER_KINDS: readonly OrganizerKind[] = ["done", "archive", "file"];

export interface OrganizerSuggestion {
  /** Stable per (kind, path, target). */
  id: string;
  kind: OrganizerKind;
  /** The note or folder the suggestion is about. */
  path: string;
  /** How the tree names it: the project's name, or the note's. */
  title: string;
  /** One short clause about the workspace: "Its fix merged 2 days ago". */
  reason: string;
  /** Kind `file` only: where it would go. */
  target?: { path: string; title: string };
  /** Kind `done` only: the status it has now, e.g. "fix-in-review". */
  status?: string;
}

export interface OrganizerSweep {
  state: "running" | "done" | "failed";
  startedAt: number;
  finishedAt: number | null;
  /** Notes read so far, for "212 of 450 notes". */
  read: number;
  total: number;
  found: Record<OrganizerKind, number>;
}

export interface OrganizerStatus {
  /** The workspace is on a paying Premium plan. */
  available: boolean;
  /** The caller may switch it, and is the one who sees suggestions. */
  isOwner: boolean;
  on: boolean;
  /** An existing subscriber who has not seen the one-time notice. */
  noticeNeeded: boolean;
  /** The first sweep runs no earlier than this (ms), or `null` when none is scheduled. */
  startsAt: number | null;
  sweep: OrganizerSweep | null;
  /** Suggestions waiting, for "11 suggestions". */
  pending: number;
  /** "Without asking", per kind. */
  autopilot: Record<OrganizerKind, boolean>;
}

/**
 * What the server hands back to take an accepted change back. Opaque here:
 * the app never looks inside it, it only hands it back.
 */
export type UndoToken = unknown;

export interface ResolveResult {
  applied: boolean;
  /** Set when this accept makes the third of its kind in a row: offer autopilot. */
  offer: OrganizerKind | null;
  undo: UndoToken | null;
  error?: string;
}

export type OrganizerDecision = "accept" | "dismiss";
