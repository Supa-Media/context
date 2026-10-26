/**
 * What a path-based file operation says now that every workspace keeps its
 * notes under their ids (`docs/decisions/storage-and-credentials/notes-by-id.md`).
 *
 * A note's bytes live only at `notes/<noteId>.md` and the object at its path is
 * a frozen copy nothing reads again. Anything that lists the bucket by name, or
 * moves and retires objects by path, is wrong there, and refuses with this.
 */

/** What a path-based operation says. Nothing is changed. */
export const KEYED_REFUSAL =
  "This workspace keeps its notes under their ids, and this operation works on paths, so it is not available in a keyed workspace yet. Nothing was changed.";
