/**
 * ⌘K over every workspace: the pure half, pinned.
 *
 * `features/console/layout/everywhereSearch.ts` turns the search page's answer
 * into palette rows, says why each row matched, decides the palette's state,
 * and does the arithmetic behind the timing pill. Each rule below is asserted
 * against a hand-built answer, so nothing here depends on a live workspace.
 *
 * Fixtures are obviously-fake notes and slugs; this repository is public.
 */

import { describe, expect, test } from "@jest/globals";
import {
  itemsFromBlended,
  loadedInScope,
  paletteStateOf,
  parseScopedQuery,
  seconds,
  SLOW_MS,
  sourcesNotice,
  timingBreakdown,
  whyMatched,
} from "../features/console/layout/everywhereSearch";
import type {
  BlendedAnswer,
  BlendedResult,
  BlendedSource,
} from "../features/console/search/results";

/* -------------------------------------------------------------------------- */
/*                                  helpers                                   */
/* -------------------------------------------------------------------------- */

function result(overrides: Partial<BlendedResult> & Pick<BlendedResult, "slug" | "path" | "title">): BlendedResult {
  return {
    workspaceId: `ws_${overrides.slug}`,
    displayName: overrides.slug,
    snippet: "",
    ...overrides,
  };
}

function source(overrides: Partial<BlendedSource> & Pick<BlendedSource, "slug">): BlendedSource {
  return {
    workspaceId: `ws_${overrides.slug}`,
    displayName: overrides.slug,
    state: "ok",
    matchCount: 0,
    matchCountIsFloor: false,
    ...overrides,
  };
}

function answer(overrides: Partial<BlendedAnswer> = {}): BlendedAnswer {
  return {
    results: [],
    matchCount: 0,
    matchCountIsFloor: false,
    cursor: null,
    sources: [],
    searchableCount: 0,
    ...overrides,
  };
}

/* -------------------------------------------------------------------------- */
/*                              parseScopedQuery                              */
/* -------------------------------------------------------------------------- */

describe("parseScopedQuery", () => {
  const slugs = ["supa", "seyi"];

  test("'@supa pricing' narrows to @supa and searches for 'pricing'", () => {
    expect(parseScopedQuery("@supa pricing", slugs)).toEqual({ slug: "supa", query: "pricing" });
  });

  test("the slug is matched without regard to case, and the slug returned is the workspace's own", () => {
    expect(parseScopedQuery("@SUPA x", slugs)).toEqual({ slug: "supa", query: "x" });
  });

  test("'@su' with no space after it names nothing yet, so the query is kept as written", () => {
    expect(parseScopedQuery("@su", slugs)).toEqual({ slug: null, query: "@su" });
  });

  test("an '@' that names no workspace the person can search is searched for as written", () => {
    expect(parseScopedQuery("@nobody rent", slugs)).toEqual({ slug: null, query: "@nobody rent" });
  });

  test("a plain query has no slug", () => {
    expect(parseScopedQuery("rent", slugs)).toEqual({ slug: null, query: "rent" });
  });
});

/* -------------------------------------------------------------------------- */
/*                                 whyMatched                                 */
/* -------------------------------------------------------------------------- */

describe("whyMatched", () => {
  test("a meaning-only result is 'meaning', whatever the words", () => {
    expect(whyMatched("rent", "Rent increase", true)).toBe("meaning");
  });

  test("every word typed inside the title is 'name'", () => {
    expect(whyMatched("rent increase", "Rent increase 2026", undefined)).toBe("name");
  });

  test("words not all in the title are 'words'", () => {
    expect(whyMatched("rent landlord", "Rent increase 2026", false)).toBe("words");
  });

  test("words of one or two letters are not held against the title", () => {
    expect(whyMatched("a rent", "Rent", undefined)).toBe("name");
  });
});

/* -------------------------------------------------------------------------- */
/*                              itemsFromBlended                              */
/* -------------------------------------------------------------------------- */

describe("itemsFromBlended", () => {
  const rows: BlendedResult[] = [
    result({ slug: "supa", path: "1-projects/2-planning/rent-plan.md", title: "Rent plan", snippet: "the rent" }),
    result({ slug: "seyi", path: "0-inbox/loose.md", title: "Loose thought" }),
    result({ slug: "supa", path: "pricing.md", title: "Pricing", meaningOnly: true }),
  ];

  test("a row in the current workspace is current and keeps its bare path as id", () => {
    const [first] = itemsFromBlended(rows, "rent", "supa");
    expect(first.id).toBe("1-projects/2-planning/rent-plan.md");
    expect(first.workspace).toEqual({ slug: "supa", current: true });
  });

  test("a row in another workspace is not current", () => {
    const items = itemsFromBlended(rows, "rent", "supa");
    expect(items[1].workspace).toEqual({ slug: "seyi", current: false });
  });

  test("detail is '@slug · folder' with sort prefixes dropped, and '@slug' for a root note", () => {
    const items = itemsFromBlended(rows, "rent", "supa");
    expect(items[0].detail).toBe("@supa · projects/planning");
    expect(items[2].detail).toBe("@supa");
  });

  test("a meaning-only row is tagged 'meaning' and flagged meaningOnly", () => {
    const items = itemsFromBlended(rows, "rent", "supa");
    expect(items[2].why).toBe("meaning");
    expect(items[2].meaningOnly).toBe(true);
  });

  test("the snippet carries through when present and the order is the server's", () => {
    const items = itemsFromBlended(rows, "rent", "supa");
    expect(items.map((item) => item.id)).toEqual(["1-projects/2-planning/rent-plan.md", "0-inbox/loose.md", "pricing.md"]);
    expect(items[0].snippet).toBe("the rent");
    expect(items[1].snippet).toBeUndefined();
  });

  test("every row is a note", () => {
    expect(itemsFromBlended(rows, "rent", "supa").every((item) => item.kind === "note")).toBe(true);
  });
});

