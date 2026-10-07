/**
 * Search by meaning, in a workspace's settings: the words the card shows.
 *
 * On for every workspace by default (the owner's call, 2026-10-07), so the
 * switch reads On before anything is built ("waiting"), and an owner's Off
 * deletes the index and stays off. The backend contract is
 *
 *   meaningSearch.status({ workspaceId })
 *     -> { state, canChange, notesIndexed?, notesPending? }
 *   meaningSearch.set({ workspaceId, on })   // owner-only
 *
 * The counts come back only to an owner: they count private notes too.
 * Pure, so the copy is pinned by `meaningSearchCard.test.ts`.
 */

export type MeaningSearchState = "on" | "preparing" | "waiting" | "failed" | "off";

export interface MeaningSearchStatus {
  state: MeaningSearchState;
  canChange: boolean;
  notesIndexed?: number;
  notesPending?: number;
}

export const MEANING_CARD_TITLE = "Search by meaning";

/** What it does and what it keeps, in the words a person needs to decide. */
export const MEANING_CARD_BLURB =
  "Finds notes about what you typed, even when they use different words. " +
  "To do that, Context keeps a fingerprint of what each note is about, never its text. " +
  "Turning it off deletes the fingerprints.";

/** What pressing Off a second time does, said at the moment of the press. */
export const MEANING_OFF_HINT =
  "The fingerprints are deleted. Your notes are untouched, and search goes back to " +
  "matching your words. Turning this on again builds them from scratch.";

/** Is the switch in the on position? Everything but an owner's off is. */
export function meaningSwitchOn(state: MeaningSearchState): boolean {
  return state !== "off";
}

/** The word beside the switch. */
export function meaningStateWord(state: MeaningSearchState): string {
  switch (state) {
    case "on":
      return "On";
    case "preparing":
      return "Getting ready";
    case "waiting":
      return "Starting soon";
    case "failed":
      return "Couldn't start";
    case "off":
      return "Off";
  }
}

/**
 * "340 of 1,204 notes ready", while it is getting ready, for an owner. `null`
 * when there is nothing honest to say: not preparing, or no counts (a member,
 * or before the first pass has reported).
 */
export function meaningProgress(status: MeaningSearchStatus): string | null {
  if (status.state !== "preparing") return null;
  if (status.notesIndexed === undefined || status.notesPending === undefined) return null;
  const total = status.notesIndexed + status.notesPending;
  if (total === 0) return null;
  const format = (n: number) => n.toLocaleString("en-US");
  return `${format(status.notesIndexed)} of ${format(total)} notes ready`;
}

/** Shown under the card when the switch cannot be pressed. */
export function meaningReadOnlyNote(demo: boolean): string {
  return demo
    ? "Sign in and open your own workspace to decide this for it."
    : "Only an owner of this workspace can change this.";
}
