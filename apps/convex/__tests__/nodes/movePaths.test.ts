/**
 * The path arithmetic and the rules of a queued move (phase 4 of
 * `docs/decisions/app-and-console/convex-tree.md`), without a bucket.
 *
 * Sabotage, each confirmed to fail a case here:
 *  - fold moves newest first in `logicalPath` and the chain case fails;
 *  - drop the `logicalPath(path) === logical` filter in `physicalCandidates`
 *    and the shadowed-name case fails;
 *  - drop the landed preference in `childrenThroughMoves` and the
 *    copied-not-retired case keeps the old row;
 *  - skip the stale-rule narrowing in `carriedRules` and the stale `team`
 *    subfolder case publishes it;
 *  - drop the `carry !== there` narrowing rule and the private-into-team case
 *    publishes the folder;
 *  - restore nothing for `was` in `releasePrivacy` and the undo case widens a
 *    group rule to its parent's `team`.
 */

import { describe, expect, test } from "vitest";
import type { Doc } from "../../_generated/dataModel";
import { logicalPath, pendingMovesOf, physicalCandidates, relocated } from "../../../mcp/src/moves/queued.js";
import { childrenThroughMoves } from "../../functions/lib/nodes/moveOverlay";
import { foldedPages } from "../../functions/lib/nodes/manifestStore";
import { carriedRules, carryPrivacy, releasePrivacy } from "../../functions/lib/nodes/movePrivacy";
import { mutateManifest } from "../../functions/lib/fileOps/privacyRewrite";
import { loadPrivacyState } from "../../functions/lib/fileOps/privacyState";
import type { FileStore } from "../../functions/lib/fileOps";
import { renderPrivacyManifest } from "../../functions/lib/scaffold";
import { memoryStore, type MemoryStore } from "../storeStub.helpers";
import { moveRetryDelay, movesOverlap } from "../../functions/lib/nodes/moveRules";
import { PRIVACY_KEY, type PrivacyRule, type Visibility, effectiveVisibility } from "../../functions/lib/privacy";

describe("where a key is while moves are pending", () => {
  test("one move renames the folder, the things under it, and its marker; nothing else", () => {
    const moves = [{ from: "1-projects/a", to: "2-areas/a" }];
    expect(logicalPath("1-projects/a", moves)).toBe("2-areas/a");
    expect(logicalPath("1-projects/a/x.md", moves)).toBe("2-areas/a/x.md");
    expect(logicalPath("1-projects/a/", moves)).toBe("2-areas/a/");
    expect(logicalPath("1-projects/ab/x.md", moves)).toBe("1-projects/ab/x.md");
    expect(relocated("1-projects/a/x.md", moves)).toBe(true);
    expect(relocated("2-areas/a/x.md", moves)).toBe(false);
  });

  test("a chain folds oldest first, so an object goes straight to where it ends up", () => {
    const moves = [
      { from: "a", to: "b" },
      { from: "b/sub", to: "c" },
    ];
    expect(logicalPath("a/sub/x.md", moves)).toBe("c/x.md");
    expect(logicalPath("a/y.md", moves)).toBe("b/y.md");
    expect(logicalPath("b/sub/x.md", moves)).toBe("c/x.md");
    expect(physicalCandidates("c/x.md", moves)).toEqual(["c/x.md", "b/sub/x.md", "a/sub/x.md"]);
  });

  test("a name a move is carrying away is not a candidate for what now sits there", () => {
    // `a` moved to `b`, and `b`'s old content is elsewhere: `a/x.md` is drawn at
    // `b/x.md`, and the key `b/x.md` itself is drawn at `c/x.md`.
    const moves = [
      { from: "b", to: "c" },
      { from: "a", to: "b" },
    ];
    expect(physicalCandidates("b/x.md", moves)).toEqual(["a/x.md"]);
    expect(physicalCandidates("c/x.md", moves)).toEqual(["c/x.md", "b/x.md"]);
  });

  test("malformed moves are ignored rather than folded", () => {
    expect(
      pendingMovesOf([
        { from: "", to: "b" },
        { from: "a", to: "a" },
        { from: "a", to: "a/b" },
        { from: "a/b", to: "a" },
        { from: "a/", to: "b" },
        null,
        { from: "x", to: "y" },
      ]),
    ).toEqual([{ from: "x", to: "y" }]);
    expect(pendingMovesOf("nope")).toEqual([]);
  });
});

function row(path: string, extra: Partial<Doc<"nodes">> = {}): Doc<"nodes"> {
  const slash = path.lastIndexOf("/");
  return {
    _id: `id-${path}` as never,
    _creationTime: 0,
    workspaceId: "w" as never,
    path,
    name: slash < 0 ? path : path.slice(slash + 1),
    kind: path.endsWith(".md") ? "file" : "folder",
    observedAt: 1,
    ...extra,
  } as Doc<"nodes">;
}

