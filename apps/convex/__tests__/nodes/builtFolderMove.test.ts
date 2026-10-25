/**
 * A folder move on built paths is one row change, whatever the folder holds (`lib/nodes/builtMove.ts`;
 * `paths-on-read.md`, "A folder move is one row change"). A folder of more than `ROW_MOVE_MAX` rows is not
 * read at all: its root takes its new parent and name, the caller judges what is beneath it from the rules,
 * its links follow in the background a page at a time, and devices walk.
 *
 * Sabotage, each run as a temporary local edit and reverted, and each failing here:
 *  - drop `countFolderMove`: the feed count does not move ("touches no row beneath it");
 *  - drop `queueFolderLinks`: no link entry ("its links follow");
 *  - answer no hidden settings from `hidesBeneath`: a member moves a folder holding a private one.
 */

import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { internal } from "../../_generated/api";
import type { Doc } from "../../_generated/dataModel";
import { ROW_MOVE_MAX } from "../../functions/lib/nodes/rowMove";
import { FOLDER_LINK_PAGE } from "../../functions/lib/nodes/folderLinks";
import { nodeAt } from "../../functions/lib/nodes/paths";
import { OWNER, TEAM, start } from "./moveFixture.helpers";
import { restoreRowTrash, startRowTrash } from "../../functions/lib/nodes/rowTrash";
import { bigFolder, keyedFixture, liveAt, logOf, rowOf } from "./keyedFixture.helpers";
import { parentRows } from "./treeRows.helpers";

type Fixture = Awaited<ReturnType<typeof keyedFixture>>;

const FILES = ROW_MOVE_MAX + 10;
const FROM = "1-projects/big";
const TO = "3-resources/big";

beforeEach(() => {
  vi.stubEnv("CONTEXT_TREE_PATHS", "built");
});
afterEach(() => {
  vi.unstubAllEnvs();
});

async function bigTree(): Promise<Fixture> {
  const f = await keyedFixture();
  await bigFolder(f, FROM, FILES);
  await f.t.run(async (ctx) => await parentRows(ctx, f.ws));
  return f;
}

async function rowsBeneath(f: Fixture): Promise<Doc<"nodes">[]> {
  const root = await rowOf(f, FROM);
  return await f.t.run(async (ctx) =>
    (await ctx.db.query("nodes").withIndex("by_parent_name", (q) => q.eq("workspaceId", f.ws).eq("parentId", root._id)).collect()),
  );
}

async function feedHead(f: Fixture): Promise<number> {
  return await f.t.run(async (ctx) => {
    const tree = await ctx.db.query("nodeTrees").withIndex("by_workspace", (q) => q.eq("workspaceId", f.ws)).unique();
    return tree?.folderMoves ?? 0;
  });
}

async function linkEntries(f: Fixture): Promise<Doc<"linkRepairs">[]> {
  return await f.t.run(async (ctx) => await ctx.db.query("linkRepairs").withIndex("by_workspace", (q) => q.eq("workspaceId", f.ws)).collect());
}

