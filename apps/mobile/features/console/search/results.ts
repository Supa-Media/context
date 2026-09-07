/**
 * The search page's model: what the server said, turned into what is on screen.
 *
 * Pure, and free of React, for the reason every model in this console is: the
 * jest suite runs in plain node, and the interesting rules here are the ones
 * that decide **which sentence a person reads when there is nothing in the
 * list** — which is exactly the kind of rule that looks fine while you are
 * clicking around with results on screen.
 *
 * ## Four ways to have no results, and they are four different sentences
 *
 * The palette already learned this once (`useContextSearch`: "an empty answer
 * from an index that is still catching up is not an answer about somebody's
 * notes"). A page that spans several contexts has more ways to be empty and
 * each of them is a different thing to do next:
 *
 *  - **Nothing is searchable.** No context this person can reach has fast
 *    search on, so nothing looked. Saying "no matches" here would tell them
 *    their notes are not there, which is the one claim this feature exists to
 *    stop making wrongly. The way out is a setting, and the copy points at it.
 *  - **The scope was narrowed to nothing that matched.** They have contexts;
 *    they searched two of five. Widening is one press away and the copy says so.
 *  - **Everything was searched and nothing matched.** The only case where "no
 *    matches" is the true sentence.
 *  - **Some of it could not be reached.** Results from four contexts and a
 *    timeout on the fifth is not "no matches" and it is not a failure either;
 *    it is a partial answer with a retry beside the row that failed.
 *
 * They are one enum rather than a chain of ternaries in a component, so each
 * one is a named case with a test, and adding a fifth cannot silently fall into
 * the "no matches" arm.
 */

/** One blended result, as the control plane sends it. */
export interface BlendedResult {
  workspaceId: string;
  slug: string;
  displayName: string;
  path: string;
  title: string;
  snippet: string;
}

/** One context that was searched, and how it went. */
export interface BlendedSource {
  workspaceId: string;
  slug: string;
  displayName: string;
  state: "ok" | "indexing" | "failed";
  matchCount: number;
  matchCountIsFloor: boolean;
}

/** One page of the blended answer. */
export interface BlendedAnswer {
  results: BlendedResult[];
  matchCount: number;
  matchCountIsFloor: boolean;
  cursor: string | null;
  sources: BlendedSource[];
  eligibleCount: number;
}

/** A context the viewer may search, for the scope picker. */
export interface SearchableContext {
  workspaceId: string;
  slug: string;
  displayName: string;
}

/**
 * Below this a query is a prefix of a word rather than a word.
 *
 * The same number the palette uses, and shared for a reason beyond tidiness:
 * the palette hands its query to this page on "See all results", and a page
 * that considered the handed-over query too short would open on an empty state
 * for a search the person had just watched return rows.
 */
export const MIN_QUERY = 3;

export type PageState =
  /** Nothing typed yet, or not enough of it. */
  | "idle"
  /** No context this viewer can reach has fast search on. Nothing looked. */
  | "no-contexts"
  /** In flight, with nothing to show underneath. */
  | "searching"
  /** The request itself did not arrive. Different from a source failing. */
  | "failed"
  /** Answered, nothing matched, and everything eligible was searched. */
  | "empty"
  /** Answered, nothing matched, and the scope was narrower than everything. */
  | "filtered"
  /** Results, and at least one context could not be reached. */
  | "partial"
  /** Results, and every context answered. */
  | "ready";

export function pageState(input: {
  query: string;
  loading: boolean;
  failed: boolean;
  answer: BlendedAnswer | null;
  /** How many contexts the scope picker has selected; 0 means "all of them". */
  selected: number;
}): PageState {
  if (input.failed) return "failed";
  if (input.query.trim().length < MIN_QUERY) {
    // An eligible count of zero outranks "type something", because there is
    // nothing to type into. It is only known once an answer has arrived, which
    // is why this is not the first line of the function.
    return input.answer !== null && input.answer.eligibleCount === 0 ? "no-contexts" : "idle";
  }
  if (input.answer === null) return input.loading ? "searching" : "idle";
  if (input.answer.eligibleCount === 0) return "no-contexts";
  if (input.answer.results.length === 0) {
    if (input.loading) return "searching";
    return input.selected > 0 && input.selected < input.answer.eligibleCount
      ? "filtered"
      : "empty";
  }
  return input.answer.sources.some((source) => source.state === "failed")
    ? "partial"
    : "ready";
}

/**
 * The sentence under an empty list.
 *
 * Held here rather than inline in the pane so the four cases can be read
 * against each other. Each one names what to do next, because a dead end that
 * explains itself is still a dead end.
 */
