/**
 * A `ready` fast search database lets go of notes that are gone.
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
 */

import { afterEach, describe, expect, test, vi } from "vitest";
import { internal } from "../_generated/api";
import type { Id } from "../_generated/dataModel";
import type { ActionCtx } from "../_generated/server";
import { type FileStore, projectSearchIndex } from "../functions/lib/fileOps";
import { pruneSearchIndex } from "../functions/lib/fileOps/projection";
import { runPrunePass } from "../functions/lib/filesFns/prunePass";
import { PRIVACY_KEY } from "../functions/lib/privacy";
import { renderPrivacyManifest } from "../functions/lib/scaffold";
import { copyTree } from "./fixtures.helpers";
import { stubD1 } from "./searchBackfill.helpers";
import { cancelPendingJobs, opted, row } from "./searchBackfill.trigger.helpers";
import { memoryStore, type MemoryStore } from "./storeStub.helpers";
import type { TestConvex } from "./fixtures.helpers";

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
    const listedBefore = new Proxy(store, {
      get(target, key, receiver) {
        if (key !== "list") return Reflect.get(target, key, receiver);
        return async (options: unknown) => {
          const page = await target.list(options as never);
          return { ...page, objects: page.objects.filter((object: { key: string }) => object.key !== "1-projects/fresh.md") };
        };
      },
    });

    expect(await pruneSearchIndex(listedBefore, d1.client)).toEqual({ deleted: 0, checked: true });
    expect(d1.paths()).toContain("1-projects/fresh.md");
  });

  test("a listing that fails deletes nothing", async () => {
    const store = bucket();
    const d1 = await converged(store);
    await store.delete("0-inbox/probe.md");
    const refused = new Proxy(store, {
      get(target, key, receiver) {
        if (key !== "list") return Reflect.get(target, key, receiver);
        return async () => {
          throw new Error("listing refused");
        };
      },
    });

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
    expect(d1.paths()).toEqual(["1-projects/note-0.md"]);
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
