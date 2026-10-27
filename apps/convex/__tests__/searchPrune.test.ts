/**
 * A `ready` fast search database lets go of notes that are gone, and picks up
 * the tree's notes it lacks.
 *
 * The copy deletes rows for notes the bucket lacks while it runs, and it stops
 * running at `ready`. After that only the product's own writes said what they
 * removed, so a note deleted in Obsidian, or a row left behind before writes
 * were followed, answered searches for good with a path that opens nothing:
 * seen on @supa, 2026-10-13, with a probe note moved away hours earlier. A
 * daily check (`pruneIndex`) now asks the bucket about every row it lacks.
 *
 * ## Sabotage record
 *
 * Temporary local edits, reverted, counts as measured over this file:
 *
 *   `pruneSearchIndex` deletes nothing (runAll skipped)                     4
 *   `goneFromBucket` deletes without asking the bucket by name              1
 *   `runPrunePass` ignores pending moves                                    1
 *   the barrier runs `pruneIndex` against a `backfilling` row               1
 *   `schedulePrunes` never marks `prunedAt`                                 1
 *   `goneFromBucket` asks the bucket by name rather than the tree           3
 *   `runPrunePass` only removes rows, copying nothing (before 2026-10-27)   3
 */

import { afterEach, describe, expect, test, vi } from "vitest";
import { internal } from "../_generated/api";
import type { Id } from "../_generated/dataModel";
import type { ActionCtx } from "../_generated/server";
import { type FileStore, projectSearchIndex } from "../functions/lib/fileOps";
import { pruneSearchIndex } from "../functions/lib/fileOps/projection";
import { runPrunePass } from "../functions/lib/filesFns/prunePass";
import { PRIVACY_KEY } from "../functions/lib/privacy";
import { copyTree } from "./fixtures.helpers";
import { stubD1 } from "./searchBackfill.helpers";
import { cancelPendingJobs, opted, row } from "./searchBackfill.trigger.helpers";
import { memoryStore, withTreeOf, type MemoryStore } from "./storeStub.helpers";
import type { TestConvex } from "./fixtures.helpers";
import { renderPrivacyManifest } from "./seededRules.helpers";

afterEach(async () => {
  await cancelPendingJobs();
  vi.unstubAllGlobals();
});

function bucket(): MemoryStore & FileStore {
  const store = memoryStore() as MemoryStore & FileStore;
  store.seed(PRIVACY_KEY, renderPrivacyManifest("para"));
  store.seed("2-areas/plans.md", "# Plans\n\nThe quokkaplan ships in March.\n");
  store.seed("0-inbox/probe.md", "# Probe\n\nA quokka probe.\n");
  return store;
}

async function converged(store: FileStore) {
  const d1 = stubD1();
  for (let links = 0; links < 12; links += 1) {
    const pass = await projectSearchIndex(store, d1.client);
    if (pass.ready || !pass.moved) break;
  }
  expect(d1.paths()).toEqual(["0-inbox/probe.md", "2-areas/plans.md"]);
  return d1;
}

/** A row for a note the bucket does not have, as a pre-fix move left on @supa. */
async function strandRow(client: ReturnType<typeof stubD1>["client"], path: string) {
  await client.query("INSERT INTO notes (path, version, visibility, title, uploaded, chunks)", [
    path,
    "stale-version",
    "private",
    "Probe",
    null,
    1,
  ]);
}

