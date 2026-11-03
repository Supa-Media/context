/**
 * Every row's parent and name are its path (`functions/treeParents.ts`, `lib/nodes/parentCheck.ts`;
 * `paths-on-read.md`): the check sets a wrong parent or name right from the stored path, leaves what it cannot
 * set right counted, and is done only after a walk that set nothing right.
 *
 * Sabotage, each run as a temporary local edit and reverted, and each failing here:
 *  - mark a walk done whatever it repaired: a move during the walk could leave a row behind the position unchecked;
 *  - drop the duplicate check: a path two live rows hold is pointed at one of them as if it were right;
 *  - take any row at the folder's path as the parent, gone or not: an orphan is pointed at a tombstone;
 *  - let a page run under an old lease: two chains walk one workspace.
 *  - drop the cron's object check: the object workspace is scheduled at all
 *    → "a keyed workspace whose notes live in its object is not repaired by the cron" fails;
 *  - drop the page's object check: an object-home workspace's row is set right from the bucket's side
 *    → "checkWorkspace on an object-home workspace patches no nodes row" fails.
 */

import { describe, expect, test } from "vitest";
import { internal } from "../../_generated/api";
import type { Id } from "../../_generated/dataModel";
import { checkParents, folderOf } from "../../functions/lib/nodes/parentCheck";
import { PARENTS_LEASE_MS } from "../../functions/treeParents";
import { drainScheduled, type TestConvex } from "../fixtures.helpers";
import { keyedFixture, NOTE_ID, rowOf } from "./keyedFixture.helpers";
import type { Fixture } from "./moveFixture.helpers";
import { storedPathsOnly } from "./treeRows.helpers";

// Paged moves and the parent check that sets parents from stored paths exist only on stored paths.
storedPathsOnly();

async function stateOf(f: Fixture) {
  return await f.t.run(async (ctx) =>
    await ctx.db.query("treeParents").withIndex("by_workspace", (q) => q.eq("workspaceId", f.ws)).unique(),
  );
}

/** Every live row's path, built from its parents and names alone. */
async function builtPaths(f: Fixture): Promise<[string, string][]> {
  return await f.t.run(async (ctx) => {
    const rows = await ctx.db.query("nodes").withIndex("by_workspace_path", (q) => q.eq("workspaceId", f.ws)).collect();
    const built: [string, string][] = [];
    for (const row of rows) {
      if (row.goneAt !== undefined) continue;
      const names = [row.name];
      let at = row.parentId === undefined ? null : await ctx.db.get(row.parentId);
      while (at !== null) {
        names.unshift(at.name);
        at = at.parentId === undefined ? null : await ctx.db.get(at.parentId);
      }
      built.push([row.path, names.join("/")]);
    }
    return built;
  });
}

/** Home the workspace's notes in its object, as the switch does; the check must leave such a workspace alone. */
async function setObjectHome(f: Fixture) {
  await f.t.run(async (ctx) => {
    await ctx.db.insert("workspaceObjectHomes", { workspaceId: f.ws, home: "object", since: Date.now() });
  });
}

async function walk(f: Fixture, now: number) {
  await f.t.mutation(internal.functions.treeParents.checkWorkspace, { workspaceId: f.ws, now });
}

