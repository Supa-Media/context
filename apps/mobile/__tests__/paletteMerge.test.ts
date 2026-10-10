/**
 * One ranked list out of the palette's two halves, pinned.
 *
 * `features/design/components/paletteMerge.ts` decides the order of ⌘K once a
 * search has answered. The rules are asserted as orderings and identities, the
 * same way `palette.test.ts` pins its ordering contract.
 *
 * Fixtures are obviously-fake notes and slugs; this repository is public.
 */

import { describe, expect, test } from "@jest/globals";
import { mergeRanked } from "../features/design/components/paletteMerge";
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
    expect(ids(mergeRanked([], server))).toEqual(["c.md", "a.md", "b.md"]);
  });

  test("a server row that is also a loaded match keeps the local label and ranges", () => {
    const localItem = note("rent-plan.md", "Rent plan");
    const local = [match(localItem, 120, [[0, 4]])];
    const server = [note("rent-plan.md", "rent-plan.md (server title)", { snippet: "the rent" })];

    const merged = mergeRanked(local, server);

    expect(merged).toHaveLength(1);
    expect(merged[0].item.label).toBe("Rent plan");
    expect(merged[0].ranges).toEqual([[0, 4]]);
    expect(merged[0].score).toBe(120);
    expect(merged[0].item.snippet).toBe("the rent");
  });

  test("a loaded name match the server did not return comes after the server rows, tagged 'name'", () => {
    const local = [match(note("loaded-only.md", "Loaded only"), 90, [[0, 6]])];
    const server = [note("from-server.md", "From server")];

    const merged = mergeRanked(local, server);

    expect(ids(merged)).toEqual(["from-server.md", "loaded-only.md"]);
    expect(merged[1].item.why).toBe("name");
  });

  test("a command scoring above every local note stays first", () => {
    const local = [
      match(command("new-note", "New note"), 200, [[0, 3]]),
      match(note("a.md", "A note"), 150),
    ];
    const server = [note("s.md", "Server row")];

    expect(ids(mergeRanked(local, server))).toEqual(["new-note", "s.md", "a.md"]);
  });

  test("a command scoring below the best note goes after the server rows", () => {
    const local = [
      match(note("best.md", "Best note"), 200),
      match(command("new-note", "New note"), 50),
    ];
    const server = [note("s.md", "Server row")];

    expect(ids(mergeRanked(local, server))).toEqual(["s.md", "best.md", "new-note"]);
  });

  test("a server item in another workspace with the same path as a local note is a different row", () => {
    const local = [match(note("rent.md", "Rent"), 100, [[0, 4]])];
    const server = [note("rent.md", "Rent", { workspace: { slug: "supa", current: false } })];

    const merged = mergeRanked(local, server);

    expect(merged).toHaveLength(2);
    expect(merged.map((entry) => entry.item.workspace)).toEqual([
      { slug: "supa", current: false },
      undefined,
    ]);
  });

  test("the same key returned twice by the server appears once", () => {
    const server = [note("dup.md", "Dup"), note("dup.md", "Dup")];
    expect(ids(mergeRanked([], server))).toEqual(["dup.md"]);
  });
});
