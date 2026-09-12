import { describe, expect, test } from "@jest/globals";
import {
  MIN_QUERY,
  countLabel,
  emptyMessage,
  folderOf,
  noteworthySources,
  pageState,
  scopeIds,
  scopeLabel,
  slowContexts,
  toggleScope,
  upsellMessage,
  upsellRows,
  upsellTarget,
  type BlendedAnswer,
  type SearchableContext,
} from "../features/console/search/results";
import {
  SEARCH_PATH,
  routeForPath,
  searchFromQuery,
  searchHref,
} from "../features/console/nav";

/**
 * THE SEARCH PAGE'S MODEL.
 *
 * The page draws a list, and the list is the easy part. What this file is about
 * is the four ways the list can be empty, because they are four different
 * sentences and only one of them is "nothing matches" — a page that collapses
 * them tells somebody their notes are not there when nothing looked, which is
 * the failure the whole search feature exists to remove and the one that is
 * invisible while you are testing with results on screen.
 *
 * The second half is the URL. A search page whose query is not in the URL
 * cannot be reloaded, linked or gone back to, and those are three of the four
 * things people do with one. The rules are cheap to get subtly wrong — a scope
 * that survives a reload but not a paste, a `q` that comes back
 * double-encoded — and impossible to notice by clicking.
 *
 * ## Sabotage record
 *
 * Run as temporary local edits and reverted, counts as measured.
 *
 *   `pageState` losing the searchable-count-of-zero arm entirely          2
 *   `toggleScope` making an emptied selection mean "search nothing"       1
 *   `countLabel` dropping the floor marker                                1
 *   `scopeIds` mapping the slugs it was given rather than intersecting    1
 *   `noteworthySources` listing every source rather than the two that
 *     need saying                                                         1
 *
 * The first is the one to read: removing BOTH halves of the "nothing is
 * searchable" rule — the early one that outranks "type something" and the one
 * after the answer arrives — reddens two checks, and each covers one half. A
 * mutation that dropped only the early half would redden only the second, which
 * is why they are separate tests rather than one.
 */

/** One context in reach, with the fields a test cares about set. */
function context(over: Partial<SearchableContext> = {}): SearchableContext {
  return {
    workspaceId: "w9",
    slug: "quiet-context",
    displayName: "Quiet Context",
    search: "slow",
    fastSearch: "off",
    owner: false,
    ...over,
  };
}

const reachable = [
  context({ workspaceId: "w1", slug: "seyi", displayName: "Seyi", search: "fast", fastSearch: "on" }),
  context({ workspaceId: "w2", slug: "lk", displayName: "LK", search: "fast", fastSearch: "on" }),
  context({
    workspaceId: "w3",
    slug: "public-worship",
    displayName: "Public Worship",
    search: "fast",
    fastSearch: "on",
  }),
];

function answer(over: Partial<BlendedAnswer> = {}): BlendedAnswer {
  return {
    results: [],
    matchCount: 0,
    matchCountIsFloor: false,
    cursor: null,
    sources: [],
    searchableCount: 3,
    ...over,
  };
}

const hit = {
  workspaceId: "w1",
  slug: "seyi",
  displayName: "Seyi",
  path: "1-projects/review.md",
  title: "Review cycle",
  snippet: "the review cycle runs quarterly",
};

