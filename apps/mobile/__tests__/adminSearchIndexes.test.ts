import { describe, expect, test } from "@jest/globals";
import {
  convexCell,
  countParts,
  filesCell,
  fastCell,
  healthCounts,
  joinIndexes,
  matchesFind,
  meaningCell,
  needsAttention,
  parityWords,
  tierLabel,
  treeCell,
  type MigrationRow,
  type MoveRow,
  type TreeIndexRow,
} from "../features/admin/searchIndexes";
import type { MeaningIndexRow } from "../features/admin/meaningIndexes";

/**
 * The admin Search tab's Indexes view, as data: three per-workspace indexes
 * joined into one row each. The rules worth a red test: a workspace with only
 * one of them still shows, stuck rows come first, an owner's off never reads
 * as needing attention, a failure says why, and the file tree column folds the
 * copy, its D1 details and its folder moves without a busy detail ever
 * reading as a problem.
 */

const meaning = (fields: Partial<Omit<MeaningIndexRow, "workspaceId">> & { workspaceId?: string } = {}): MeaningIndexRow =>
  ({
    workspaceId: "w1",
    slug: "maya",
    kind: "personal",
    enabled: true,
    status: "ready",
    errorCode: null,
    errorCause: null,
    notesIndexed: 100,
    notesPending: 0,
    priorities: null,
    fastSearch: { status: "ready", notesIndexed: 100, notesPending: 0, priorities: null },
    updatedAt: 1_000,
    ...fields,
  }) as MeaningIndexRow;

const tree = (fields: Partial<Omit<TreeIndexRow, "workspaceId">> & { workspaceId?: string } = {}): TreeIndexRow =>
  ({
    workspaceId: "w1",
    slug: "maya",
    status: "ready",
    rows: 120,
    sweptAt: 2_000,
    dirty: false,
    error: null,
    ...fields,
  }) as TreeIndexRow;

const migration = (fields: Partial<Omit<MigrationRow, "workspaceId">> & { workspaceId?: string } = {}): MigrationRow =>
  ({
    workspaceId: "w1",
    slug: "maya",
    stage: "matches",
    files: 40,
    running: false,
    sweptAt: 3_000,
    dirty: false,
    error: null,
    parity: { checkedAt: 4_000, mismatches: 0, privacyMatches: true },
    ...fields,
  }) as MigrationRow;

describe("one row per workspace", () => {
  test("joins the three by workspace, keeping workspaces that have only one", () => {
    const rows = joinIndexes(
      [tree(), tree({ workspaceId: "w2", slug: "supa", status: "empty", rows: null, sweptAt: null })],
      [meaning(), meaning({ workspaceId: "w3", slug: "sam" })],
    );
    expect(rows.map((row) => row.slug)).toEqual(["supa", "maya", "sam"]);
    const supa = rows[0]!;
    expect(supa.details.label).toBe("Not filled");
    expect(supa.files).toMatchObject({ health: "stuck", problem: "Lists, Boards and map details: not filled" });
    expect(supa.meaning.health).toBe("none");
    expect(rows.find((row) => row.slug === "sam")!.files.health).toBe("none");
    expect(rows.find((row) => row.slug === "maya")!.changedAt).toBe(2_000);
  });

  test("rows show before the tree read lands", () => {
    const rows = joinIndexes(null, [meaning()]);
    expect(rows).toHaveLength(1);
    expect(rows[0]!.details.health).toBe("none");
  });

  test("stuck first, then working, then ready, each by name", () => {
    const rows = joinIndexes(null, [
      meaning({ workspaceId: "a", slug: "alpha" }),
      meaning({ workspaceId: "b", slug: "beta", status: "backfilling", notesPending: 5 }),
      meaning({ workspaceId: "c", slug: "gamma", status: "failed", errorCode: "RATE_LIMITED" }),
    ]);
    expect(rows.map((row) => row.slug)).toEqual(["gamma", "beta", "alpha"]);
    expect(rows.filter(needsAttention).map((row) => row.slug)).toEqual(["gamma", "beta"]);
  });

  test("an owner's off is not something to fix", () => {
    const [row] = joinIndexes(null, [meaning({ enabled: false, status: "off" })]);
    expect(row!.meaning.label).toBe("Off by owner");
    expect(needsAttention(row!)).toBe(false);
  });
});