/* -------------------------------------------------------------------------- */
/*                               paletteStateOf                               */
/* -------------------------------------------------------------------------- */

describe("paletteStateOf", () => {
  test("'searching' stays 'searching'", () => {
    expect(paletteStateOf("searching", null)).toBe("searching");
  });

  test("'failed' stays 'failed'", () => {
    expect(paletteStateOf("failed", null)).toBe("failed");
  });

  test("'idle' stays 'idle'", () => {
    expect(paletteStateOf("idle", null)).toBe("idle");
  });

  test("'ready' with results is 'ready'", () => {
    const withResults = answer({ results: [result({ slug: "supa", path: "a.md", title: "A" })] });
    expect(paletteStateOf("ready", withResults)).toBe("ready");
  });

  test("'empty' with no results and a source still indexing is 'indexing'", () => {
    const indexing = answer({ sources: [source({ slug: "supa", state: "indexing" })] });
    expect(paletteStateOf("empty", indexing)).toBe("indexing");
  });

  test("'empty' with no results and no indexing source is 'ready'", () => {
    const none = answer({ sources: [source({ slug: "supa", state: "ok" })] });
    expect(paletteStateOf("empty", none)).toBe("ready");
  });
});

/* -------------------------------------------------------------------------- */
/*                                sourcesNotice                               */
/* -------------------------------------------------------------------------- */

describe("sourcesNotice", () => {
  test("null for a null answer", () => {
    expect(sourcesNotice(null)).toBeNull();
  });

  test("null when every source answered", () => {
    expect(sourcesNotice(answer({ sources: [source({ slug: "supa" }), source({ slug: "seyi" })] }))).toBeNull();
  });

  test("one indexing source is named and 'is still being indexed'", () => {
    const notice = sourcesNotice(answer({ sources: [source({ slug: "supa", state: "indexing" })] }));
    expect(notice).toContain("@supa is still being indexed");
  });

  test("two indexing sources are joined with ' and ' and use 'are'", () => {
    const notice = sourcesNotice(
      answer({
        sources: [source({ slug: "supa", state: "indexing" }), source({ slug: "seyi", state: "indexing" })],
      }),
    );
    expect(notice).toContain("@supa and @seyi are still being indexed");
  });

  test("a failed source is named and 'did not answer in time'", () => {
    const notice = sourcesNotice(answer({ sources: [source({ slug: "seyi", state: "failed" })] }));
    expect(notice).toBe("@seyi did not answer in time.");
  });
});

/* -------------------------------------------------------------------------- */
/*                              timingBreakdown                               */
/* -------------------------------------------------------------------------- */

describe("timingBreakdown", () => {
  const timed = answer({
    sources: [
      source({ slug: "supa", ms: 300, words: 250, meaning: 280 }),
      source({ slug: "seyi", ms: 120, words: 100, meaning: 90 }),
    ],
  });

  test("null when the answer is null", () => {
    expect(timingBreakdown(null, 340)).toBeNull();
  });

  test("null when the device did not measure the took time", () => {
    expect(timingBreakdown(timed, null)).toBeNull();
  });

  test("total is the device's time; words and meaning are the slowest workspace's", () => {
    const breakdown = timingBreakdown(timed, 340);
    expect(breakdown).not.toBeNull();
    expect(breakdown!.total).toBe(340);
    expect(breakdown!.words).toBe(250);
    expect(breakdown!.meaning).toBe(280);
  });

  test("travel is the total less the slowest workspace", () => {
    expect(timingBreakdown(timed, 340)!.travel).toBe(40);
  });

  test("workspaces are sorted slowest first, and only the first is flagged slowest", () => {
    expect(timingBreakdown(timed, 340)!.workspaces).toEqual([
      { slug: "supa", ms: 300, slowest: true },
      { slug: "seyi", ms: 120, slowest: false },
    ]);
  });

  test("a single timed source is never flagged slowest", () => {
    const single = answer({ sources: [source({ slug: "supa", ms: 300, words: 250, meaning: 280 })] });
    const breakdown = timingBreakdown(single, 340);
    expect(breakdown!.workspaces).toEqual([{ slug: "supa", ms: 300, slowest: false }]);
  });

  test("meaning is null when no source reports meaning", () => {
    const noMeaning = answer({ sources: [source({ slug: "supa", ms: 300, words: 250 })] });
    expect(timingBreakdown(noMeaning, 340)!.meaning).toBeNull();
  });

  test("travel is never negative", () => {
    expect(timingBreakdown(timed, 200)!.travel).toBe(0);
  });

  test("the slow threshold is one second", () => {
    expect(SLOW_MS).toBe(1000);
  });
});

/* -------------------------------------------------------------------------- */
/*                                   seconds                                  */
/* -------------------------------------------------------------------------- */

describe("seconds", () => {
  test("340 ms reads as 0.34 s", () => {
    expect(seconds(340)).toBe("0.34 s");
  });

  test("1420 ms reads as 1.42 s", () => {
    expect(seconds(1420)).toBe("1.42 s");
  });
});

describe("loadedInScope", () => {
  const items = [
    { id: "rent.md", kind: "note" },
    { id: "new-note", kind: "command" },
  ];

  test("every workspace, or the one being browsed, keeps the loaded notes", () => {
    expect(loadedInScope(items, null, "home")).toEqual(items);
    expect(loadedInScope(items, "home", "home")).toEqual(items);
  });

  test("narrowed to another workspace, only the commands stay", () => {
    expect(loadedInScope(items, "elsewhere", "home")).toEqual([{ id: "new-note", kind: "command" }]);
  });
});
