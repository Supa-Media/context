/** What one search found, and whether there was an index to find it in. */
export interface SearchAnswer {
  hits: { path: string; title: string; snippets: string[] }[];
  /**
   * Nothing has indexed this context yet, so this is not "no matches" — see
   * `searchNotes` in the control plane's `lib/fileOps.ts`.
   */
  indexMissing: boolean;
  /**
   * The index is behind the bucket, so an empty answer may simply be a note
   * the backfill has not reached. Distinguishing this is the difference
   * between "you have not written that down" and "we have not read it yet",
   * and the first is a lie the console is not entitled to tell.
   */
  indexIncomplete: boolean;
  /**
   * Some of this caller's own visible notes hold more messages than the
   * search index can keep in full, so a term that only appeared in a
   * message the index had to drop will not surface here even though the
   * note itself still exists.
   *
   * The opposite claim from `indexIncomplete`, and never folded into it:
   * that one means "a pass helps, ask again"; this one does not resolve by
   * searching again — a shed note stays that way until it shrinks or the
   * index gets more room. See `docs/decisions/search.md`, "A shed index
   * must say so to the caller it happened to", and the same fact as
   * `apps/mcp/src/index.js`'s `toolSearchNotes` and `orient` render for an
   * AI client — this must not tell a person a fourth, different story.
   */
  reducedRecall: boolean;
  /**
   * Which of the caller's own visible notes those are.
   *
   * Already filtered through this scope's `canSee` on the server, the same
   * as every path in `hits` — safe to render as-is. Never truncated here:
   * `reducedRecallMessage` in `useContextSearch.ts` is where the rendered
   * list is bounded, so a programmatic reader of this field still gets the
   * whole thing.
   */
  reducedRecallNotes: string[];
}

/** Another context something can be moved into, as the picker prints it. */
export interface MoveDestination {
  id: string;
  /** The addressable name, with its `@`. */
  label: string;
  displayName: string;
}

/**
 * A move out of this context, while it runs and for a while after.
 *
 * A move between contexts is the one file operation the console does not
 * finish inside the press: the bytes cross a tenancy boundary a batch at a
 * time, and a folder can be arbitrarily large. So it reports rather than
 * blocks — `objects` climbs, and `status` settles on something a person can
 * act on.
 */
export interface ContextMoveProgress {
  id: string;
  from: string;
  to: string;
  /** Where it is going, as `@name`. The id where the name is not known. */
  destination: string;
  status: "moving" | "complete" | "failed";
  /** Notes and files landed at the other end and removed from this one. */
  objects: number;
  /**
   * What stayed behind, and why it had to.
   *
   * Today that is one reason — a note encrypted to this context's key, whose
   * ciphertext elsewhere is a note nobody could ever open. Reported rather
   * than swallowed: "moved, except for three of them" is a fact the person
   * needs before they go looking in the other context.
   */
  skipped: readonly { path: string; reason: "encrypted" }[];
  error?: string;
}

/**
 * A note this console renamed: `from` is where it was, `to` where it is now.
 *
 * A new `id` per rename, so renaming a note back — an undo — is a change the
 * tab strip sees rather than a value equal to one it has already followed.
 */
export interface NoteRename {
  id: number;
  from: string;
  to: string;
}
