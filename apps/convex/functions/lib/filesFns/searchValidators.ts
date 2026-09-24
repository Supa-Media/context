/**
 * The search, note-path, forwarding and index-maintenance return validators.
 *
 * Split out of `functions/files.ts`, which registers every function that uses
 * them; that file's header holds the rules they keep.
 */

import { v } from "convex/values";

export const searchResultsValidator = v.object({
  kind: v.literal("searchResults"),
  hits: v.array(
    v.object({ path: v.string(), title: v.string(), snippets: v.array(v.string()) }),
  ),
  matchCount: v.number(),
  matchCountIsFloor: v.boolean(),
  indexIncomplete: v.boolean(),
  /**
   * Nothing has indexed this bucket yet. Distinct from "no matches" on
   * purpose — see `searchNotes` in `lib/fileOps.ts` on why collapsing the two
   * would tell somebody their note does not exist.
   */
  indexMissing: v.boolean(),
  /**
   * Some of this caller's own visible notes lost per-message recall to the
   * search index's own capacity, and never resolves by searching again —
   * `indexIncomplete`'s opposite claim, which is why it is a field of its own
   * rather than folded in (`docs/decisions/search.md`, sizing section).
   */
  reducedRecall: v.boolean(),
  /** Which of the caller's own visible notes those are — already `canSee`-filtered. */
  reducedRecallNotes: v.array(v.string()),
});

/**
 * `null` means the search index has nothing to answer link resolution from
 * yet — not "this bucket has no notes". See `notePathIndex` in
 * `lib/fileOps.ts`.
 */
export const notePathsValidator = v.object({
  kind: v.literal("notePaths"),
  paths: v.union(v.array(v.string()), v.null()),
});

/** The answer to `forward`: the same paths, each where it is now. */
export const forwardedValidator = v.object({
  kind: v.literal("forwarded"),
  paths: v.array(v.string()),
});

/**
 * One blended answer: a page of results, and one row per context it asked.
 *
 * Every count in here is taken **after** the caller's own `canSee` — in
 * `searchNotes`, which is where the single-context answer takes it too. A
 * blended total assembled from candidate counts would be the subtraction attack
 * `search/CONTRACT.md` names, run once per context and then summed, which is
 * strictly worse than running it once: the differences would tell a member
 * which of several contexts holds the notes they cannot read.
 */
export const blendedResultsValidator = v.object({
  results: v.array(
    v.object({
      workspaceId: v.id("workspaces"),
      slug: v.string(),
      displayName: v.string(),
      path: v.string(),
      title: v.string(),
      /** The explanatory line, or `""` where the index had none to give. */
      snippet: v.string(),
    }),
  ),
  /** Visible matches across every context asked. A floor when any source's is. */
  matchCount: v.number(),
  matchCountIsFloor: v.boolean(),
  /** Opaque, and `null` when there is no next page. Never carries the query. */
  cursor: v.union(v.string(), v.null()),
  /**
   * One row per context searched — the scope, as the server resolved it.
   *
   * This is what makes a partial failure useful rather than invisible: a source
   * that timed out is a row saying so beside the results from the sources that
   * answered, and retrying it is the same call with that one id in `contexts`.
   */
  sources: v.array(
    v.object({
      workspaceId: v.id("workspaces"),
      slug: v.string(),
      displayName: v.string(),
      state: v.union(v.literal("ok"), v.literal("indexing"), v.literal("failed")),
      matchCount: v.number(),
      matchCountIsFloor: v.boolean(),
    }),
  ),
  /**
   * How many contexts this viewer could search at all, whatever they selected.
   *
   * Zero is its own state on screen — "you are not in a context yet" is a
   * different sentence from "nothing matched", and collapsing them would tell
   * somebody their notes are not there when nothing looked.
   */
  searchableCount: v.number(),
});

/**
 * What one maintenance pass got through. Counts about the index's own
 * progress, and deliberately nothing about the notes it read: an indexing pass
 * is scope-blind, so a field naming a path or a term here would be an
 * existence oracle for the private half of somebody's bucket.
 *
 * `shed` and `oversizedShards` are `pending`'s own opposite in the same
 * shape: a whole-bucket scalar, never a path (`docs/decisions/search.md`,
 * sizing section — `syncShardedIndex`'s `shed`/`oversizedShards`, which no
 * caller of this reply read before). Where they DO name a path is
 * `searchResultsValidator.reducedRecallNotes`, which is safe because it is
 * already filtered through one caller's own `canSee` — this reply, like every
 * other field above, is not.
 */
export const indexMaintainedValidator = v.object({
  kind: v.literal("indexMaintained"),
  pending: v.number(),
  changed: v.boolean(),
  complete: v.boolean(),
  shed: v.number(),
  oversizedShards: v.number(),
});

/**
 * What one projection pass reports back, and nothing else.
 *
 * Counts, a state and a failure code. **No path, no title and no term** — the
 * pass reads every note in the bucket including private ones, and a return
 * that could name which ones it touched would be an existence oracle for the
 * private half of somebody's context, which is the same rule
 * `indexMaintained` follows one field at a time.
 *
 * `failure` is a `D1Error` code from a closed set, never a provider sentence.
 */
export const indexProjectedValidator = v.object({
  kind: v.literal("indexProjected"),
  projected: v.number(),
  deleted: v.number(),
  notesIndexed: v.number(),
  notesPending: v.number(),
  ready: v.boolean(),
  moved: v.boolean(),
  report: v.boolean(),
  failure: v.optional(v.string()),
});
