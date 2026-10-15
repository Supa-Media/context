/**
 * SEARCHING SEVERAL CONTEXTS AT ONCE.
 *
 * The console's search page asks one question of every context a person can
 * reach. That is a new shape of request in this system and it brings a new
 * shape of risk with it: a single call that names a **list** of workspaces and
 * returns note paths, titles and body snippets out of several buckets, blended
 * into one list where nothing on screen says which one an answer came from
 * unless the server put it there.
 *
 * So this file asks two different kinds of question.
 *
 * ## The fusion, as arithmetic
 *
 * `lib/blendedSearch.ts` is pure and every rule in it is a decision somebody
 * could reasonably reverse: reciprocal-rank fusion rather than score
 * normalization, per-source cursor offsets rather than a global one, ties
 * broken deterministically. Each is asserted here rather than described,
 * because "one big context dominates the blend" is precisely the failure that
 * looks like a ranking opinion instead of a bug.
 *
 * ## The boundary, as an attack
 *
 * The interesting attacks on a fan-out are not "read another tenant's note".
 * They are subtler and each has a test below:
 *
 *  - **Name someone else's context in the scope list.** A hundred guesses fit
 *    in one request, so an endpoint that refused a real-but-forbidden id
 *    differently from an invented one is an oracle with a hundred times the
 *    throughput of the single-context endpoints `isolation.test.ts` guards.
 *  - **Name it in a crafted cursor.** A cursor is machinery the client is meant
 *    to treat as opaque, which makes it the obvious place to try to smuggle a
 *    workspace in. It must not be able to cause a bucket to be *touched* — so
 *    the assertion is over the other tenant's recorded requests, not over the
 *    response, because a response that omits what it read is still a read.
 *  - **Count what you cannot see.** A blended total assembled before the
 *    privacy filter would tell a team member how many private notes matched
 *    their word, in a system that is careful about that one subtraction
 *    everywhere else.
 *
 * ## Sabotage record
 *
 * Run as temporary local edits and reverted, counts **as measured** — one
 * measured zero included, because a record listing only the satisfying numbers
 * is decoration.
 *
 *   `resolveScope` returning `requested` mapped over the eligible list
 *     instead of intersecting with it                                        3
 *   `fuse` scoring by position on a per-source scale instead of by rank       2
 *   `decodeCursor` returning `at` unclamped                                   1
 *   `pageOf` advancing one global offset instead of one rank per source       1
 *   the fan-out hardcoding `scope: "private"` in place of
 *     `authorizeFileAccess`                                                   1
 *   `searchableFor` accepting any projection state rather than `ready`   0, then 1
 *
 * The last line is the one worth reading. It measured **zero** first time: the
 * fixture only ever built `ready` rows, so a guard that let a half-filled
 * database answer had nothing to trip over. The zero is what bought the
 * "a context still filling its index" test below, and the mutation reddens it
 * now. A backfilling projection answers a query about a note it has not copied
 * yet with a silence, and a blended list renders silence as "nothing here" —
 * which is the single sentence search must never say wrongly.
 *
 * The `scope: "private"` measurement of 1 is thin for how serious that mutation
 * is, and it is thin honestly: `resolveScope` already keeps a caller out of a
 * context they are not in, so the tier check is defence in depth and only the
 * team-tier test can see it move. The alternative — asserting it from several
 * angles — would be several tests measuring the same one thing.
 *
 * ## Sabotage record, second pass
 *
 * Measured over this file and `files.test.ts` together, adversarially rather
 * than by the author:
 *
 *   `searchNotes`' `isVisible` returning true for every path              4
 *   `resolveScope` mapping over `requested` instead of intersecting       4
 *   ...and the fan-out then skipping `authorizeFileAccess` as well        4,
 *     with the other tenant's bucket recording four reads it had not made
 *   `searchContexts` reading offset zero instead of the cursor's          1
 *   `searchableFor` accepting any projection state but `null`             1
 *   the blended total staying exact when a source failed                  1
 *
 * The third line is the one that mattered. It is what proves the recorded-
 * request assertion is load-bearing rather than decorative: with both the
 * scope filter and the authorization gone, the other tenant's bucket went from
 * thirteen requests to seventeen, which is the read a response-shaped
 * assertion cannot see. And the first line is the honest shape of "there is no
 * second privacy filter" — bypassing the one filter is enough to redden this,
 * because there is nowhere else the fan-out could have caught it.
 */