describe("pruning a ready database", () => {
  test("a note deleted outside the product loses its row; every other row stays", async () => {
    const store = bucket();
    const d1 = await converged(store);
    // Deleted in Obsidian: no write of ours ever hears of it.
    await store.delete("0-inbox/probe.md");

    expect(await pruneSearchIndex(store, d1.client)).toEqual({ deleted: 1, checked: true });
    expect(d1.paths()).toEqual(["2-areas/plans.md"]);
  });

  test("a row stranded by a move made before moves were followed goes too", async () => {
    const store = bucket();
    const d1 = await converged(store);
    await strandRow(d1.client, "0-inbox/search-freshness-probe.md");

    expect(await pruneSearchIndex(store, d1.client)).toEqual({ deleted: 1, checked: true });
    expect(d1.paths()).toEqual(["0-inbox/probe.md", "2-areas/plans.md"]);
  });

  test("a note written after the listing keeps its row", async () => {
    const store = bucket();
    const d1 = await converged(store);
    store.seed("1-projects/fresh.md", "# Fresh\n");
    await strandRow(d1.client, "1-projects/fresh.md");
    // The listing was taken before the note was written: it lacks it, the bucket has it.
    // The census is the tree's names, which the store's own `treeListing` reads: the omission must reach it too.
    const listedBefore = withTreeOf(
      new Proxy(store, {
        get(target, key, receiver) {
          if (key !== "list") return Reflect.get(target, key, receiver);
          return async (options: unknown) => {
            const page = await target.list(options as never);
            return { ...page, objects: page.objects.filter((object: { key: string }) => object.key !== "1-projects/fresh.md") };
          };
        },
      }),
    );

    expect(await pruneSearchIndex(listedBefore, d1.client)).toEqual({ deleted: 0, checked: true });
    expect(d1.paths()).toContain("1-projects/fresh.md");
  });

  test("a listing that fails deletes nothing", async () => {
    const store = bucket();
    const d1 = await converged(store);
    await store.delete("0-inbox/probe.md");
    // The census is the tree's names, which the store's own `treeListing` reads: the refusal must reach it too.
    const refused = withTreeOf(
      new Proxy(store, {
        get(target, key, receiver) {
          if (key !== "list") return Reflect.get(target, key, receiver);
          return async () => {
            throw new Error("listing refused");
          };
        },
      }),
    );

    expect(await pruneSearchIndex(refused, d1.client)).toEqual({ deleted: 0, checked: false });
    expect(d1.paths()).toContain("0-inbox/probe.md");
  });

  test("nothing is pruned while a queued folder move is copying", async () => {
    const store = bucket();
    const d1 = await converged(store);
    await store.delete("0-inbox/probe.md");
    const scheduled: unknown[] = [];
    const ctx = { scheduler: { runAfter: async (...args: unknown[]) => scheduled.push(args) } } as unknown as ActionCtx;
    const args = { workspaceId: "w" as Id<"workspaces">, operation: { passes: 3 } };

    const moving = await runPrunePass(ctx, args, store, d1.client, [{ from: "0-inbox", to: "2-areas/inbox" } as never]);
    expect(moving).toEqual({ kind: "indexPruned", deleted: 0, checked: false });
    expect(d1.paths()).toContain("0-inbox/probe.md");

    const settled = await runPrunePass(ctx, args, store, d1.client, []);
    expect(settled).toEqual({ kind: "indexPruned", deleted: 1, checked: true });
    expect(d1.paths()).toEqual(["2-areas/plans.md"]);
    // It removed something, so it looks again; with nothing left, the chain ends.
    expect(scheduled).toHaveLength(1);
    await runPrunePass(ctx, args, store, d1.client, []);
    expect(scheduled).toHaveLength(1);
  });
});

/**
 * A store whose reads still answer a built-in folder's numbered spelling, as
 * `canonicalJobPath` does in production: `1-projects/x.md` opens `projects/x.md`.
 * The tree (`treeListing.taken`) holds only the names that exist.
 */
function aliasingNumbers(store: MemoryStore & FileStore): MemoryStore & FileStore {
  return new Proxy(store, {
    get(target, key, receiver) {
      if (key !== "get") return Reflect.get(target, key, receiver);
      return async (path: string) => (await target.get(path)) ?? (await target.get(path.replace(/^\d-/, "")));
    },
  });
}

/** Every link of one day's check, run in order, as the scheduler would. */
async function dailyCheck(store: FileStore, client: ReturnType<typeof stubD1>["client"], passes = 60) {
  let links = 0;
  let next: number | null = passes;
  while (next !== null && links < passes) {
    links += 1;
    let scheduled: number | null = null;
    const ctx = {
      scheduler: {
        runAfter: async (_ms: number, _fn: unknown, args: { operation: { passes: number } }) => {
          scheduled = args.operation.passes;
        },
      },
    } as unknown as ActionCtx;
    await runPrunePass(ctx, { workspaceId: "w" as Id<"workspaces">, operation: { passes: next } }, store, client, []);
    next = scheduled;
  }
  return links;
}