function rowsOf(rows: Doc<"nodes">[]) {
  const children = (folder: string) =>
    rows.filter((entry) => {
      const slash = entry.path.lastIndexOf("/");
      return (slash < 0 ? "" : entry.path.slice(0, slash)) === folder;
    });
  return {
    childrenOf: async (folder: string) => ({ rows: children(folder), more: false }),
    byPath: async (path: string) => rows.find((entry) => entry.path === path) ?? null,
  };
}

describe("a folder listed through pending moves", () => {
  const bucket = [
    row("1-projects"),
    row("1-projects/a"),
    row("1-projects/a/x.md"),
    row("1-projects/a/y.md"),
    row("1-projects/keep.md"),
    row("2-areas"),
    row("2-areas/z.md"),
  ];
  const moves = [{ from: "1-projects/a", to: "2-areas/a" }];

  test("the moved folder leaves its old parent and appears in its new one at once", async () => {
    const { childrenOf, byPath } = rowsOf(bucket);
    const before = await childrenThroughMoves("1-projects", moves, childrenOf, byPath);
    expect(before.rows.map((entry) => entry.path).sort()).toEqual(["1-projects/keep.md"]);
    const after = await childrenThroughMoves("2-areas", moves, childrenOf, byPath);
    expect(after.rows.map((entry) => entry.path).sort()).toEqual(["2-areas/a", "2-areas/z.md"]);
    expect(after.rows.find((entry) => entry.path === "2-areas/a")?.name).toBe("a");
  });

  test("inside the moved folder, the old children are drawn under the new name", async () => {
    const { childrenOf, byPath } = rowsOf(bucket);
    const inside = await childrenThroughMoves("2-areas/a", moves, childrenOf, byPath);
    expect(inside.rows.map((entry) => entry.path).sort()).toEqual(["2-areas/a/x.md", "2-areas/a/y.md"]);
  });

  test("a note copied and not yet retired is drawn once, from the copy that landed", async () => {
    const landed = row("2-areas/a/x.md", { etag: "new" });
    const { childrenOf, byPath } = rowsOf([...bucket, row("2-areas/a"), landed]);
    const inside = await childrenThroughMoves("2-areas/a", moves, childrenOf, byPath);
    const x = inside.rows.filter((entry) => entry.path === "2-areas/a/x.md");
    expect(x).toHaveLength(1);
    expect(x[0]!.etag).toBe("new");
  });
});

describe("the whole-tree walk through pending moves", () => {
  test("folded, sorted, and paged by the last path handed out", async () => {
    const rows = ["1-projects/a/x.md", "1-projects/b.md", "2-areas/z.md"].map((path) => ({ path }));
    const pages = foldedPages(async (after, limit) => {
      const start = after === undefined ? 0 : rows.findIndex((entry) => entry.path > after);
      const slice = start < 0 ? [] : rows.slice(start, start + limit);
      return { rows: slice, cursor: slice.length < limit ? null : slice[slice.length - 1]!.path };
    }, [{ from: "1-projects/a", to: "3-resources/a" }]);
    const first = await pages(undefined, 2);
    expect(first.rows.map((entry) => entry.path)).toEqual(["1-projects/b.md", "2-areas/z.md"]);
    const second = await pages(first.cursor ?? undefined, 2);
    expect(second.rows.map((entry) => entry.path)).toEqual(["3-resources/a/x.md"]);
    expect(second.cursor).toBeNull();
  });
});

const visible = (path: string, rules: readonly PrivacyRule[], overrides: ReadonlyMap<string, Visibility>) =>
  effectiveVisibility(path, rules, overrides);

