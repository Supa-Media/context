import type { PaletteItem } from "../../console/files/palette";

/**
 * Answers from asking the whole context, for a palette whose own `items` are
 * only what the browser has already loaded.
 *
 * Kept beside the local matches rather than merged into them, because the two
 * are ranked by different things and neither ranking survives the other: local
 * matches are fuzzy over a note's *name* and are instant, and these are ranked
 * by what is written *inside* the notes and arrive a moment later. Re-ranking
 * a content hit by how well its filename fuzzes against the query is how "the
 * note that actually says this" ends up below "the note whose title has the
 * right letters in it".
 */
export interface PaletteSearch {
  /**
   * Called as the query changes. Debouncing belongs to the caller, which is
   * the side that knows what a round trip costs.
   */
  onQuery: (query: string) => void;
  /** Hits, already ranked by the search itself. */
  items: PaletteItem[];
  /**
   * `indexing` is not `empty`: a context whose index is still being built has
   * nothing to say yet, and saying "no matches" for it is telling somebody
   * their note does not exist.
   */
  state: "idle" | "searching" | "ready" | "indexing" | "failed";
  /** Rendered above the search results, e.g. "In your notes". */
  heading?: string;
  /**
   * The caller's own visible notes that hold more messages than the search
   * index can keep in full, or absent/`[]` for none.
   *
   * Drawn as a fixed banner rather than folded into `state`: unlike
   * `indexing`, this does not resolve by searching again, so it stays true
   * beside a screen full of real hits exactly as it does beside none. See
   * `reducedRecallMessage` in `features/console/files/useContextSearch.ts`,
   * which is also where the rendered wording lives — the same sentence an
   * AI client reads off this field, never a fourth version of it.
   */
  reducedRecallNotes?: readonly string[];
  /**
   * A sentence about where the answer came from, drawn in the same fixed
   * place as the shed-note caveat — e.g. "Searched the copy on this device.
   * Only 340 of 1,204 notes are on this device yet." (`deviceSearchNotice` in
   * `features/offline/mirrorCopy.ts`). Fixed above the list for the same
   * reason: it qualifies every row, so it must be on screen with the first.
   */
  notice?: string | null;
  /**
   * What an answered search with no rows says, when the caller's own
   * `noMatchMessage` would be wrong for it — a search of the device's copy
   * that found nothing must not tell somebody to "keep typing to search the
   * rest of this context".
   */
  emptyMessage?: string;
  /**
   * The search's answer is the ranking: once it has answered, its rows are
   * drawn in its own order with the loaded name matches folded in
   * (`mergeRanked`), rather than under them. ⌘K's search of every workspace.
   */
  ranked?: boolean;
  /** What the strip says while the search runs, where "the rest of this workspace" is wrong. */
  searchingText?: string;
}
