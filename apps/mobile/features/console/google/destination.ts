import {
  normalizeDestinationFolder,
  resolveDestinationPattern,
  suggestDestinationFolders,
} from "@context/communications";

/**
 * What the destination editor should be showing, for whatever has been typed.
 *
 * ## Why this is a module and not three calls inside the component
 *
 * The field it serves used to be a plain `TextField` with a hint sentence under
 * it. No completion, no validation, no preview — the first thing that checked
 * the path was the mutation, which refused *after* Save, and the field is
 * narrower than the paths people put in it, so the value they were checking had
 * already scrolled out of view. Every one of the three things added to fix that
 * is a claim about somebody's mail, so each is decided here, in a pure
 * function, and pinned by `googleDestination.test.ts`.
 *
 * ## The rules are the server's, reached rather than restated
 *
 * `normalizeDestinationFolder` is `@context/communications/destination`, the
 * same function `updateGoogleSyncDestination` calls. That is the whole reason
 * this can validate at all: the console refuses in the server's words, before
 * the round trip, and cannot drift into refusing something the server allows or
 * — much worse — allowing something the server refuses and calling it saved.
 *
 * **The server still decides.** Nothing here is a substitute for the mutation's
 * own check; `problem` disables a button and draws a line, and a client with a
 * disabled button removed is still refused.
 */
export interface DestinationDraft {
  /** What to render under the field, or `null` while it is still fine. */
  problem: string | null;
  /** Whole folder paths, ready to replace what has been typed. */
  suggestions: readonly string[];
  /**
   * The key this pattern writes today, or `null` when there isn't one.
   *
   * The half the field was missing. A pattern carrying `YYYY-MM-DD` is a
   * template and nothing ever showed what the template produces, so the only
   * way to find out you were wrong was to wait for a sync.
   */
  preview: string | null;
  /** Whether Save should do anything. */
  canSave: boolean;
}

export function destinationDraft(input: {
  /** What is in the field right now. */
  value: string;
  /** What is stored, so an unchanged draft cannot be saved. */
  saved: string;
  /** Folders the console has already loaded — `loadedFolders(listings)`. */
  folders: readonly string[];
  /** Taken rather than read, so this stays pure and a test can pin the day. */
  now: Date;
}): DestinationDraft {
  const result = normalizeDestinationFolder(input.value);
  const suggestions = suggestDestinationFolders(input.value, input.folders);

  /*
    An empty field is not a problem *yet*. Somebody who has selected the whole
    value to retype it has an empty field for one keystroke, and "Choose a
    folder where synced files should land" flashing red under it is the
    interface telling them off for typing. Save is still off — `canSave` reads
    the result, not this — so nothing can be saved from the quiet state.
  */
  const typed = input.value.trim() !== "";
  const problem = result.ok || !typed ? null : result.message;

  /*
    Compared as folders rather than as strings. `0-inbox/mail`,
    `0-inbox/mail/`, and `0-inbox/mail/YYYY-MM-DD.md` are one destination
    spelled three ways, and a Save button that lights up for a trailing slash
    offers a write that changes nothing.
  */
  const savedFolder = normalizeDestinationFolder(input.saved);
  const unchanged = result.ok && savedFolder.ok && result.folder === savedFolder.folder;

  return {
    problem,
    suggestions,
    preview: resolveDestinationPattern(input.value, input.now),
    canSave: result.ok && !unchanged,
  };
}