export function emptyMessage(state: PageState, query: string): string {
  switch (state) {
    case "no-contexts":
      return (
        "No context you can reach has fast search switched on, so nothing was " +
        "searched. An owner can turn it on in a context's settings."
      );
    case "filtered":
      return `Nothing in the contexts you selected matches “${query.trim()}”. Widen the scope to search the rest.`;
    case "empty":
      return `Nothing matches “${query.trim()}”. Try fewer words, or a word you would have written down.`;
    case "failed":
      return "That search could not be run. Check your connection and try again.";
    case "searching":
      return "Searching…";
    case "idle":
      return `Type at least ${MIN_QUERY} letters to search every context you can reach.`;
    default:
      return "";
  }
}

/* -------------------------------------------------------------------------- */
/*                                   scope                                    */
/* -------------------------------------------------------------------------- */

/**
 * Turning a chip on or off.
 *
 * The empty selection means **all eligible contexts**, not none, and that is
 * the one thing about the scope worth stating: a picker whose empty state meant
 * "search nothing" would make "clear the filters" the button that empties the
 * page. Turning the last chip off therefore returns to everything, which is
 * also what the server does with an empty `contexts` list — one meaning, in
 * both halves.
 */
export function toggleScope(selected: readonly string[], slug: string): string[] {
  return selected.includes(slug)
    ? selected.filter((each) => each !== slug)
    : [...selected, slug];
}

/**
 * What the scope control says it is set to.
 *
 * Always visible and always specific: "All fast-search contexts" or the names
 * themselves up to three, then a count. A control that said "3 selected" would
 * make somebody open it to find out which three, every time.
 */
export function scopeLabel(
  selected: readonly string[],
  eligible: readonly SearchableContext[],
): string {
  const live = selected.filter((slug) => eligible.some((context) => context.slug === slug));
  if (live.length === 0 || live.length === eligible.length) return "All fast-search contexts";
  if (live.length <= 3) return live.map((slug) => `@${slug}`).join(", ");
  return `${live.length} of ${eligible.length} contexts`;
}

/**
 * The workspace ids to send, from the slugs in the URL.
 *
 * Slugs are the URL's currency and ids are the API's, and this is the one place
 * that converts — a slug the viewer cannot reach simply has no id, so it
 * disappears here rather than being sent for the server to drop. Both ends
 * agree on the result and only the server's end is a security boundary.
 */
export function scopeIds(
  selected: readonly string[],
  eligible: readonly SearchableContext[],
): string[] {
  return eligible
    .filter((context) => selected.includes(context.slug))
    .map((context) => context.workspaceId);
}

/* -------------------------------------------------------------------------- */
/*                              counts and rows                               */
/* -------------------------------------------------------------------------- */

/**
 * "12 results" — or "12+", when the number is a floor.
 *
 * The floor is not decoration. Every count that leaves the gateway is computed
 * over the notes the caller may *see*, and it is reported as a floor whenever a
 * walk was cut short or a ranked list filled up. Printing a floor as an exact
 * total is the one direction that misleads: it tells somebody they have seen
 * everything there is.
 */
export function countLabel(matchCount: number, isFloor: boolean): string {
  const count = Math.max(0, Math.floor(matchCount));
  const noun = count === 1 ? "result" : "results";
  return `${count}${isFloor ? "+" : ""} ${noun}`;
}

/** The folder a result lives in, for the second line of a row. */
export function folderOf(path: string): string {
  const cut = path.lastIndexOf("/");
  return cut <= 0 ? "" : path.slice(0, cut);
}

/**
 * The contexts worth naming under the results, and what to say about each.
 *
 * Only the ones a person can act on or would be misled by. A source that
 * answered normally is already visible — its results are on the page — so
 * listing it as well is a row that says "this worked", which is noise around
 * the two rows that are not noise.
 */
export function noteworthySources(answer: BlendedAnswer | null): {
  source: BlendedSource;
  message: string;
  retryable: boolean;
}[] {
  if (answer === null) return [];
  const rows: { source: BlendedSource; message: string; retryable: boolean }[] = [];
  for (const source of answer.sources) {
    if (source.state === "failed") {
      rows.push({
        source,
        message: `@${source.slug} could not be searched.`,
        retryable: true,
      });
    } else if (source.state === "indexing") {
      rows.push({
        source,
        // Never "nothing in @slug matches": an index that has not caught up
        // has not answered the question, and a blended page is where that lie
        // is easiest to tell, because the other contexts answering makes the
        // silence look like a result.
        message: `@${source.slug} is still being indexed, so results from it may be short.`,
        retryable: false,
      });
    }
  }
  return rows;
}