describe("re-filing a ready database after folders are renamed", () => {
  test("a row at a folder's old name goes, though a read by the old name still opens the note", async () => {
    const store = bucket();
    const d1 = await converged(store);
    store.seed("projects/plan.md", "# Plan\n\nThe wombatplan.\n");
    await strandRow(d1.client, "1-projects/plan.md");

    expect(await pruneSearchIndex(aliasingNumbers(store), d1.client)).toEqual({ deleted: 1, checked: true });
    expect(d1.paths()).toEqual(["0-inbox/probe.md", "2-areas/plans.md"]);
  });

  test("the daily check copies notes the database lacks, at the names the tree has", async () => {
    const store = bucket();
    const d1 = await converged(store);
    // Renamed by the move watchdog: the notes moved, and nothing told the database.
    const body = await (await store.get("2-areas/plans.md"))!.text();
    store.seed("areas/plans.md", body);
    await store.delete("2-areas/plans.md");

    await dailyCheck(aliasingNumbers(store), d1.client);

    expect(d1.paths()).toEqual(["0-inbox/probe.md", "areas/plans.md"]);
  });

  test("a whole renamed workspace is re-filed in one day's links", async () => {
    const store = memoryStore() as MemoryStore & FileStore;
    store.seed(PRIVACY_KEY, renderPrivacyManifest("para"));
    for (let n = 0; n < 250; n += 1) store.seed(`1-projects/note-${n}.md`, `# Note ${n}\n\nAbout kangaroo ${n}.\n`);
    const d1 = stubD1();
    for (let links = 0; links < 40; links += 1) {
      const pass = await projectSearchIndex(store, d1.client);
      if (pass.ready || !pass.moved) break;
    }
    expect(d1.paths()).toHaveLength(250);
    for (let n = 0; n < 250; n += 1) {
      store.seed(`projects/note-${n}.md`, `# Note ${n}\n\nAbout kangaroo ${n}.\n`);
      await store.delete(`1-projects/note-${n}.md`);
    }

    const links = await dailyCheck(aliasingNumbers(store), d1.client);

    expect(d1.paths().filter((path) => path.startsWith("1-projects/"))).toEqual([]);
    expect(d1.paths().filter((path) => path.startsWith("projects/"))).toHaveLength(250);
    expect(links).toBeLessThan(60);
  });

  test("a converged database ends the day's chain once its sweep is round", async () => {
    const store = bucket();
    const d1 = await converged(store);
    const before = d1.writes.length;

    const links = await dailyCheck(store, d1.client);

    expect(links).toBeLessThanOrEqual(2);
    expect(d1.paths()).toEqual(["0-inbox/probe.md", "2-areas/plans.md"]);
    // Nothing re-copied: every note was already current.
    expect(d1.writes.slice(before).filter((sql) => /INSERT INTO notes\b/i.test(sql))).toEqual([]);
  });
});

/** `pruneIndex` jobs waiting to run, by workspace. */
async function prunesQueued(t: TestConvex) {
  return await t.run(async (ctx) =>
    (await ctx.db.system.query("_scheduled_functions").collect())
      .filter((job) => job.state.kind === "pending")
      .filter((job) => (job.args[0] as { operation?: { kind?: string } })?.operation?.kind === "pruneIndex")
      .map((job) => (job.args[0] as { workspaceId: Id<"workspaces"> }).workspaceId),
  );
}

describe("the daily check", () => {
  test("runs through the barrier against a ready database", async () => {
    const { t, workspaceId, d1 } = await opted({ status: "ready" });
    // The census is the tree's names (`keyedCensus.test.ts`): the tree copies the notes first.
    await copyTree(t, workspaceId);
    await strandRow(d1.client, "0-inbox/search-freshness-probe.md");
    await strandRow(d1.client, "1-projects/note-0.md");

    const answer = await t.action(internal.functions.files.runFileOperation, {
      workspaceId,
      scope: "private",
      operation: { kind: "pruneIndex", passes: 1 },
    });

    expect(answer).toEqual({ kind: "indexPruned", deleted: 1, checked: true });
    // The stranded probe goes, and the tree's notes the database lacked are copied in.
    expect(d1.paths()).toEqual(["1-projects/note-0.md", "1-projects/note-1.md", "1-projects/note-2.md", "index.md"]);
  });

  test("leaves a database that is still copying to the copy", async () => {
    const { t, workspaceId, d1 } = await opted({ status: "backfilling" });
    await strandRow(d1.client, "0-inbox/search-freshness-probe.md");

    const answer = await t.action(internal.functions.files.runFileOperation, {
      workspaceId,
      scope: "private",
      operation: { kind: "pruneIndex", passes: 1 },
    });

    expect(answer).toEqual({ kind: "indexPruned", deleted: 0, checked: false });
    expect(d1.paths()).toEqual(["0-inbox/search-freshness-probe.md"]);
  });

  test("is scheduled once a day for each ready database", async () => {
    const { t, workspaceId } = await opted({ status: "ready" });

    await t.mutation(internal.functions.fastSearch.sweepStalledBackfills, {});
    expect(await prunesQueued(t)).toEqual([workspaceId]);
    const checkedAt = (await row(t, workspaceId))?.prunedAt;
    expect(typeof checkedAt).toBe("number");

    // Fifteen minutes later the sweep runs again and starts nothing new.
    await t.mutation(internal.functions.fastSearch.sweepStalledBackfills, {});
    expect(await prunesQueued(t)).toEqual([workspaceId]);

    // A day on, it is due again.
    await t.run(async (ctx) => {
      const index = await ctx.db
        .query("searchIndexes")
        .withIndex("by_workspace", (q) => q.eq("workspaceId", workspaceId))
        .unique();
      await ctx.db.patch(index!._id, { prunedAt: checkedAt! - 24 * 60 * 60 * 1_000 - 1 });
    });
    await t.mutation(internal.functions.fastSearch.sweepStalledBackfills, {});
    expect(await prunesQueued(t)).toEqual([workspaceId, workspaceId]);
  });

  test("is not scheduled for a database still copying", async () => {
    const { t } = await opted({ status: "backfilling" });
    await t.mutation(internal.functions.fastSearch.sweepStalledBackfills, {});
    expect(await prunesQueued(t)).toEqual([]);
  });
});
