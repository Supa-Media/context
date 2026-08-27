/**
 * The palette's ranking, pinned.
 *
 * `features/console/files/palette.ts` is the model behind three surfaces —
 * ⌘K, the ⌘O quick switcher, and the "Move to…" folder picker, which on a
 * phone are all the same full-screen sheet from the bottom toolbar. That sheet
 * shows about six rows and nobody scrolls a fuzzy list with a thumb, so the
 * only interesting property is **which result is first**. Every ordering rule
 * below is asserted as an ordering rather than as a score, because the numbers
 * are tuning and the order is the contract.
 *
 * Fixtures are obviously-fake notes in the PARA shape this product uses. This
 * repository is public; nothing here is anybody's real context.
 */

import { describe, expect, test } from "@jest/globals";
import {
  DEFAULT_LIMIT,
  folderItems,
  fuzzyMatch,
  itemsFromListings,
  rank,
  type PaletteItem,
} from "../features/console/files/palette";
import type { FileEntry, FolderListing } from "../features/console/files/types";

/* -------------------------------------------------------------------------- */
/*                                  helpers                                   */
/* -------------------------------------------------------------------------- */

function note(label: string, id = label): PaletteItem {
  return { id, label, kind: "note" };
}

/** The ids `rank` returns, in order — what the list actually draws. */
function ranked(query: string, items: readonly PaletteItem[], limit?: number): string[] {
  return rank(query, items, limit).map((match) => match.item.id);
}

/**
 * Which of two texts scores higher for `query`.
 *
 * Both must match, and they must not tie — a rule that is only ever asserted
 * through this helper would otherwise pass while doing nothing.
 */
function winner(query: string, left: string, right: string): string {
  const a = fuzzyMatch(query, left);
  const b = fuzzyMatch(query, right);
  expect(a).not.toBeNull();
  expect(b).not.toBeNull();
  expect(a!.score).not.toBe(b!.score);
  return a!.score > b!.score ? left : right;
}

function file(path: string): FileEntry {
  return {
    kind: "file",
    path,
    name: path.slice(path.lastIndexOf("/") + 1),
    visibility: "private",
    inherited: "private",
    exception: false,
    readOnly: false,
  };
}

function folder(path: string): FileEntry {
  return {
    kind: "folder",
    path,
    name: path.slice(path.lastIndexOf("/") + 1),
    visibility: "private",
    inherited: "private",
    exception: false,
    readOnly: false,
  };
}

function listing(path: string, entries: FileEntry[]): FolderListing {
  return { path, folderDefault: "private", entries, truncated: false, manifestUsable: true };
}

/** A small, loaded-in-a-jumbled-order context. `3-resources` never arrived. */
const listings: Readonly<Record<string, FolderListing | undefined>> = {
  "1-projects": listing("1-projects", [
    folder("1-projects/plans"),
    file("1-projects/together-financial-management.md"),
  ]),
  "": listing("", [folder("1-projects"), folder("3-resources"), file("index.md")]),
  "1-projects/plans": listing("1-projects/plans", [file("1-projects/plans/q3.md")]),
  "3-resources": undefined,
};

/* -------------------------------------------------------------------------- */
/*                              subsequence match                             */
/* -------------------------------------------------------------------------- */

describe("fuzzyMatch is a subsequence match", () => {
  test("segment initials find a kebab-case note", () => {
    expect(fuzzyMatch("tgf", "together-financial.md")).not.toBeNull();
    expect(fuzzyMatch("twm", "together-with-money.md")).not.toBeNull();
  });

  test("case-insensitive in both directions", () => {
    expect(fuzzyMatch("TGF", "together-financial.md")).not.toBeNull();
    expect(fuzzyMatch("tgf", "Together-Financial.MD")).not.toBeNull();
  });

  test("out of order is not a subsequence", () => {
    expect(fuzzyMatch("gft", "together-financial.md")).toBeNull();
  });

  test("a character that is not there at all", () => {
    expect(fuzzyMatch("tgz", "together-financial.md")).toBeNull();
    expect(fuzzyMatch("longer-than-the-text", "q3.md")).toBeNull();
  });

  test("an empty query matches everything and highlights nothing", () => {
    expect(fuzzyMatch("", "q3.md")).toEqual({ score: 0, ranges: [] });
  });
});

/* -------------------------------------------------------------------------- */
/*                     the four rules that put the right note first            */
/* -------------------------------------------------------------------------- */

