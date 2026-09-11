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
 *  - **There is nothing to search.** This person is in no context at all —
 *    a brand-new account between signing in and finishing onboarding. It used
 *    to be a much wider case and a much worse one: "no context you can reach
 *    has fast search switched on, so nothing was searched", shown to somebody
 *    with four contexts and a question. See below.
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
 *
 * ## Fast search is a speed, and it stopped being a gate
 *
 * Every context somebody belongs to is searched. The ones with a hosted index
 * answer from a database; the rest answer from the R2 shard index in their own
 * bucket, which is slower and is the product as it already is —
 * `lib/fastSearch.ts` in the control plane has said so from the beginning:
 * "the fast path is an upgrade, and its absence is the product as it already
 * is, rather than a broken search waiting for a toggle."
 *
 * This page did not believe it, and what it drew instead is the reason this
 * paragraph is here: an account with no Premium context got a page with a
 * search field, four lines of apology, and no way to search anything. The
 * upsell below is what that apology is *for* — an offer beside a working
 * search, never instead of one.
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
  /** How many contexts this viewer could search at all, whatever they selected. */
  searchableCount: number;
}

/**
 * A context this page searches, and how it will be answered.
 *
 * Mirrors the control plane's own `SearchableContext` field for field —
 * `search`, `fastSearch` and `owner` included — because a client that
 * re-derived any of them would be a second place for this page to disagree
 * with the settings card it points at.
 */
export interface SearchableContext {
  workspaceId: string;
  slug: string;
  displayName: string;
  /** `"fast"` from a hosted index, `"slow"` from the context's own bucket. */
  search: "fast" | "slow";
  /** Why it is not fast, in the settings card's own words. `"on"` when it is. */
  fastSearch: "off" | "preparing" | "on" | "failed" | "unavailable";
  /** Whether this viewer may change that. */
  owner: boolean;
}

