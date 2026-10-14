import { describe, expect, test } from "@jest/globals";
import {
  convexCell,
  countParts,
  factsCell,
  filesCell,
  fastCell,
  healthCounts,
  joinIndexes,
  matchesFind,
  meaningCell,
  needsAttention,
  parityWords,
  tierLabel,
  type MigrationRow,
  type MoveRow,
} from "../features/admin/searchIndexes";
import type { MeaningIndexRow } from "../features/admin/meaningIndexes";

/**
 * The admin Search tab's Indexes view, as data: three per-workspace indexes
 * joined into one row each. The rules worth a red test: a workspace with only
 * one of them still shows, stuck rows come first, an owner's off never reads
 * as needing attention, a failure says why, and the file tree column folds the
 * copy and its folder moves, with the copy's facts beside it and never
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
    facts: { ready: true, running: false, retrying: 0 },
    ...fields,
  }) as MigrationRow;

describe("one row per workspace", () => {
  test("joins them by workspace, keeping workspaces that have only one", () => {
    const rows = joinIndexes(
      [meaning(), meaning({ workspaceId: "w3", slug: "sam" })],
      [migration({ sweptAt: 2_000 }), migration({ workspaceId: "w2", slug: "supa", stage: "stuck", error: "Listing failed" })],
    );
    expect(rows.map((row) => row.slug)).toEqual(["supa", "maya", "sam"]);
    const supa = rows[0]!;
    expect(supa.files).toMatchObject({ health: "stuck", problem: "Listing failed" });
    expect(supa.meaning.health).toBe("none");
    expect(rows.find((row) => row.slug === "sam")!.files.health).toBe("none");
    expect(rows.find((row) => row.slug === "maya")!.changedAt).toBe(2_000);
  });

  test("rows show before the migration report lands", () => {
    const rows = joinIndexes([meaning()]);
    expect(rows).toHaveLength(1);
    expect(rows[0]!.details.health).toBe("none");
  });

  test("stuck first, then working, then ready, each by name", () => {
    const rows = joinIndexes([
      meaning({ workspaceId: "a", slug: "alpha" }),
      meaning({ workspaceId: "b", slug: "beta", status: "backfilling", notesPending: 5 }),
      meaning({ workspaceId: "c", slug: "gamma", status: "failed", errorCode: "RATE_LIMITED" }),
    ]);
    expect(rows.map((row) => row.slug)).toEqual(["gamma", "beta", "alpha"]);
    expect(rows.filter(needsAttention).map((row) => row.slug)).toEqual(["gamma", "beta"]);
  });

  test("an owner's off is not something to fix", () => {
    const [row] = joinIndexes([meaning({ enabled: false, status: "off" })]);
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
    const [waiting] = joinIndexes([], [migration({ stage: "waiting", files: 0 })]);
    expect(needsAttention(waiting!)).toBe(true);
    const [paused] = joinIndexes([], [migration({ stage: "waiting", files: 0 })], true);
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
    const rows = joinIndexes([meaning()], [migration({ workspaceId: "w9", slug: "lee", stage: "copied", parity: null })]);
    expect(rows.map((row) => row.slug)).toEqual(["lee", "maya"]);
    const lee = rows.find((row) => row.slug === "lee")!;
    expect(lee.convex.label).toBe("Copied");
    expect(lee.details).toMatchObject({ health: "ok", label: "Ready" });
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

  test("the copy decides it, whatever its facts are doing", () => {
    expect(filesCell(ready, [])).toEqual(ready);
    const [filling] = joinIndexes([], [migration({ facts: { ready: false, running: true, retrying: 0 } })]);
    expect(filling!.files).toEqual(ready);
    expect(filling!.details).toMatchObject({ health: "working", label: "Filling" });
  });

  test("a move copying is work on its way; a stuck one wants a person", () => {
    expect(filesCell(ready, [move()])).toMatchObject({ health: "working", figure: "40 · 1 move copying" });
    expect(filesCell(ready, [move(), move({ id: "m2" })]).figure).toBe("40 · 2 moves copying");
    expect(filesCell(ready, [move({ stuck: true, running: false, lastError: "Copy failed" })])).toMatchObject({
      health: "stuck",
      problem: "A folder move is stuck: Copy failed",
    });
  });

  test("a workspace only the moves report has still gets a row, with its moves", () => {
    const rows = joinIndexes([meaning()], [], false, [move({ workspaceId: "w7", slug: "kai" })]);
    const kai = rows.find((row) => row.slug === "kai")!;
    expect(kai.moves).toHaveLength(1);
    expect(kai.files.health).toBe("working");
    expect(rows.find((row) => row.slug === "maya")!.moves).toEqual([]);
  });

  test("its summary counts in its own words", () => {
    const rows = joinIndexes([], [migration(), migration({ workspaceId: "w2", slug: "b", stage: "differs" })]);
    expect(countParts("files", healthCounts(rows, "files"))).toEqual([
      { health: "ok", text: "1 ready" },
      { health: "stuck", text: "1 stuck or differ" },
    ]);
  });
});

describe("each index in words", () => {
  test("the facts: ready once every note is read, never stuck, paused with the copy", () => {
    expect(factsCell(migration())).toMatchObject({ health: "ok", label: "Ready" });
    expect(factsCell(migration({ facts: null }))).toMatchObject({ health: "working", label: "Not started" });
    expect(factsCell(migration({ facts: { ready: false, running: false, retrying: 0 } }))).toMatchObject({
      health: "working",
      label: "Filling",
    });
    expect(factsCell(migration({ facts: { ready: true, running: false, retrying: 3 } }))).toMatchObject({
      health: "working",
      label: "Retrying",
      figure: "3 to read again",
    });
    expect(factsCell(migration({ facts: null }), true)).toMatchObject({ health: "off", label: "Paused" });
    expect(factsCell(migration(), true)).toMatchObject({ health: "ok" });
    expect(factsCell(null).health).toBe("none");
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
    const rows = joinIndexes([
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
