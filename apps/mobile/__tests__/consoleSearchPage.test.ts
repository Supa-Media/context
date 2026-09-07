import { describe, expect, test } from "@jest/globals";
import {
  MIN_QUERY,
  countLabel,
  emptyMessage,
  folderOf,
  noteworthySources,
  nudgeMessage,
  nudgeRows,
  ownsAnUnsearchableContext,
  pageState,
  scopeIds,
  scopeLabel,
  toggleScope,
  type BlendedAnswer,
  type UnsearchableContext,
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
 *   `pageState` losing the eligible-count-of-zero arm entirely            2
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

const eligible = [
  { workspaceId: "w1", slug: "seyi", displayName: "Seyi" },
  { workspaceId: "w2", slug: "lk", displayName: "LK" },
  { workspaceId: "w3", slug: "public-worship", displayName: "Public Worship" },
];

function answer(over: Partial<BlendedAnswer> = {}): BlendedAnswer {
  return {
    results: [],
    matchCount: 0,
    matchCountIsFloor: false,
    cursor: null,
    sources: [],
    eligibleCount: 3,
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
  test("nothing searchable is not the same claim as nothing matched", () => {
    const state = pageState({
      query: "review cycle",
      loading: false,
      failed: false,
      answer: answer({ eligibleCount: 0 }),
      selected: 0,
    });
    expect(state).toBe("no-contexts");
    // The sentence must not contain the claim. A person with fast search off
    // everywhere has had nothing looked at, and "nothing matches" would be a
    // statement about their notes that nothing in the system checked.
    expect(emptyMessage(state, "review cycle")).not.toContain("Nothing matches");
    expect(emptyMessage(state, "review cycle")).toContain("fast search");
  });

  test("…and it outranks 'type something', because there is nothing to type into", () => {
    expect(
      pageState({
        query: "",
        loading: false,
        failed: false,
        answer: answer({ eligibleCount: 0 }),
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
    expect(scopeLabel([], eligible)).toBe("All fast-search contexts");
    // Which is also what an empty list means to the server, so the two halves
    // cannot disagree about what "clear the filters" does.
    expect(scopeIds([], eligible)).toEqual([]);
  });

  test("the label names the contexts rather than counting them, up to three", () => {
    expect(scopeLabel(["seyi"], eligible)).toBe("@seyi");
    expect(scopeLabel(["seyi", "lk"], eligible)).toBe("@seyi, @lk");
    expect(scopeLabel(eligible.map((c) => c.slug), eligible)).toBe(
      "All fast-search contexts",
    );
  });

  test("a slug this viewer cannot reach never becomes an id", () => {
    // A pasted link can name anything. The server drops what the caller cannot
    // search; this drops it a round trip earlier, and the two agree by
    // construction because both intersect rather than trust.
    expect(scopeIds(["seyi", "somebody-elses-brain"], eligible)).toEqual(["w1"]);
    expect(scopeLabel(["somebody-elses-brain"], eligible)).toBe("All fast-search contexts");
  });
});

describe("the nudge toward fast search", () => {
  /** One not-eligible context, with the fields a test cares about set. */
  function context(over: Partial<UnsearchableContext> = {}): UnsearchableContext {
    return {
      workspaceId: "w9",
      slug: "quiet-context",
      displayName: "Quiet Context",
      owner: false,
      state: "off",
      ...over,
    };
  }

  test("an owner reads what to press; a member reads who to ask", () => {
    const owned = nudgeMessage(context({ owner: true, state: "off" }));
    const shared = nudgeMessage(context({ owner: false, state: "off" }));
    expect(owned).toContain("Fast search is off");
    expect(owned).not.toContain("owner");
    expect(shared).toContain("owner has not turned fast search on");
  });

  test("still indexing is never read as nothing there, for owner or member alike", () => {
    // The rule `noteworthySources` already states for a source mid-search
    // applies before a search is even asked: an index that has not caught up
    // has not answered anything, and must never read as an answer.
    const message = nudgeMessage(context({ owner: true, state: "preparing" }));
    expect(message).toContain("still being indexed");
    expect(message).not.toContain("Nothing");
  });

  test("a failed provision tells an owner to retry and a member who to wait on", () => {
    const owned = nudgeMessage(context({ owner: true, state: "failed" }));
    const shared = nudgeMessage(context({ owner: false, state: "failed" }));
    expect(owned).toContain("could not be prepared");
    expect(shared).toContain("Only its owner can try again");
  });

  test("unavailable names no setting, because there is no entitlement to reach", () => {
    expect(nudgeMessage(context({ owner: true, state: "unavailable" }))).toContain(
      "not available",
    );
  });

  test("only an owner staring at off or failed gets a press — never a member, never mid-backfill", () => {
    const settingsHref = (slug: string) => `/console/@${slug}/settings`;

    const rows = nudgeRows(
      [
        context({ workspaceId: "w1", slug: "mine-off", owner: true, state: "off" }),
        context({ workspaceId: "w2", slug: "mine-failed", owner: true, state: "failed" }),
        context({ workspaceId: "w3", slug: "mine-preparing", owner: true, state: "preparing" }),
        context({ workspaceId: "w4", slug: "theirs-off", owner: false, state: "off" }),
        context({ workspaceId: "w5", slug: "mine-unavailable", owner: true, state: "unavailable" }),
      ],
      settingsHref,
    );

    const hrefFor = (slug: string) => rows.find((row) => row.slug === slug)?.href;
    expect(hrefFor("mine-off")).toBe("/console/@mine-off/settings");
    expect(hrefFor("mine-failed")).toBe("/console/@mine-failed/settings");
    expect(hrefFor("mine-preparing")).toBeNull();
    expect(hrefFor("theirs-off")).toBeNull();
    expect(hrefFor("mine-unavailable")).toBeNull();
    // The href is never a switch of its own — it is the settings pane the
    // caller was handed, called with nothing but the slug.
    expect(rows.map((row) => row.workspaceId)).toEqual(["w1", "w2", "w3", "w4", "w5"]);
  });

  test("an owned context anywhere in the list is what opens the nudge in the picker", () => {
    expect(ownsAnUnsearchableContext([context({ owner: false })])).toBe(false);
    expect(
      ownsAnUnsearchableContext([context({ owner: false }), context({ owner: true })]),
    ).toBe(true);
    expect(ownsAnUnsearchableContext([])).toBe(false);
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