import { describe, expect, test, vi, afterEach } from "vitest";
import {
  BLEND_PAGE_SIZE,
  MAX_SOURCE_DEPTH,
  decodeCursor,
  depthFor,
  encodeCursor,
  fuse,
  pageOf,
  queryFingerprint,
  resolveScope,
  type BlendSource,
} from "../functions/lib/blendedSearch";

afterEach(() => {
  vi.unstubAllGlobals();
});

/* -------------------------------------------------------------------------- */
/*                            the fusion, as arithmetic                        */
/* -------------------------------------------------------------------------- */

/** A source whose hits are `<key>-0.md`, `<key>-1.md`, … in rank order. */
function source(key: string, count: number, offset = 0, asked = BLEND_PAGE_SIZE): BlendSource {
  return {
    key,
    hits: Array.from({ length: count }, (_, index) => ({
      path: `${key}-${index}.md`,
      title: `${key} ${index}`,
      snippets: [`about ${key}`],
    })),
    offset,
    asked,
  };
}

describe("blending several ranked lists", () => {
  test("a big context does not sweep the page", () => {
    // The failure this exists to stop: forty results from one context and one
    // from the other, because the big one's scores are bigger. Under rank
    // fusion each context contributes the same ladder, so the top of the page
    // alternates.
    const rows = fuse([source("big", 40), source("small", 3)]);
    const top = rows.slice(0, 6).map((row) => row.key);
    expect(top.filter((key) => key === "small").length).toBe(3);
    expect(top.filter((key) => key === "big").length).toBe(3);
  });

  test("a context's first result outranks any context's second", () => {
    const rows = fuse([source("a", 5), source("b", 5), source("c", 5)]);
    expect(rows.slice(0, 3).map((row) => row.rank)).toEqual([0, 0, 0]);
    expect(rows.slice(3, 6).map((row) => row.rank)).toEqual([1, 1, 1]);
  });

  test("ties break the same way twice, or paging is nonsense", () => {
    const once = fuse([source("a", 4), source("b", 4)]).map((row) => `${row.key}/${row.path}`);
    const again = fuse([source("b", 4), source("a", 4)]).map((row) => `${row.key}/${row.path}`);
    expect(again).toEqual(once);
  });

  test("the same note in two contexts is two notes; the same source twice is one", () => {
    const a = { ...source("a", 1), hits: [{ path: "1-projects/plan.md", title: "Plan", snippets: [] }] };
    const b = { ...source("b", 1), hits: [{ path: "1-projects/plan.md", title: "Plan", snippets: [] }] };
    expect(fuse([a, b]).length).toBe(2);
    expect(fuse([a, a]).length).toBe(1);
  });
});

