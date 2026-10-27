/**
 * One ranked list out of the palette's two halves, pinned.
 *
 * `features/design/components/paletteMerge.ts` decides the order of ⌘K once a
 * search has answered. The rules are asserted as orderings and identities, the
 * same way `palette.test.ts` pins its ordering contract.
 *
 * Fixtures are obviously-fake notes and slugs; this repository is public.
 *
 * Sabotage record for the search tune-up's order (temporary local edits,
 * reverted, as measured):
 *   the answer put above the names again   → "a server row that is also a name match…",
 *                                             "names drawn before the answer stay on top…" and two
 *                                             command orderings fail
 *   meaning folded even with nothing else  → "with nothing else, they are the answer…" fails
 */

import { describe, expect, test } from "@jest/globals";
import { SAME_TOPIC_ID, foldSameTopic, holdsName, mergeRanked } from "../features/design/components/paletteMerge";
import type { Match, PaletteItem } from "../features/console/files/palette";

/* -------------------------------------------------------------------------- */
/*                                  helpers                                   */
/* -------------------------------------------------------------------------- */

function note(id: string, label = id, extra: Partial<PaletteItem> = {}): PaletteItem {
  return { id, label, kind: "note", ...extra };
}

function command(id: string, label: string): PaletteItem {
  return { id, label, kind: "command" };
}

function match(item: PaletteItem, score: number, ranges: [number, number][] = []): Match {
  return { item, score, ranges };
}

function ids(list: readonly Match[]): string[] {
  return list.map((entry) => entry.item.id);
}

/* -------------------------------------------------------------------------- */
/*                                 mergeRanked                                */
/* -------------------------------------------------------------------------- */

describe("mergeRanked", () => {
  test("server rows come out in server order", () => {
    const server = [note("c.md", "C"), note("a.md", "A"), note("b.md", "B")];
    expect(ids(mergeRanked([], server, "x"))).toEqual(["c.md", "a.md", "b.md"]);
  });

  test("a server row that is also a name match keeps the local label and ranges, and its place", () => {
    const localItem = note("rent-plan.md", "Rent plan");
    const local = [match(localItem, 120, [[0, 4]])];
    const server = [note("other.md", "Other"), note("rent-plan.md", "rent-plan.md (server title)", { snippet: "the rent" })];

    const merged = mergeRanked(local, server, "rent");

    expect(ids(merged)).toEqual(["rent-plan.md", "other.md"]);
    expect(merged[0].item.label).toBe("Rent plan");
    expect(merged[0].ranges).toEqual([[0, 4]]);
    expect(merged[0].score).toBe(120);
    expect(merged[0].item.snippet).toBe("the rent");
  });

  /*
   * The search tune-up (Dev2's pick, 2026-10-27; boards M1, M2): what was
   * drawn while the search ran is the top of the list it settles into.
   */
  test("names drawn before the answer stay on top once it lands; the answer arrives below", () => {
    const local = [match(note("one-search-bar.md", "One search bar and better results"), 100, [[0, 3]])];
    const before = mergeRanked(local, [], "one s");
    const after = mergeRanked(local, [note("tex.md", "Tex chat"), note("one-search-bar.md", "x")], "one s");
    expect(ids(before)).toEqual(["one-search-bar.md"]);
    expect(ids(after)).toEqual(["one-search-bar.md", "tex.md"]);
  });

  test("a name matched only by letters in order, not by words, comes after the answer, tagged 'name'", () => {
    const local = [match(note("loaded-only.md", "Ordinary storage bin"), 90, [[0, 1]])];
    const server = [note("from-server.md", "From server")];

    const merged = mergeRanked(local, server, "osb");

    expect(ids(merged)).toEqual(["from-server.md", "loaded-only.md"]);
    expect(merged[1].item.why).toBe("name");
  });

  test("a command scoring above every local note stays first", () => {
    const local = [
      match(command("new-note", "New note"), 200, [[0, 3]]),
      match(note("a.md", "A note"), 150),
    ];
    const server = [note("s.md", "Server row")];

    expect(ids(mergeRanked(local, server, "note"))).toEqual(["new-note", "a.md", "s.md"]);
  });

  test("a command scoring below the best note goes after the server rows", () => {
    const local = [
      match(note("best.md", "Best note"), 200),
      match(command("new-note", "New note"), 50),
    ];
    const server = [note("s.md", "Server row")];

    expect(ids(mergeRanked(local, server, "note"))).toEqual(["best.md", "s.md", "new-note"]);
  });

  test("a server item in another workspace with the same path as a local note is a different row", () => {
    const local = [match(note("rent.md", "Rent"), 100, [[0, 4]])];
    const server = [note("rent.md", "Rent", { workspace: { slug: "supa", current: false } })];

    const merged = mergeRanked(local, server, "rent");

    expect(merged).toHaveLength(2);
    expect(merged.map((entry) => entry.item.workspace)).toEqual([
      undefined,
      { slug: "supa", current: false },
    ]);
  });

  test("the same key returned twice by the server appears once", () => {
    const server = [note("dup.md", "Dup"), note("dup.md", "Dup")];
    expect(ids(mergeRanked([], server, "dup"))).toEqual(["dup.md"]);
  });
});

describe("holdsName", () => {
  test("every word, the last as the start of a word", () => {
    expect(holdsName("one s", note("a", "One search bar"))).toBe(true);
    expect(holdsName("search one", note("a", "One search bar"))).toBe(true);
    expect(holdsName("osb", note("a", "One search bar"))).toBe(false);
    expect(holdsName("bar one x", note("a", "One search bar"))).toBe(false);
    expect(holdsName("pricing", note("a", "free, you cheapo", { name: "pricing" }))).toBe(true);
  });
});

describe("foldSameTopic", () => {
  const rows = [
    match(note("a.md", "A"), 0),
    match(note("m1.md", "Meaning one", { meaningOnly: true }), 0),
    match(note("m2.md", "Meaning two", { meaningOnly: true }), 0),
  ];

  test("notes found only by meaning fold into one line under the rest", () => {
    const folded = foldSameTopic(rows, false);
    expect(ids(folded)).toEqual(["a.md", SAME_TOPIC_ID]);
    expect(folded[1].item.label).toBe("2 more about the same topic");
    expect(folded[1].item.detail).toBe("Meaning one, Meaning two");
  });

  test("opened, they are rows again", () => {
    expect(ids(foldSameTopic(rows, true))).toEqual(["a.md", "m1.md", "m2.md"]);
  });

  test("with nothing else, they are the answer and stay open", () => {
    expect(ids(foldSameTopic(rows.slice(1), false))).toEqual(["m1.md", "m2.md"]);
  });
});