/** The contexts answering the slow way — what the upsell is built from. */
export function slowContexts(
  contexts: readonly SearchableContext[],
): SearchableContext[] {
  return contexts.filter((context) => context.search === "slow");
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
  /** This viewer is in no context at all, so there was nothing to ask. */
  | "no-contexts"
  /** In flight, with nothing to show underneath. */
  | "searching"
  /** The request itself did not arrive. Different from a source failing. */
  | "failed"
  /** Answered, nothing matched, and every context in reach was searched. */
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
    // A searchable count of zero outranks "type something", because there is
    // nothing to type into. It is only known once an answer has arrived, which
    // is why this is not the first line of the function.
    return input.answer !== null && input.answer.searchableCount === 0 ? "no-contexts" : "idle";
  }
  if (input.answer === null) return input.loading ? "searching" : "idle";
  if (input.answer.searchableCount === 0) return "no-contexts";
  if (input.answer.results.length === 0) {
    if (input.loading) return "searching";
    return input.selected > 0 && input.selected < input.answer.searchableCount
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
      // Now a genuinely empty account rather than an unpaid one. The sentence
      // it replaced — "no context you can reach has fast search switched on,
      // so nothing was searched" — was the whole defect: true, unactionable,
      // and shown to people whose notes were sitting in a bucket this page
      // could have read the slow way.
      return "You are not in a context yet, so there is nothing to search.";
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
 * The empty selection means **every context in reach**, not none, and that is
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
 * Always visible and always specific: "All your contexts" or the names
 * themselves up to three, then a count. A control that said "3 selected" would
 * make somebody open it to find out which three, every time.
 *
 * It read "All fast-search contexts" while the page searched only those, and
 * the phrase is retired with the restriction: a label naming the index a search
 * happens to use, on a page that searches everything either way, describes our
 * plumbing rather than the person's scope.
 */
export function scopeLabel(
  selected: readonly string[],
  reachable: readonly SearchableContext[],
): string {
  const live = selected.filter((slug) => reachable.some((context) => context.slug === slug));
  if (live.length === 0 || live.length === reachable.length) return "All your contexts";
  if (live.length <= 3) return live.map((slug) => `@${slug}`).join(", ");
  return `${live.length} of ${reachable.length} contexts`;
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
  reachable: readonly SearchableContext[],
): string[] {
  return reachable
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

/* -------------------------------------------------------------------------- */
/*                        the upsell, beside a working search                 */
/* -------------------------------------------------------------------------- */

/**
 * A row of the upsell: one context that answered the slow way, what to say
 * about it, and — only where there is something to press — where that press
 * goes.
 *
 * **This is an offer beside a working search, never a reason there is none.**
 * The rows it replaced were an apology for a page that had searched nothing;
 * these sit under results the same page has already produced, and the
 * difference is the whole point of the change they belong to.
 *
 * `href` is deliberately absent rather than disabled for a context nobody can
 * act on right now: the fix is an offer, never a control offered to somebody
 * it would refuse.
 */
export interface UpsellRow {
  workspaceId: string;
  slug: string;
  message: string;
  /** What the press says it will do — absent wherever `href` is null. */
  action: string | null;
  /** A settings pane that already exists — never a switch drawn here. */
  href: string | null;
}

/**
 * Where an upsell row's press goes, by what is actually in the way.
 *
 * Two destinations, because `lib/fastSearch.ts` keeps two conditions apart and
 * this is the surface where that separation earns itself: "you are not paying
 * for this" and "you have not asked for this" are different sentences with
 * different next steps, and one of them must never be answered by the other's
 * screen. An owner who has not paid is sent to Premium; an owner who has is
 * sent to the switch.
 */
export type UpsellTarget = "premium" | "search";

export function upsellTarget(context: SearchableContext): UpsellTarget | null {
  if (!context.owner) return null;
  switch (context.fastSearch) {
    case "unavailable":
      return "premium";
    case "off":
    case "failed":
      return "search";
    // Nothing to press. A backfill in progress is not sped up by opening its
    // settings, and a context already serving is not in this list at all.
    case "preparing":
    case "on":
      return null;
  }
}

/**
 * The sentence for one context that answered from its own bucket, in the
 * second person where the viewer can act and the third where only an owner can.
 *
 * Every one of them says the search **worked**, because it did. The old
 * wording ("Fast search is off for @slug.") was written for a page where that
 * meant the context had not been searched; said over a list of results from
 * that same context it would read as a warning about answers a person is
 * looking at.
 *
 * `preparing` reuses the settings card's own word for "opted in and not yet
 * actually serving" (`describeFastSearch`'s "Preparing the index") rather than
 * inventing "backfilling" as a second name for the same thing — one context
 * cannot be "backfilling" here and "preparing" on its own settings screen.
 */
export function upsellMessage(context: SearchableContext): string {
  switch (context.fastSearch) {
    case "unavailable":
      return context.owner
        ? `@${context.slug} was searched from your own bucket, which is slower. Fast search is part of Premium.`
        : `@${context.slug} was searched from its own bucket, which is slower.`;
    case "off":
      return context.owner
        ? `@${context.slug} was searched from your own bucket, which is slower. Fast search makes it instant.`
        : `@${context.slug} was searched from its own bucket, which is slower. Its owner can turn fast search on.`;
    case "preparing":
      return `@${context.slug}'s fast index is still being built, so this search read its bucket.`;
    case "failed":
      return context.owner
        ? `@${context.slug}'s fast index could not be prepared, so this search read your bucket.`
        : `@${context.slug}'s fast index could not be prepared. Only its owner can try again.`;
    case "on":
      // Not reachable: a context serving from the hosted index is never in
      // this list. Named rather than defaulted so a sixth state cannot arrive
      // here silently.
      return `@${context.slug} is searched from the fast index.`;
  }
}

/** The press's own label, or `null` where there is nothing to press. */
export function upsellAction(context: SearchableContext): string | null {
  switch (upsellTarget(context)) {
    case "premium":
      return "See Premium";
    case "search":
      return "Turn it on";
    case null:
      return null;
  }
}

/**
 * The upsell's rows, built from the contexts that answered the slow way — the
 * server's own list, so a workspace the viewer is not a member of cannot
 * appear here any more than it can in the scope.
 *
 * `href` comes from the caller rather than being built here, because the two
 * destinations are settings sections this console already routes to and a
 * second copy of those URLs is a second thing to keep in step.
 *
 * **Every slow context gets a row, press or no press.** A row nobody can act
 * on is still worth saying — it is what explains why an answer took a moment,
 * and withholding it from the people who cannot change it would leave exactly
 * them with an unexplained slow page. `noteworthySources` already draws its
 * `indexing` row on the same rule, and for the same reason: what a person can
 * do about a fact is not what decides whether they are told it.
 */
export function upsellRows(
  contexts: readonly SearchableContext[],
  href: (slug: string, target: UpsellTarget) => string,
): UpsellRow[] {
  return slowContexts(contexts).map((context) => {
    const target = upsellTarget(context);
    return {
      workspaceId: context.workspaceId,
      slug: context.slug,
      message: upsellMessage(context),
      action: upsellAction(context),
      href: target === null ? null : href(context.slug, target),
    };
  });
}