describe("what the page says when the list is empty", () => {
  test("nothing to search is not the same claim as nothing matched", () => {
    const state = pageState({
      query: "review cycle",
      loading: false,
      failed: false,
      answer: answer({ searchableCount: 0 }),
      selected: 0,
    });
    expect(state).toBe("no-contexts");
    // The sentence must not contain the claim: nothing was looked at, and
    // "nothing matches" would be a statement about somebody's notes that
    // nothing in the system checked.
    expect(emptyMessage(state, "review cycle")).not.toContain("Nothing matches");
    expect(emptyMessage(state, "review cycle")).toContain("not in a context yet");
    // And it is no longer the sentence an unpaid account reads. Fast search
    // being off somewhere is not a reason for this state to exist — that page
    // searches buckets instead and says so under the results.
    expect(emptyMessage(state, "review cycle")).not.toContain("fast search");
  });

  test("…and it outranks 'type something', because there is nothing to type into", () => {
    expect(
      pageState({
        query: "",
        loading: false,
        failed: false,
        answer: answer({ searchableCount: 0 }),
        selected: 0,
      }),
    ).toBe("no-contexts");
    // With contexts to search, an empty field is an invitation rather than an
    // apology.
    expect(
      pageState({ query: "", loading: false, failed: false, answer: answer(), selected: 0 }),
    ).toBe("idle");
    expect(emptyMessage("idle", "")).toContain(`${MIN_QUERY} letters`);
  });

  test("a narrowed scope that found nothing offers the way out", () => {
    const state = pageState({
      query: "review",
      loading: false,
      failed: false,
      answer: answer(),
      selected: 1,
    });
    expect(state).toBe("filtered");
    expect(emptyMessage(state, "review")).toContain("Widen the scope");
    // Everything selected is not a narrowing, so it is the honest "no matches".
    expect(
      pageState({
        query: "review",
        loading: false,
        failed: false,
        answer: answer(),
        selected: 3,
      }),
    ).toBe("empty");
  });

  test("a request that never arrived is not an answer about anybody's notes", () => {
    const state = pageState({
      query: "review",
      loading: false,
      failed: true,
      answer: answer({ results: [hit] }),
      selected: 0,
    });
    expect(state).toBe("failed");
    expect(emptyMessage(state, "review")).not.toContain("Nothing matches");
  });

  test("results with a source down are partial, not ready and not failed", () => {
    expect(
      pageState({
        query: "review",
        loading: false,
        failed: false,
        answer: answer({
          results: [hit],
          sources: [
            {
              workspaceId: "w1",
              slug: "seyi",
              displayName: "Seyi",
              state: "ok",
              matchCount: 1,
              matchCountIsFloor: false,
            },
            {
              workspaceId: "w2",
              slug: "lk",
              displayName: "LK",
              state: "failed",
              matchCount: 0,
              matchCountIsFloor: false,
            },
          ],
        }),
        selected: 0,
      }),
    ).toBe("partial");
  });
});

describe("the contexts worth naming under the results", () => {
  test("a context that answered says nothing; the other two say what to do", () => {
    const rows = noteworthySources(
      answer({
        sources: [
          {
            workspaceId: "w1",
            slug: "seyi",
            displayName: "Seyi",
            state: "ok",
            matchCount: 4,
            matchCountIsFloor: false,
          },
          {
            workspaceId: "w2",
            slug: "lk",
            displayName: "LK",
            state: "failed",
            matchCount: 0,
            matchCountIsFloor: false,
          },
          {
            workspaceId: "w3",
            slug: "public-worship",
            displayName: "Public Worship",
            state: "indexing",
            matchCount: 0,
            matchCountIsFloor: false,
          },
        ],
      }),
    );
    expect(rows.map((row) => row.source.slug)).toEqual(["lk", "public-worship"]);
    expect(rows[0]!.retryable).toBe(true);
    // An index that has not caught up has not answered, so its row must never
    // read as an answer about the notes in it.
    expect(rows[1]!.retryable).toBe(false);
    expect(rows[1]!.message).toContain("still being indexed");
    expect(rows[1]!.message).not.toContain("Nothing");
  });
});

describe("the scope", () => {
  test("turning the last chip off means everything, not nothing", () => {
    expect(toggleScope(["seyi"], "seyi")).toEqual([]);
    expect(scopeLabel([], reachable)).toBe("All your contexts");
    // Which is also what an empty list means to the server, so the two halves
    // cannot disagree about what "clear the filters" does.
    expect(scopeIds([], reachable)).toEqual([]);
  });

  test("the label names the contexts rather than counting them, up to three", () => {
    expect(scopeLabel(["seyi"], reachable)).toBe("@seyi");
    expect(scopeLabel(["seyi", "lk"], reachable)).toBe("@seyi, @lk");
    expect(scopeLabel(reachable.map((c) => c.slug), reachable)).toBe("All your contexts");
  });

  test("the label says whose contexts, not which index answers them", () => {
    // It read "All fast-search contexts" while the page searched only those.
    // The scope is every context somebody is in now, so a label naming the
    // index would describe our plumbing rather than what was searched.
    const mixed = [
      context({ workspaceId: "w1", slug: "seyi", search: "fast", fastSearch: "on" }),
      context({ workspaceId: "w2", slug: "lk", search: "slow", fastSearch: "off" }),
    ];
    expect(scopeLabel([], mixed)).toBe("All your contexts");
    expect(scopeIds([], mixed)).toEqual([]);
    expect(scopeIds(["seyi", "lk"], mixed)).toEqual(["w1", "w2"]);
  });

  test("a slug this viewer cannot reach never becomes an id", () => {
    // A pasted link can name anything. The server drops what the caller cannot
    // search; this drops it a round trip earlier, and the two agree by
    // construction because both intersect rather than trust.
    expect(scopeIds(["seyi", "somebody-elses-brain"], reachable)).toEqual(["w1"]);
    expect(scopeLabel(["somebody-elses-brain"], reachable)).toBe("All your contexts");
  });
});