describe("scoring puts the obvious answer first", () => {
  test("exact beats prefix beats a scattered subsequence", () => {
    expect(ranked("proj", [note("p-r-o-j.md"), note("projects.md"), note("proj")])).toEqual([
      "proj",
      "projects.md",
      "p-r-o-j.md",
    ]);
  });

  /** Otherwise `proj` prefers four boundary hits over the word itself. */
  test("consecutive characters beat scattered ones", () => {
    expect(winner("proj", "projects.md", "p-r-o-j.md")).toBe("projects.md");
    // Again with the prefix bonus taken out of it, so only the runs differ.
    expect(winner("proj", "my-projects.md", "my-p-r-o-j.md")).toBe("my-projects.md");
  });

  /** What makes kebab-case names — which is all of them here — searchable. */
  test("a word boundary beats mid-word", () => {
    expect(winner("fin", "together-financial.md", "refining-notes.md")).toBe(
      "together-financial.md",
    );
    expect(winner("man", "financial-management.md", "human-resources.md")).toBe(
      "financial-management.md",
    );
  });

  test("the basename beats a match that is only in the folder part", () => {
    expect(winner("notes", "4-archive/notes.md", "notes/4-archive.md")).toBe(
      "4-archive/notes.md",
    );
  });

  test("and the best placement is found, not the leftmost one", () => {
    const hit = fuzzyMatch("plans", "1-projects/plans");
    expect(hit).not.toBeNull();
    // `p`, `l` and `a` all occur in `1-projects` first; the run in the
    // basename is the one worth highlighting.
    expect(hit!.ranges).toEqual([[11, 16]]);
  });
});

/* -------------------------------------------------------------------------- */
/*                                   ranges                                   */
/* -------------------------------------------------------------------------- */

describe("ranges are what the UI bolds", () => {
  test("adjacent characters merge into one run", () => {
    expect(fuzzyMatch("proj", "projects.md")!.ranges).toEqual([[0, 4]]);
  });

  test("scattered characters stay separate runs", () => {
    expect(fuzzyMatch("proj", "p-r-o-j.md")!.ranges).toEqual([
      [0, 1],
      [2, 3],
      [4, 5],
      [6, 7],
    ]);
  });

  test("ascending, non-overlapping, and they slice the label back out", () => {
    const text = "together-financial-management.md";
    const hit = fuzzyMatch("tfm", text);
    expect(hit).not.toBeNull();
    let previousEnd = 0;
    let bolded = "";
    for (const [start, end] of hit!.ranges) {
      expect(start).toBeGreaterThanOrEqual(previousEnd);
      expect(end).toBeGreaterThan(start);
      previousEnd = end;
      bolded += text.slice(start, end);
    }
    expect(bolded.toLowerCase()).toBe("tfm");
  });
});

/* -------------------------------------------------------------------------- */
/*                                    rank                                    */
/* -------------------------------------------------------------------------- */

describe("rank", () => {
  // Deliberately not in the order `rank` would sort them into, so that an
  // empty query returning "input order" is a claim a test can fail.
  const items = [note("together-financial.md"), note("q3.md"), note("index.md")];

  test("an empty query is the untyped palette: input order, unfiltered", () => {
    expect(ranked("", items)).toEqual(["together-financial.md", "q3.md", "index.md"]);
    expect(ranked("   ", items)).toEqual(["together-financial.md", "q3.md", "index.md"]);
    expect(ranked("", items, 2)).toEqual(["together-financial.md", "q3.md"]);
    // Sorted, that would be shortest first — which is what it must not be.
    expect(ranked("plan", [note("plans-b.md"), note("plans.md")])).toEqual([
      "plans.md",
      "plans-b.md",
    ]);
  });

  test("a query filters to what matches", () => {
    expect(ranked("q3", items)).toEqual(["q3.md"]);
    expect(ranked("zzz", items)).toEqual([]);
  });

  test("ties break on shorter label, then alphabetically", () => {
    const short = fuzzyMatch("notes", "notes.md")!.score;
    const long = fuzzyMatch("notes", "notes-archive.md")!.score;
    expect(short).toBe(long);
    expect(ranked("notes", [note("notes-archive.md"), note("notes.md")])).toEqual([
      "notes.md",
      "notes-archive.md",
    ]);
    expect(ranked("notes", [note("notes-b.md"), note("notes-a.md")])).toEqual([
      "notes-a.md",
      "notes-b.md",
    ]);
  });

  /** A list that reorders between keystrokes is unusable on a touchscreen. */
  test("ranking is deterministic regardless of the order items loaded in", () => {
    const loaded = [
      note("1-projects/plans/q3.md"),
      note("plans.md"),
      note("plan-b.md"),
      note("planning-notes.md"),
      note("2-areas/planning.md"),
      note("p-l-a-n.md"),
    ];
    const reversed = [...loaded].reverse();
    const first = ranked("plan", loaded);
    expect(ranked("plan", reversed)).toEqual(first);
    expect(ranked("plan", loaded)).toEqual(first);
  });

  test("limit defaults to DEFAULT_LIMIT", () => {
    expect(DEFAULT_LIMIT).toBe(50);
    const many = Array.from({ length: 60 }, (_, index) => note(`a-plan-${index}.md`));
    expect(rank("plan", many)).toHaveLength(DEFAULT_LIMIT);
    expect(rank("plan", many, 6)).toHaveLength(6);
  });

  /** The cap is how many rows are drawn, not how many candidates are read. */
  test("a limit returns the best matches, not the first ones found", () => {
    const many: PaletteItem[] = [
      ...Array.from({ length: 60 }, (_, index) => note(`a-plan-${index}.md`)),
      note("plan.md"),
    ];
    expect(ranked("plan", many, 5)[0]).toBe("plan.md");
  });

  test("nothing is cached and nothing is mutated between calls", () => {
    const frozen = Object.freeze([note("plans.md"), note("q3.md")]);
    expect(rank("plan", frozen)).toEqual(rank("plan", frozen));
    expect(frozen.map((item) => item.id)).toEqual(["plans.md", "q3.md"]);
  });
});