describe("a folder too big to list moves as one row", { timeout: 120_000 }, () => {
  test("its root takes the new name and touches no row beneath it", async () => {
    const f = await bigTree();
    const root = await rowOf(f, FROM);
    const before = await rowsBeneath(f);
    const logBefore = await logOf(f);

    const moved = await start(f, FROM, TO);

    expect(moved).toMatchObject({ rowed: true, queued: 0 });
    const after = await f.t.run(async (ctx) => await Promise.all(before.map((row) => ctx.db.get(row._id))));
    expect(after).toEqual(before);
    expect((await rowOf(f, TO))._id).toBe(root._id);
    expect(await liveAt(f, FROM)).toBe(false);
    const note = await f.t.run(async (ctx) => await nodeAt(ctx.db, f.ws, `${TO}/n7.md`));
    expect(note?._id).toBe(before.find((row) => row.name === "n7.md")?._id);
    // Nothing is logged per file: devices walk instead.
    expect((await logOf(f)).slice(logBefore.length).filter((entry) => entry.path.includes("/big/"))).toEqual([]);
    expect(await feedHead(f)).toBe(1);
  });

  test("its links follow a page at a time, to wherever the folder is now", async () => {
    const f = await bigTree();
    await f.t.run(async (ctx) => {
      await ctx.db.insert("nodeLinks", { workspaceId: f.ws, source: `${FROM}/n0.md`, kind: "path", target: "1-projects/keep.md" });
    });
    await start(f, FROM, TO);
    const [folder] = await linkEntries(f);
    expect(folder).toMatchObject({ pairs: [], folder: { from: FROM } });

    const first = await f.t.mutation(internal.functions.linkRepairs.claim, { workspaceId: f.ws, now: Date.now() });
    expect(first?.pairs.length).toBeLessThanOrEqual(FOLDER_LINK_PAGE);
    expect(first?.pairs).toContainEqual({ from: `${FROM}/n0.md`, to: `${TO}/n0.md` });
    const sources = await f.t.run(async (ctx) => (await ctx.db.query("nodeLinks").collect()).map((link) => link.source));
    expect(sources).toContain(`${TO}/n0.md`);
    expect(sources).not.toContain(`${FROM}/n0.md`);
    await f.t.mutation(internal.functions.linkRepairs.finish, { id: first!.id });

    // Moved again before the rest of its links followed: the rest go straight to the newest name.
    await start(f, TO, "2-areas/big");
    const next = await f.t.mutation(internal.functions.linkRepairs.claim, { workspaceId: f.ws, now: Date.now() });
    expect(next?.pairs.length).toBeGreaterThan(0);
    expect(next?.pairs.every((pair) => pair.from.startsWith(`${FROM}/`) && pair.to.startsWith("2-areas/big/"))).toBe(true);
  });

  test("a member may move it when nothing beneath is hidden, and not when a private folder is", async () => {
    const f = await bigTree();
    // `1-projects` holds the big folder and the private `1-projects/secret`.
    await expect(start(f, "1-projects", "3-resources/projects", TEAM)).rejects.toMatchObject({ code: "CONFLICT" });
    expect(await liveAt(f, "1-projects/secret")).toBe(true);

    await start(f, FROM, TO, TEAM);
    expect(await liveAt(f, `${TO}/n3.md`)).toBe(true);
  });

  test("a gone folder kept at the name, with rows beneath it, keeps no setting to judge the moved one by", async () => {
    const f = await bigTree();
    const resources = await rowOf(f, "3-resources");
    const kept = await f.t.run(async (ctx) => {
      const id = await ctx.db.insert("nodes", {
        workspaceId: f.ws,
        path: TO,
        parentId: resources._id,
        name: "big",
        kind: "folder",
        observedAt: 1,
        goneAt: 1,
        access: { base: "team" },
      });
      await ctx.db.insert("nodes", { workspaceId: f.ws, path: `${TO}/old.md`, parentId: id, name: "old.md", kind: "file", observedAt: 1, goneAt: 1 });
      return id;
    });

    await start(f, FROM, TO);

    expect((await rowOf(f, TO)).goneAt).toBeUndefined();
    const tombstone = await f.t.run(async (ctx) => await ctx.db.get(kept));
    expect(tombstone).toMatchObject({ goneAt: 1 });
    expect(tombstone?.access).toBeUndefined();
  });

  test("a trash of it is one row too, and a restore brings it back", async () => {
    const f = await bigTree();
    const before = await rowsBeneath(f);
    const trashed = await startRowTrash(f.ctx, { workspaceId: f.ws, store: f.store, path: FROM, clearance: OWNER, now: Date.now() });
    expect(await liveAt(f, FROM)).toBe(false);
    expect(trashed.to).toMatch(/^\.context\/trash\//);
    const after = await f.t.run(async (ctx) => await Promise.all(before.map((row) => ctx.db.get(row._id))));
    expect(after).toEqual(before);
    // A trash leaves links where they were, for Restore.
    expect(await linkEntries(f)).toEqual([]);

    await restoreRowTrash(f.ctx, { workspaceId: f.ws, store: f.store, trash: trashed.to, path: FROM, now: Date.now() });
    expect(await liveAt(f, `${FROM}/n3.md`)).toBe(true);
  });
});