describe("every row says its path through its parents", () => {
  test("a wrong parent or name is set right, and the check is done only after a walk that set nothing right", async () => {
    const f = await keyedFixture();
    const deep = await rowOf(f, "1-projects/launch/sub/deep.md");
    const brief = await rowOf(f, "1-projects/launch/brief.md");
    const resources = await rowOf(f, "3-resources");
    await f.t.run(async (ctx) => {
      await ctx.db.patch(deep._id, { parentId: undefined });
      await ctx.db.patch(brief._id, { name: "old-brief.md", parentId: resources._id });
      // A top-level row pointing at a parent it does not have.
      await ctx.db.patch(resources._id, { parentId: brief._id });
    });

    await walk(f, 1_000);
    expect(await stateOf(f)).toMatchObject({ done: false, walks: 1, repairedNames: 1, repairedParents: 3, orphans: 0, duplicates: 0 });
    const built = await builtPaths(f);
    expect(built.length).toBeGreaterThan(10);
    for (const [path, fromParents] of built) expect(fromParents).toBe(path);

    await walk(f, 2_000);
    expect(await stateOf(f)).toMatchObject({ done: true, walks: 2, repairedParents: 3 });
    expect(await f.t.query(internal.functions.treeParents.report, {})).toMatchObject({
      keyedWorkspaces: 1,
      done: 1,
      repairedNames: 1,
      repairedParents: 3,
      orphans: 0,
      doneWithOrphans: 0,
    });
  });

  test("a row whose folder holds no live folder row, and a path two live rows hold, are counted and left", async () => {
    const f = await keyedFixture();
    const sub = await rowOf(f, "1-projects/launch/sub");
    const keep = await rowOf(f, "1-projects/keep.md");
    await f.t.run(async (ctx) => {
      // The folder row is a tombstone while its note is live.
      await ctx.db.patch(sub._id, { goneAt: 1 });
      const { _id, _creationTime, ...copy } = (await ctx.db.get(keep._id))!;
      void _id;
      void _creationTime;
      await ctx.db.insert("nodes", { ...copy, noteId: "0190a000-0000-7000-8000-00000000ffff" });
    });
    const deep = await rowOf(f, "1-projects/launch/sub/deep.md");

    await walk(f, 1_000);

    expect(await stateOf(f)).toMatchObject({ done: true, walks: 1, orphans: 1, duplicates: 1, repairedParents: 0 });
    expect((await rowOf(f, "1-projects/launch/sub/deep.md")).parentId).toBe(deep.parentId);
    expect(await f.t.query(internal.functions.treeParents.report, {})).toMatchObject({ done: 1, orphans: 1, duplicates: 1, doneWithOrphans: 1 });
  });

  test("a page resumes after the last path it reached", async () => {
    const f = await keyedFixture();
    const seen: string[] = [];
    let after: string | undefined;
    for (let pages = 0; pages < 50; pages += 1) {
      const page = await f.t.run(async (ctx) => await checkParents(ctx, f.ws, after, 2));
      expect(page.rows).toBeLessThanOrEqual(2);
      if (page.last === null) break;
      seen.push(page.last);
      after = page.last;
    }
    expect(seen).toEqual([...seen].sort());
    expect(new Set(seen).size).toBe(seen.length);
    expect(folderOf("a/")).toBe("a");
    expect(folderOf("a.md")).toBeNull();
  });

  test("a page handed a lease another chain has since taken stops", async () => {
    const f = await keyedFixture();
    const sub = (await rowOf(f, "1-projects/launch/sub")) as { _id: Id<"nodes"> };
    await walk(f, 1_000);
    await f.t.run(async (ctx) => {
      const state = (await ctx.db.query("treeParents").withIndex("by_workspace", (q) => q.eq("workspaceId", f.ws)).unique())!;
      await ctx.db.patch(state._id, { done: false, after: undefined, leaseAt: Date.now() });
      await ctx.db.patch(sub._id, { name: "wrong" });
    });

    await walk(f, 5);
    expect((await rowOf(f, "1-projects/launch/sub")).name).toBe("wrong");
    // Once that lease has run out, a page is taken over.
    await walk(f, Date.now() + PARENTS_LEASE_MS + 1);
    expect((await rowOf(f, "1-projects/launch/sub")).name).toBe("sub");
  });
  test("a keyed workspace whose notes live in its object is not repaired by the cron, while a bucket one in the same run is", async () => {
    const f = await keyedFixture();
    const deep = await rowOf(f, "1-projects/launch/sub/deep.md");
    await f.t.run(async (ctx) => {
      await ctx.db.patch(deep._id, { parentId: undefined });
    });
    await setObjectHome(f);

    // A second keyed workspace on the bucket, with one file whose parent is broken.
    const other = await f.t.run(async (ctx) => {
      const ws = await ctx.db.insert("workspaces", {
        slug: "bucketed",
        displayName: "Bucketed",
        createdBy: f.ownerId,
        kind: "shared",
        structureTemplate: "para",
        createdAt: 1,
        updatedAt: 1,
      });
      await ctx.db.insert("noteIdCopies", { workspaceId: ws, status: "done", runId: 1, files: 0, copied: 0, failed: 0, failures: [], updatedAt: 1, keyedAt: 1 });
      const folder = await ctx.db.insert("nodes", { workspaceId: ws, path: "b", name: "b", kind: "folder", observedAt: 1 });
      const file = await ctx.db.insert("nodes", {
        workspaceId: ws,
        path: "b/x.md",
        name: "x.md",
        kind: "file",
        observedAt: 1,
        noteId: NOTE_ID(900),
        storageKey: `notes/${NOTE_ID(900)}.md`,
      });
      return { ws, folder, file };
    });

    await f.t.mutation(internal.functions.treeParents.checkDue, {});
    // The cron schedules the bucket workspace and not the object one.
    const queued = await f.t.run(async (ctx) => await ctx.db.system.query("_scheduled_functions").collect());
    const queuedFor = (ws: Id<"workspaces">) => queued.filter((job) => JSON.stringify(job.args).includes(ws as string)).length;
    expect(queuedFor(f.ws)).toBe(0);
    expect(queuedFor(other.ws)).toBeGreaterThan(0);
    await drainScheduled(f.t as unknown as TestConvex);

    expect((await rowOf(f, "1-projects/launch/sub/deep.md")).parentId).toBeUndefined();
    expect(await stateOf(f)).toBeNull();
    const repaired = await f.t.run(async (ctx) => await ctx.db.get(other.file));
    expect(repaired?.parentId).toBe(other.folder);
    // It set a parent right, so its walk is not done until the next one.
    expect(await f.t.run(async (ctx) => await ctx.db.query("treeParents").withIndex("by_workspace", (q) => q.eq("workspaceId", other.ws)).unique())).toMatchObject({ done: false, repairedParents: 1 });
    // The report counts it apart, so the check is not read as waiting on a workspace it never walks.
    expect(await f.t.query(internal.functions.treeParents.report, {})).toMatchObject({ keyedWorkspaces: 2, inObject: 1, notStarted: 1 });
  });

  test("checkWorkspace on an object-home workspace patches no nodes row and leaves its state row as it was", async () => {
    const f = await keyedFixture();
    const deep = await rowOf(f, "1-projects/launch/sub/deep.md");
    await f.t.run(async (ctx) => {
      await ctx.db.patch(deep._id, { parentId: undefined, name: "wrong" });
    });
    await setObjectHome(f);
    // A chain scheduled before the switch holds the workspace, mid-walk.
    await f.t.run(async (ctx) => {
      await ctx.db.insert("treeParents", {
        workspaceId: f.ws,
        walks: 0,
        walkRepaired: 0,
        repairedNames: 0,
        repairedParents: 0,
        orphans: 0,
        duplicates: 0,
        walkOrphans: 0,
        walkHiddenOrphans: 0,
        walkDuplicates: 0,
        rows: 0,
        walkRows: 0,
        done: false,
        after: "1-projects/launch",
        leaseAt: 500,
        updatedAt: 500,
      });
    });
    const before = await stateOf(f);

    // The page is handed the lease it was scheduled under, so only the home decides what it does.
    await walk(f, 500);

    const after = await f.t.run(async (ctx) => await ctx.db.get(deep._id));
    expect(after?.parentId).toBeUndefined();
    expect(after?.name).toBe("wrong");
    expect(await stateOf(f)).toEqual(before);
  });
});