describe("the upsell, beside a search that worked", () => {
  const href = (slug: string, target: "premium" | "search") =>
    `/console/@${slug}/settings?settings=${target}`;

  test("every sentence says the context WAS searched", () => {
    // The regression this whole change is about. The old wording — "Fast
    // search is off for @slug." — was written for a page that had searched
    // nothing, and said over results from that same context it reads as a
    // warning about answers somebody is looking at.
    for (const state of ["off", "preparing", "failed", "unavailable"] as const) {
      for (const owner of [true, false]) {
        const message = upsellMessage(context({ fastSearch: state, owner }));
        expect(message).toContain("@quiet-context");
        expect(message).not.toContain("nothing was searched");
        expect(message).not.toContain("Nothing");
      }
    }
  });

  test("an owner reads what to press; a member reads who to ask", () => {
    const owned = upsellMessage(context({ owner: true, fastSearch: "off" }));
    const shared = upsellMessage(context({ owner: false, fastSearch: "off" }));
    expect(owned).toContain("your own bucket");
    expect(owned).toContain("Fast search makes it instant");
    expect(shared).toContain("Its owner can turn fast search on");
  });

  test("not paying and not asking are different offers, with different destinations", () => {
    // `lib/fastSearch.ts` keeps entitlement and opt-in apart precisely so these
    // two can read differently. Sending "you have not paid" to a switch they
    // cannot throw wastes the one press they give us.
    expect(upsellTarget(context({ owner: true, fastSearch: "unavailable" }))).toBe("premium");
    expect(upsellTarget(context({ owner: true, fastSearch: "off" }))).toBe("search");
    expect(upsellTarget(context({ owner: true, fastSearch: "failed" }))).toBe("search");
    expect(upsellMessage(context({ owner: true, fastSearch: "unavailable" }))).toContain(
      "Premium",
    );
  });

  test("still indexing is never read as nothing there, for owner or member alike", () => {
    // The rule `noteworthySources` states for a source mid-search: an index
    // that has not caught up has not answered anything. Here it has — from the
    // bucket — and there is nothing to press either way.
    const message = upsellMessage(context({ owner: true, fastSearch: "preparing" }));
    expect(message).toContain("still being built");
    expect(upsellTarget(context({ owner: true, fastSearch: "preparing" }))).toBeNull();
  });

  test("a failed provision tells an owner to retry and a member who to wait on", () => {
    expect(upsellMessage(context({ owner: true, fastSearch: "failed" }))).toContain(
      "could not be prepared",
    );
    expect(upsellMessage(context({ owner: false, fastSearch: "failed" }))).toContain(
      "Only its owner can try again",
    );
  });

  test("only an owner staring at off, failed or unpaid gets a press — never a member, never mid-backfill", () => {
    const rows = upsellRows(
      [
        context({ workspaceId: "w1", slug: "mine-off", owner: true, fastSearch: "off" }),
        context({ workspaceId: "w2", slug: "mine-failed", owner: true, fastSearch: "failed" }),
        context({ workspaceId: "w3", slug: "mine-preparing", owner: true, fastSearch: "preparing" }),
        context({ workspaceId: "w4", slug: "theirs-off", owner: false, fastSearch: "off" }),
        context({ workspaceId: "w5", slug: "mine-unpaid", owner: true, fastSearch: "unavailable" }),
      ],
      href,
    );

    const hrefFor = (slug: string) => rows.find((row) => row.slug === slug)?.href;
    expect(hrefFor("mine-off")).toBe("/console/@mine-off/settings?settings=search");
    expect(hrefFor("mine-failed")).toBe("/console/@mine-failed/settings?settings=search");
    expect(hrefFor("mine-unpaid")).toBe("/console/@mine-unpaid/settings?settings=premium");
    expect(hrefFor("mine-preparing")).toBeNull();
    expect(hrefFor("theirs-off")).toBeNull();
    // A row with no press still says its sentence — "this one was slow, and it
    // is not your switch" is the honest caption on somebody else's context.
    expect(rows.find((row) => row.slug === "theirs-off")?.message).toContain("slower");
    expect(rows.map((row) => row.workspaceId)).toEqual(["w1", "w2", "w3", "w4", "w5"]);
  });

  test("a context already on the fast index is not in the upsell at all", () => {
    const mixed = [
      context({ workspaceId: "w1", slug: "fast-one", search: "fast", fastSearch: "on" }),
      context({ workspaceId: "w2", slug: "slow-one", owner: true, fastSearch: "off" }),
    ];
    expect(slowContexts(mixed).map((row) => row.slug)).toEqual(["slow-one"]);
    expect(upsellRows(mixed, href).map((row) => row.slug)).toEqual(["slow-one"]);
  });

  test("a slow context gets its row whether or not the reader can act on it", () => {
    // What a person can do about a fact is not what decides whether they are
    // told it: a member reading a slow answer with no switch to throw is
    // exactly the reader most owed the sentence explaining the wait.
    const theirs = upsellRows([context({ owner: false, fastSearch: "off" })], href);
    expect(theirs).toHaveLength(1);
    expect(theirs[0]!.href).toBeNull();
    expect(theirs[0]!.action).toBeNull();
    expect(theirs[0]!.message).toContain("slower");
  });
});