describe("the Convex copy column", () => {
  test("every stage reads in words, with the file count as the figure", () => {
    expect(convexCell(migration())).toMatchObject({ health: "ok", label: "Matches", figure: "40", problem: null });
    expect(convexCell(migration({ stage: "copied", parity: null }))).toMatchObject({ health: "ok", label: "Copied" });
    expect(convexCell(migration({ stage: "copying", files: 12 }))).toMatchObject({ health: "working", label: "Copying", figure: "12" });
    expect(convexCell(migration({ stage: "waiting", files: 0 }))).toMatchObject({ health: "working", label: "Not started", figure: null });
    expect(convexCell(migration({ stage: "stuck", error: "Listing failed" }))).toMatchObject({
      health: "stuck",
      label: "Stuck",
      problem: "Listing failed",
    });
    expect(convexCell(migration({ stage: "skipped" }))).toMatchObject({
      health: "off",
      label: "Skipped",
      problem: "This storage can't be listed in order (Dropbox)",
    });
    expect(convexCell(null).health).toBe("none");
  });

  test("a difference says how many files and whether the privacy rules differ", () => {
    const three = migration({ stage: "differs", parity: { checkedAt: 4_000, mismatches: 3, privacyMatches: true } });
    expect(convexCell(three)).toMatchObject({ health: "stuck", label: "Differs", problem: "3 files differ from the bucket" });
    const both = migration({ stage: "differs", parity: { checkedAt: 4_000, mismatches: 1, privacyMatches: false } });
    expect(convexCell(both).problem).toBe("1 file differs from the bucket; privacy rules differ");
    const privacy = migration({ stage: "differs", parity: { checkedAt: 4_000, mismatches: 0, privacyMatches: false } });
    expect(convexCell(privacy).problem).toBe("Privacy rules differ");
  });

  test("paused: waiting and copying read as paused, finished and failed work does not", () => {
    expect(convexCell(migration({ stage: "waiting", files: 0 }), true)).toMatchObject({ health: "off", label: "Paused" });
    expect(convexCell(migration({ stage: "copying", files: 12 }), true)).toMatchObject({
      health: "off",
      label: "Paused",
      figure: "12",
    });
    expect(convexCell(migration({ stage: "matches" }), true)).toMatchObject({ health: "ok", label: "Matches" });
    expect(convexCell(migration({ stage: "stuck", error: "Listing failed" }), true)).toMatchObject({ health: "stuck" });
  });

  test("a copy that has not started needs attention, unless the migration is paused", () => {
    const [waiting] = joinIndexes(null, [], [migration({ stage: "waiting", files: 0 })]);
    expect(needsAttention(waiting!)).toBe(true);
    const [paused] = joinIndexes(null, [], [migration({ stage: "waiting", files: 0 })], true);
    expect(needsAttention(paused!)).toBe(false);
  });

  test("parity is said in words", () => {
    expect(parityWords(null)).toBe("Not checked against the bucket yet");
    expect(parityWords({ checkedAt: 1, mismatches: 0, privacyMatches: true })).toBe("Matches the bucket");
    expect(parityWords({ checkedAt: 1, mismatches: 2, privacyMatches: false })).toBe(
      "2 files differ from the bucket; privacy rules differ",
    );
  });

  test("a workspace only the migration report has still gets a row", () => {
    const rows = joinIndexes(null, [meaning()], [migration({ workspaceId: "w9", slug: "lee", stage: "copied", parity: null })]);
    expect(rows.map((row) => row.slug)).toEqual(["lee", "maya"]);
    const lee = rows.find((row) => row.slug === "lee")!;
    expect(lee.convex.label).toBe("Copied");
    expect(lee.details.health).toBe("none");
    expect(lee.migrationRow?.workspaceId).toBe("w9");
    expect(lee.changedAt).toBe(3_000);
  });
});

const move = (fields: Partial<Omit<MoveRow, "id" | "workspaceId">> & { id?: string; workspaceId?: string } = {}): MoveRow =>
  ({
    id: "m1",
    workspaceId: "w1",
    slug: "maya",
    state: "moving",
    total: 340,
    moved: 120,
    attempts: 0,
    lastError: null,
    undone: false,
    running: true,
    stuck: false,
    canUndo: true,
    createdAt: 5_000,
    updatedAt: 6_000,
    ...fields,
  }) as MoveRow;