/* -------------------------------------------------------------------------- */
/*                                item sources                                */
/* -------------------------------------------------------------------------- */

describe("itemsFromListings", () => {
  const items = itemsFromListings(listings);

  test("only what is actually loaded — an unloaded folder contributes nothing", () => {
    expect(items.some((item) => item.id.startsWith("3-resources/"))).toBe(false);
    // The folder itself is known, because its parent's listing named it.
    expect(items.some((item) => item.id === "3-resources")).toBe(true);
  });

  test("a note is its name, detailed with the folder it lives in", () => {
    expect(items.find((item) => item.id === "1-projects/plans/q3.md")).toEqual({
      id: "1-projects/plans/q3.md",
      label: "q3.md",
      detail: "1-projects/plans",
      kind: "note",
    });
  });

  test("a note at the root says so rather than saying nothing", () => {
    expect(items.find((item) => item.id === "index.md")?.detail).toBe("/");
  });

  test("a folder is its path", () => {
    expect(items.find((item) => item.id === "1-projects/plans")).toEqual({
      id: "1-projects/plans",
      label: "1-projects/plans",
      kind: "folder",
    });
  });

  test("stable order however the listings arrived, and no duplicates", () => {
    const ids = items.map((item) => item.id);
    expect(ids).toEqual([...new Set(ids)]);
    expect(ids).toEqual([
      "1-projects",
      "3-resources",
      "index.md",
      "1-projects/plans",
      "1-projects/together-financial-management.md",
      "1-projects/plans/q3.md",
    ]);
  });

  test("it is what the quick switcher searches", () => {
    expect(ranked("tfm", items)).toEqual(["1-projects/together-financial-management.md"]);
  });
});

describe("folderItems", () => {
  test("null offers every loaded folder, with the root as a real destination", () => {
    expect(folderItems(listings, null).map((item) => item.id)).toEqual([
      "",
      "1-projects",
      "1-projects/plans",
      "3-resources",
    ]);
    expect(folderItems(listings, null)[0]).toEqual({
      id: "",
      label: "/",
      detail: "the root of your context",
      kind: "folder",
    });
  });

  /** A folder cannot move inside itself, so it is not offered as somewhere to. */
  test("the moving folder and its descendants are not offered", () => {
    expect(folderItems(listings, "1-projects").map((item) => item.id)).toEqual([
      "",
      "3-resources",
    ]);
  });

  test("moving a note excludes nothing", () => {
    expect(folderItems(listings, "1-projects/plans/q3.md").map((item) => item.id)).toEqual([
      "",
      "1-projects",
      "1-projects/plans",
      "3-resources",
    ]);
  });

  test("a sibling with a shared prefix is still a destination", () => {
    const withSibling: Record<string, FolderListing | undefined> = {
      "": listing("", [folder("1-projects"), folder("1-projects-archive")]),
    };
    expect(folderItems(withSibling, "1-projects").map((item) => item.id)).toEqual([
      "",
      "1-projects-archive",
    ]);
  });

  test("the picker is filterable, which is the whole point of replacing the list", () => {
    expect(ranked("plans", folderItems(listings, null))).toEqual(["1-projects/plans"]);
  });
});