describe("counts and rows", () => {
  test("a floor is drawn as one, because an exact total claims you have seen everything", () => {
    expect(countLabel(12, false)).toBe("12 results");
    expect(countLabel(12, true)).toBe("12+ results");
    expect(countLabel(1, false)).toBe("1 result");
    expect(countLabel(0, false)).toBe("0 results");
  });

  test("the folder is the second line, and a root note has none", () => {
    expect(folderOf("1-projects/review.md")).toBe("1-projects");
    expect(folderOf("index.md")).toBe("");
  });
});

describe("the search is in the URL", () => {
  test("a query and a scope survive a round trip", () => {
    const href = searchHref("review cycle", ["seyi", "lk"]);
    expect(href).toBe("/console/search?q=review%20cycle&in=seyi,lk");
    expect(searchFromQuery({ q: "review cycle", in: "seyi,lk" })).toEqual({
      query: "review cycle",
      slugs: ["seyi", "lk"],
    });
  });

  test("the scope is slugs, never workspace ids", () => {
    // A URL somebody may paste into a chat should carry the console's own
    // public addressing and not a database identifier — and a slug the reader
    // cannot reach simply resolves to nothing on their side.
    expect(searchHref("x", ["seyi"])).toContain("in=seyi");
    expect(searchHref("x", ["seyi"])).not.toContain("w1");
  });

  test("an `@` somebody typed by hand is the same context", () => {
    expect(searchFromQuery({ in: "@seyi, lk" }).slugs).toEqual(["seyi", "lk"]);
  });

  test("no scope and no query is the bare page", () => {
    expect(searchHref("", [])).toBe(SEARCH_PATH);
    expect(searchHref("   ")).toBe(SEARCH_PATH);
    expect(searchFromQuery({})).toEqual({ query: "", slugs: [] });
  });

  test("the page is an app-level route, whatever is in its query string", () => {
    // `routeForPath` matches the section by href, so a search with a query on
    // it must still highlight Search in the navigation rather than falling
    // back to the landing.
    expect(routeForPath("/console/search")).toEqual({ kind: "app", section: "search" });
    expect(routeForPath("/console/search?q=review%20cycle&in=seyi")).toEqual({
      kind: "app",
      section: "search",
    });
  });
});