describe("the rules a queued move carries", () => {
  test("a folder private only because of its parent stays private in a team parent", () => {
    const current = {
      rules: [{ prefix: "2-areas", vis: "team" as Visibility }],
      overrides: new Map<string, Visibility>(),
    };
    const next = carriedRules(current, "1-projects/secret", "2-areas/secret");
    expect(visible("2-areas/secret/x.md", next.rules, next.overrides)).toBe("private");
    // The old name keeps what it had until the move finishes.
    expect(visible("1-projects/secret/x.md", next.rules, next.overrides)).toBe("private");
    expect(next.added.folders).toEqual([{ prefix: "2-areas/secret", visibility: "private" }]);
  });

  test("the folder's own rules and exceptions are copied, the originals kept", () => {
    const current = {
      rules: [
        { prefix: "1-projects", vis: "team" as Visibility },
        { prefix: "1-projects/a/hr", vis: "private" as Visibility },
        { prefix: "3-resources", vis: "team" as Visibility },
      ],
      overrides: new Map<string, Visibility>([["1-projects/a/pay.md", "private"]]),
    };
    const next = carriedRules(current, "1-projects/a", "3-resources/a");
    expect(visible("3-resources/a/hr/x.md", next.rules, next.overrides)).toBe("private");
    expect(visible("3-resources/a/pay.md", next.rules, next.overrides)).toBe("private");
    expect(visible("3-resources/a/open.md", next.rules, next.overrides)).toBe("team");
    expect(visible("1-projects/a/pay.md", next.rules, next.overrides)).toBe("private");
  });

  test("a stale wider rule already under the new name is narrowed, never kept", () => {
    const current = {
      rules: [{ prefix: "2-areas/a/sub", vis: "team" as Visibility }],
      overrides: new Map<string, Visibility>([["2-areas/a/note.md", "team"]]),
    };
    const next = carriedRules(current, "1-projects/a", "2-areas/a");
    expect(visible("2-areas/a/sub/x.md", next.rules, next.overrides)).toBe("private");
    expect(visible("2-areas/a/note.md", next.rules, next.overrides)).toBe("private");
  });

  test("no moved note is ever wider at its new name than at its old one", () => {
    const groups: Visibility[] = ["private", "team", "@leads"];
    for (const parent of groups) {
      for (const destination of groups) {
        for (const note of [undefined, ...groups]) {
          const current = {
            rules: [
              { prefix: "1-projects", vis: parent },
              { prefix: "2-areas", vis: destination },
            ],
            overrides: new Map<string, Visibility>(note === undefined ? [] : [["1-projects/a/n.md", note]]),
          };
          const before = visible("1-projects/a/n.md", current.rules, current.overrides);
          const next = carriedRules(current, "1-projects/a", "2-areas/a");
          const after = visible("2-areas/a/n.md", next.rules, next.overrides);
          const rank = (v: Visibility) => (v === "private" ? 0 : v === "team" ? 2 : 1);
          expect(rank(after), `${parent}→${destination}, note ${note}`).toBeLessThanOrEqual(rank(before));
        }
      }
    }
  });
});

describe("settling the rules", () => {
  async function manifest(rules: string) {
    const store = memoryStore({ conditional: true }) as MemoryStore & FileStore;
    store.seed(PRIVACY_KEY, renderPrivacyManifest("para"));
    await mutateManifest(store, () => ({ rules: parseRules(rules), overrides: new Map() }));
    return store;
  }
  const parseRules = (text: string): PrivacyRule[] =>
    text.split(",").map((pair) => {
      const [prefix, vis] = pair.split("=");
      return { prefix: prefix!, vis: vis as Visibility };
    });

  test("an undone move puts back what an entry said before, never leaving it wider", async () => {
    const store = await manifest("2-areas=team,2-areas/a/sub=@leads");
    const carried = await carryPrivacy(store, "1-projects/a", "2-areas/a");
    expect(carried?.added.folders).toContainEqual({ prefix: "2-areas/a/sub", visibility: "private", was: "@leads" });
    await releasePrivacy(store, { from: "2-areas/a", undone: true, added: carried!.added });
    const after = await loadPrivacyState(store);
    expect(visible("2-areas/a/sub/x.md", after.rules, after.overrides)).toBe("@leads");
    expect(after.rules.some((rule) => rule.prefix === "2-areas/a")).toBe(false);
  });

  test("a finished move drops every rule under the old name and nothing else", async () => {
    const store = await manifest("1-projects=team,1-projects/a=private,1-projects/a/b=private,1-projects/ab=private");
    await releasePrivacy(store, { from: "1-projects/a", undone: false, added: { folders: [], notes: [] } });
    const after = await loadPrivacyState(store);
    expect(after.rules.map((rule) => rule.prefix).sort()).toEqual(["1-projects", "1-projects/ab"]);
  });
});

describe("the queue's small rules", () => {
  test("overlap is any end at, inside or above any other end", () => {
    expect(movesOverlap({ from: "a", to: "b" }, { from: "a/x", to: "c" })).toBe(true);
    expect(movesOverlap({ from: "a", to: "b" }, { from: "c", to: "b/x" })).toBe(true);
    expect(movesOverlap({ from: "a/x", to: "b" }, { from: "a", to: "c" })).toBe(true);
    expect(movesOverlap({ from: "a", to: "b" }, { from: "ab", to: "c" })).toBe(false);
  });

  test("back-off doubles from 30 seconds and stops at 15 minutes", () => {
    expect(moveRetryDelay(1)).toBe(30_000);
    expect(moveRetryDelay(2)).toBe(60_000);
    expect(moveRetryDelay(50)).toBe(15 * 60_000);
  });
});