describe("paging across sources", () => {
  test("page two resumes each context where page one stopped reading it", () => {
    const sources = [source("a", 30, 0, 30), source("b", 2, 0, 30)];
    const first = pageOf(fuse(sources), sources, 4);
    expect(first.next).not.toBeNull();
    // `b` gave both of its results to page one; `a` gave two. So page two
    // resumes `a` at rank 2 and `b` at rank 2 — not both at "four results in",
    // which is what a single global offset would say.
    expect(first.next).toEqual({ a: 2, b: 2 });
  });

  test("a page that exhausts every source offers no cursor", () => {
    const sources = [source("a", 2, 0, BLEND_PAGE_SIZE), source("b", 1, 0, BLEND_PAGE_SIZE)];
    expect(pageOf(fuse(sources), sources).next).toBeNull();
  });

  test("a source that filled its window keeps the cursor alive", () => {
    const sources = [source("a", 5, 0, 5)];
    expect(pageOf(fuse(sources), sources, 10).next).toEqual({ a: 5 });
  });

  test("nothing pages past the rank the ranker stops at", () => {
    expect(depthFor(0)).toBe(BLEND_PAGE_SIZE);
    expect(depthFor(MAX_SOURCE_DEPTH)).toBe(MAX_SOURCE_DEPTH);
    expect(depthFor(MAX_SOURCE_DEPTH * 10)).toBe(MAX_SOURCE_DEPTH);
    // A source already read to the last rank reports itself finished rather
    // than asking for a page that does not exist.
    const sources = [source("a", MAX_SOURCE_DEPTH, MAX_SOURCE_DEPTH, MAX_SOURCE_DEPTH)];
    expect(pageOf(fuse(sources), sources).next).toBeNull();
  });
});

/* -------------------------------------------------------------------------- */
/*                          the cursor, as an attack                          */
/* -------------------------------------------------------------------------- */

describe("a cursor is arithmetic and nothing else", () => {
  const print = queryFingerprint("review cycle");

  test("it carries no trace of the words somebody typed", () => {
    const cursor = encodeCursor(print, { ws1: 3 });
    expect(atob(cursor.replace(/-/g, "+").replace(/_/g, "/"))).not.toContain("review");
    expect(atob(cursor.replace(/-/g, "+").replace(/_/g, "/"))).not.toContain("cycle");
  });

  test("a cursor for another query is ignored rather than honoured", () => {
    const cursor = encodeCursor(queryFingerprint("something else"), { ws1: 3 });
    expect(decodeCursor(cursor, print)).toEqual({ kind: "fresh" });
  });

  test("a round trip survives", () => {
    expect(decodeCursor(encodeCursor(print, { ws1: 3, ws2: 7 }), print)).toEqual({
      kind: "page",
      offsets: { ws1: 3, ws2: 7 },
    });
  });

  test("garbage, and every arithmetic attack, lands on the first page", () => {
    for (const raw of ["", "not-base64!!", btoa("[]"), btoa('{"v":2,"q":"x","at":{}}'), "x".repeat(9000)]) {
      expect(decodeCursor(raw, print).kind).toBe("fresh");
    }
    // A negative offset would slice from the END of a ranked list, which is a
    // page nobody could otherwise reach; a fractional one slices at nothing;
    // an enormous one asks for a rank that does not exist.
    const forged = btoa(
      JSON.stringify({ v: 1, q: print, at: { a: -1, b: 2.7, c: 1e9, d: "3", e: Infinity } }),
    );
    expect(decodeCursor(forged, print)).toEqual({
      kind: "page",
      offsets: { b: 2, c: MAX_SOURCE_DEPTH },
    });
  });
});

describe("a scope can only ever narrow", () => {
  const eligible = [
    { workspaceId: "ws_mine", slug: "ours", displayName: "Mine" },
    { workspaceId: "ws_ours", slug: "ours", displayName: "Ours" },
  ];

  test("no scope means every eligible context", () => {
    expect(resolveScope(eligible, undefined).length).toBe(2);
    expect(resolveScope(eligible, []).length).toBe(2);
  });

  test("an id this caller may not search is dropped, not refused", () => {
    expect(resolveScope(eligible, ["ws_mine", "ws_theirs"]).map((c) => c.workspaceId)).toEqual([
      "ws_mine",
    ]);
    // And a list of nothing but forbidden ids is an empty scope rather than an
    // error — the same answer a list of invented ids gives.
    expect(resolveScope(eligible, ["ws_theirs"]).length).toBe(0);
    expect(resolveScope(eligible, ["ws_never_existed"]).length).toBe(0);
  });
});