describe("the file tree column", () => {
  const ready = convexCell(migration());
  const filled = treeCell(tree());

  test("the copy decides it when the details are fine or only catching up", () => {
    expect(filesCell(ready, filled, [])).toEqual(ready);
    expect(filesCell(ready, treeCell(tree({ dirty: true })), [])).toEqual(ready);
    expect(filesCell(ready, treeCell(null), [])).toEqual(ready);
  });

  test("stuck details make it stuck, and say it is the details", () => {
    expect(filesCell(ready, treeCell(tree({ error: "timeout" })), [])).toMatchObject({
      health: "stuck",
      label: "Matches",
      problem: "Lists, Boards and map details: Last pass failed: timeout",
    });
  });

  test("a stuck copy keeps its own reason over the details'", () => {
    const stuck = convexCell(migration({ stage: "stuck", error: "Listing failed" }));
    expect(filesCell(stuck, treeCell(tree({ error: "timeout" })), [])).toMatchObject({ problem: "Listing failed" });
  });

  test("a move copying is work on its way; a stuck one wants a person", () => {
    expect(filesCell(ready, filled, [move()])).toMatchObject({ health: "working", figure: "40 · 1 move copying" });
    expect(filesCell(ready, filled, [move(), move({ id: "m2" })]).figure).toBe("40 · 2 moves copying");
    expect(filesCell(ready, filled, [move({ stuck: true, running: false, lastError: "Copy failed" })])).toMatchObject({
      health: "stuck",
      problem: "A folder move is stuck: Copy failed",
    });
  });

  test("a workspace only the moves report has still gets a row, with its moves", () => {
    const rows = joinIndexes(null, [meaning()], [], false, [move({ workspaceId: "w7", slug: "kai" })]);
    const kai = rows.find((row) => row.slug === "kai")!;
    expect(kai.moves).toHaveLength(1);
    expect(kai.files.health).toBe("working");
    expect(rows.find((row) => row.slug === "maya")!.moves).toEqual([]);
  });

  test("its summary counts in its own words", () => {
    const rows = joinIndexes(null, [], [migration(), migration({ workspaceId: "w2", slug: "b", stage: "differs" })]);
    expect(countParts("files", healthCounts(rows, "files"))).toEqual([
      { health: "ok", text: "1 ready" },
      { health: "stuck", text: "1 stuck or differ" },
    ]);
  });
});

describe("each index in words", () => {
  test("the tree: a failed pass reads as stuck with its reason, a big change as catching up", () => {
    expect(treeCell(tree({ error: "timeout" }))).toMatchObject({ health: "stuck", problem: "Last pass failed: timeout" });
    expect(treeCell(tree({ dirty: true }))).toMatchObject({ health: "working", label: "Catching up" });
    expect(treeCell(tree({ status: "unsupported" })).health).toBe("off");
    expect(treeCell(tree()).figure).toBe("120");
  });

  test("fast search and meaning show how far they got, with a bar only while there is more", () => {
    expect(fastCell({ status: "backfilling", notesIndexed: 312, notesPending: 930, priorities: null })).toMatchObject({
      label: "Indexing",
      figure: "312 of 1,242",
      progress: { done: 312, total: 1242 },
    });
    expect(fastCell(null).health).toBe("none");
    expect(meaningCell(meaning()).progress).toBeNull();
    expect(meaningCell(meaning({ status: "failed", errorCode: "REFUSED", errorCause: "http_400" })).problem).toBe(
      "Cloudflare refused a request (http_400)",
    );
  });

  test("summary counts say only what is there", () => {
    const rows = joinIndexes(null, [
      meaning({ workspaceId: "a", slug: "a" }),
      meaning({ workspaceId: "b", slug: "b", status: "failed" }),
    ]);
    expect(countParts("meaning", healthCounts(rows, "meaning"))).toEqual([
      { health: "ok", text: "1 ready" },
      { health: "stuck", text: "1 failed" },
    ]);
  });

  test("find matches with or without the @, and tiers are named from T0", () => {
    expect(matchesFind({ slug: "maya" }, "@MA")).toBe(true);
    expect(matchesFind({ slug: "maya" }, "sam")).toBe(false);
    expect(matchesFind({ slug: null }, "")).toBe(true);
    expect([1, 2, 3].map(tierLabel)).toEqual(["T0 Main", "T1 Inbox", "T2 Archive"]);
  });
});
