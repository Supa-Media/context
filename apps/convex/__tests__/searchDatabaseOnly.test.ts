import { afterEach, describe, expect, test, vi } from "vitest";
import { api, internal } from "../_generated/api";
import { asUser, copyTree, drainScheduled } from "./fixtures.helpers";
import { cancelPendingJobs, opted, project, queued } from "./searchBackfill.trigger.helpers";

/**
 * A CONTEXT WITH A SEARCH DATABASE KEEPS NO INDEX IN ITS BUCKET.
 *
 * Decided by the owner, 2026-10-17 ("one call, max two to three"). The
 * database answers every search, its own scheduled copy fills it, and writes
 * keep it current. The bucket's shard index beside it was still maintained:
 * a console search over a filling database scheduled a chain of twelve
 * bucket-index passes, and every save re-indexed the note into shards nothing
 * read. Each pass lists the bucket and reads the changed notes.
 */

afterEach(async () => {
  await cancelPendingJobs();
  vi.unstubAllGlobals();
});

const shardWrites = (bucket: Awaited<ReturnType<typeof opted>>["bucket"]) =>
  [...bucket.objects.keys()].filter((key) => key.startsWith(".context/search/") && !key.startsWith(".context/search/meaning/"));

describe("a context with a search database", () => {
  test("a bucket-index pass does nothing, before any storage call", async () => {
    for (const status of ["backfilling", "ready"] as const) {
      const { t, workspaceId, bucket } = await opted({ status, notes: 3 });
      await copyTree(t, workspaceId);
      await drainScheduled(t);
      const before = bucket.requests.length;
      const pass = await t.action(internal.functions.files.runFileOperation, {
        workspaceId,
        scope: "private" as const,
        operation: { kind: "maintainIndex" as const, passes: 12 },
      });
      expect(pass).toMatchObject({ kind: "indexMaintained", changed: false, complete: true, pending: 0 });
      expect(bucket.requests.length).toBe(before);
      expect(shardWrites(bucket)).toEqual([]);
      // And the chain ends here rather than scheduling the next link.
      expect(await queued(t, "runFileOperation")).toHaveLength(0);
    }
  }, 60_000);

  test("a saved note is not re-indexed into the bucket", async () => {
    const { t, workspaceId, bucket } = await opted({ status: "ready", notes: 3 });
    await copyTree(t, workspaceId);
    await drainScheduled(t);
    const before = bucket.requests.length;
    const pass = await t.action(internal.functions.files.runFileOperation, {
      workspaceId,
      scope: "private" as const,
      operation: { kind: "indexNotes" as const, written: ["1-projects/note-0.md"], gone: [] },
    });
    expect(pass).toMatchObject({ kind: "indexMaintained", changed: false, complete: true });
    // Not even the index's manifest is asked for.
    expect(bucket.requests.slice(before).filter((request) => request.key.startsWith(".context/search/"))).toEqual([]);
    expect(shardWrites(bucket)).toEqual([]);
  }, 30_000);

  test("a copy whose listing fails runs no bucket-index pass in its place", async () => {
    // No tree copied, so the census cannot be listed: the link copies nothing and waits for the next.
    const { t, workspaceId, bucket, d1 } = await opted({ status: "backfilling", notes: 3 });
    const before = bucket.requests.length;
    await project(t, workspaceId);
    expect(bucket.requests.slice(before).filter((request) => request.key.startsWith(".context/search/"))).toEqual([]);
    expect(shardWrites(bucket)).toEqual([]);
    expect(d1.paths()).toEqual([]);
  }, 30_000);

  test("a console search over a filling database schedules no bucket-index pass", async () => {
    const { t, workspaceId, owner } = await opted({ status: "backfilling", notes: 3 });
    await copyTree(t, workspaceId);
    await drainScheduled(t);
    const found = await asUser(t, owner).action(api.functions.files.searchContext, { workspaceId, query: "quokkaplan" });
    expect(found.indexIncomplete).toBe(true);
    const passes = (await queued(t, "runFileOperation")).filter((job) => job.args[0]?.operation?.kind === "maintainIndex");
    expect(passes).toHaveLength(0);
  }, 30_000);
});
