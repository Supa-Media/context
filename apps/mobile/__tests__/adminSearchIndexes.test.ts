import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, test } from "@jest/globals";
import {
  countParts,
  factsCell,
  fastCell,
  healthCounts,
  joinIndexes,
  matchesFind,
  meaningCell,
  needsAttention,
  tierLabel,
  type MigrationRow,
} from "../features/admin/searchIndexes";
import type { MeaningIndexRow } from "../features/admin/meaningIndexes";

/**
 * The admin Search tab's Indexes view, as data: three per-workspace indexes
 * joined into one row each. The rules worth a red test: a workspace with only
 * one of them still shows, stuck rows come first, an owner's off never reads
 * as needing attention, a failure says why, and the file tree column is the
 * tree's facts, read from exactly the fields `nodesMigration.report` returns.
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
    archived: false,
    ...fields,
  }) as MeaningIndexRow;

/**
 * Exactly the fields `rowValidator` in `apps/convex/functions/nodesMigration.ts`
 * returns, and no more. The rows this file used to build also carried the
 * copy's `stage`, `files`, `sweptAt` and `parity`, which the server stopped
 * sending in #2116: every test stayed green while the live Search tab threw
 * reading `health` off the cell a switch on the missing `stage` never
 * returned. `REPORT_FIELDS` below pins the shape so that cannot recur quietly.
 */
const migration = (fields: Partial<Omit<MigrationRow, "workspaceId">> & { workspaceId?: string } = {}): MigrationRow =>
  ({
    workspaceId: "w1",
    slug: "maya",
    archived: false,
    facts: { ready: true, running: false, retrying: 0, retryKind: null, retryPasses: 0 },
    ...fields,
  }) as MigrationRow;

describe("the migration report's shape", () => {
  test("the fixture is the server's row, field for field", () => {
    const source = readFileSync(join(__dirname, "../../convex/functions/nodesMigration.ts"), "utf8");
    const body = source.slice(source.indexOf("const rowValidator = v.object({"), source.indexOf("\n});", source.indexOf("const rowValidator")));
    const REPORT_FIELDS = [...body.matchAll(/^ {2}(\w+): /gm)].map((match) => match[1]).sort();
    expect(REPORT_FIELDS.length).toBeGreaterThan(0);
    expect(Object.keys(migration()).sort()).toEqual(REPORT_FIELDS);
  });

  test("every cell of a row built from it is a cell", () => {
    for (const row of joinIndexes([meaning()], [migration(), migration({ workspaceId: "w2", facts: null })])) {
      for (const cell of [row.files, row.fast, row.meaning]) expect(typeof cell?.health).toBe("string");
    }
  });
});

describe("one row per workspace", () => {
  test("joins them by workspace, keeping workspaces that have only one", () => {
    const rows = joinIndexes(
      [meaning(), meaning({ workspaceId: "w3", slug: "sam" })],
      [
        migration(),
        migration({
          workspaceId: "w2",
          slug: "supa",
          facts: { ready: true, running: false, retrying: 2, retryKind: "sealed", retryPasses: 1 },
        }),
      ],
    );
    expect(rows.map((row) => row.slug)).toEqual(["supa", "maya", "sam"]);
    const supa = rows[0]!;
    expect(supa.files).toMatchObject({ health: "stuck", label: "Can't read" });
    expect(supa.meaning.health).toBe("none");
    expect(rows.find((row) => row.slug === "sam")!.files.health).toBe("none");
    expect(rows.find((row) => row.slug === "maya")!.changedAt).toBe(1_000);
  });

  test("an archived workspace reads Archived everywhere, last, and never needs attention", () => {
    const rows = joinIndexes(
      [meaning({ workspaceId: "w9", slug: "testagent1", status: "backfilling", notesIndexed: 0, notesPending: null, archived: true })],
      [
        migration({ workspaceId: "w9", slug: "testagent1", facts: null, archived: true }),
        migration({ workspaceId: "w2", slug: "supa", facts: null }),
      ],
    );
    expect(rows.map((row) => row.slug)).toEqual(["supa", "testagent1"]);
    const archived = rows[1]!;
    expect(archived.archived).toBe(true);
    for (const cell of [archived.files, archived.fast, archived.meaning]) {
      expect(cell).toMatchObject({ health: "off", label: "Archived", problem: null, progress: null });
    }
    expect(needsAttention(archived)).toBe(false);
    expect(needsAttention(rows[0]!)).toBe(true);
    expect(countParts("files", healthCounts(rows, "files"))).toContainEqual({ health: "off", text: "1 paused or archived" });
  });

  test("rows show before the migration report lands", () => {
    const rows = joinIndexes([meaning()]);
    expect(rows).toHaveLength(1);
    expect(rows[0]!.files.health).toBe("none");
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

describe("the file tree column", () => {
  test("is the tree's facts", () => {
    const [filling] = joinIndexes([], [migration({ facts: { ready: false, running: true, retrying: 0, retryKind: null, retryPasses: 0 } })]);
    expect(filling!.files).toMatchObject({ health: "working", label: "Filling" });
    const [ready] = joinIndexes([], [migration()]);
    expect(ready!.files).toMatchObject({ health: "ok", label: "Ready" });
  });

  test("a fill that has not started needs attention, unless the facts are paused", () => {
    const [waiting] = joinIndexes([], [migration({ facts: null })]);
    expect(needsAttention(waiting!)).toBe(true);
    const [paused] = joinIndexes([], [migration({ facts: null })], true);
    expect(needsAttention(paused!)).toBe(false);
  });

  test("a workspace only the migration report has still gets a row", () => {
    const rows = joinIndexes([meaning()], [migration({ workspaceId: "w9", slug: "lee" })]);
    expect(rows.map((row) => row.slug)).toEqual(["lee", "maya"]);
    const lee = rows.find((row) => row.slug === "lee")!;
    expect(lee.files).toMatchObject({ health: "ok", label: "Ready" });
    expect(lee.migrationRow?.workspaceId).toBe("w9");
    expect(lee.changedAt).toBeNull();
  });

  test("its summary counts in its own words", () => {
    const rows = joinIndexes([], [migration(), migration({ workspaceId: "w2", slug: "b", facts: null })]);
    expect(countParts("files", healthCounts(rows, "files"))).toEqual([
      { health: "ok", text: "1 ready" },
      { health: "working", text: "1 reading" },
    ]);
  });
});

describe("each index in words", () => {
  test("the facts: ready once every note is read, paused with the copy", () => {
    expect(factsCell(migration())).toMatchObject({ health: "ok", label: "Ready" });
    expect(factsCell(migration({ facts: null }))).toMatchObject({ health: "working", label: "Not started" });
    expect(factsCell(migration({ facts: { ready: false, running: false, retrying: 0, retryKind: null, retryPasses: 0 } }))).toMatchObject({
      health: "working",
      label: "Filling",
    });
    expect(factsCell(migration({ facts: { ready: true, running: false, retrying: 3, retryKind: null, retryPasses: 0 } }))).toMatchObject({
      health: "working",
      label: "Retrying",
      figure: "3 to read again",
    });
    expect(factsCell(migration({ facts: null }), true)).toMatchObject({ health: "off", label: "Paused" });
    expect(factsCell(migration(), true)).toMatchObject({ health: "ok" });
    expect(factsCell(null).health).toBe("none");
  });

  test("notes that will not read say why: at once when lasting, after a few passes when not", () => {
    const facts = (retryKind: string | null, retryPasses: number, retrying = 2) => ({
      facts: { ready: true, running: false, retrying, retryKind, retryPasses },
    });
    expect(factsCell(migration(facts("unsealed", 1)))).toMatchObject({
      health: "stuck",
      label: "Can't read",
      figure: "2 notes",
      problem: expect.stringMatching(/^2 notes were saved unsealed .* Seal again/),
    });
    expect(factsCell(migration(facts("unsealed", 1, 1))).problem).toMatch(/^1 note was saved unsealed .* seals it\.$/);
    // A refused read may be a hiccup: retried quietly, stuck once it keeps happening.
    expect(factsCell(migration(facts("storage", 2)))).toMatchObject({ health: "working", label: "Retrying" });
    expect(factsCell(migration(facts("storage", 3)))).toMatchObject({ health: "stuck", problem: "2 notes were refused by the storage." });
    // Stuck is said even while the copy is paused: pausing does not make a note readable.
    expect(factsCell(migration(facts("unsealed", 1)), true).health).toBe("stuck");
  });

  test("search short of the end by only the unreadable notes is waiting on them, not indexing", () => {
    const stuckCopy = migration({ facts: { ready: true, running: false, retrying: 2, retryKind: "unsealed", retryPasses: 4 } });
    const segunawe = meaning({
      status: "backfilling",
      notesIndexed: 4,
      notesPending: 2,
      fastSearch: { status: "backfilling", notesIndexed: 4, notesPending: 2, priorities: null },
    });
    const [row] = joinIndexes([segunawe], [stuckCopy]);
    expect(row!.fast).toMatchObject({ health: "stuck", label: "Waiting", problem: "Waiting on 2 notes that can't be read. See File tree." });
    expect(row!.meaning).toMatchObject({ health: "stuck", label: "Waiting" });
    expect(row!.files).toMatchObject({ health: "stuck", label: "Can't read" });
    expect(row!.unreadable).toMatchObject({ count: 2, kind: "unsealed" });
    expect(needsAttention(row!)).toBe(true);
    // More left than the unreadable notes explain: still indexing.
    const [busy] = joinIndexes(
      [meaning({ fastSearch: { status: "backfilling", notesIndexed: 4, notesPending: 30, priorities: null } })],
      [stuckCopy],
    );
    expect(busy!.fast).toMatchObject({ health: "working", label: "Indexing" });
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
