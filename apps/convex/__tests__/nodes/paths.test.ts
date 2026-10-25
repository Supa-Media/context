/**
 * Paths built from parents (`functions/lib/nodes/paths.ts`; `paths-on-read.md`, stage 4): every row's built path
 * is the path it stores, every stored path finds its row, a move of the root alone moves everything under it, and a
 * broken chain has no path rather than a wrong one.
 *
 * Sabotage, each run as a temporary local edit and reverted, and each failing here:
 *  - drop the depth cap: a loop never answers;
 *  - accept a parent in another workspace: a row is named under somebody else's folder;
 *  - prefer the first row at a name over the live one: a path whose old row is gone finds the tombstone.
 */

import { describe, expect, test } from "vitest";
import type { Doc, Id } from "../../_generated/dataModel";
import { treePaths } from "../../functions/lib/nodes/paths";
import { keyedFixture, rowOf } from "./keyedFixture.helpers";
import type { Fixture } from "./moveFixture.helpers";

async function allRows(f: Fixture): Promise<Doc<"nodes">[]> {
  return await f.t.run(async (ctx) => await ctx.db.query("nodes").withIndex("by_workspace_path", (q) => q.eq("workspaceId", f.ws)).collect());
}

/** A folder or file row under `parent`, with its stored path spelled from the parent's. */
async function insert(f: Fixture, parent: Doc<"nodes"> | null, name: string, kind: "file" | "folder", goneAt?: number): Promise<Doc<"nodes">> {
  return await f.t.run(async (ctx) => {
    const id = await ctx.db.insert("nodes", {
      workspaceId: f.ws,
      path: parent === null ? name : `${parent.path}/${name}`,
      ...(parent === null ? {} : { parentId: parent._id }),
      name,
      kind,
      observedAt: 1,
      ...(goneAt === undefined ? {} : { goneAt }),
    });
    return (await ctx.db.get(id))!;
  });
}

describe("paths built from parents", () => {
  test("every row's built path is its stored path, and every stored path finds its row", async () => {
    const f = await keyedFixture();
    // Names that sort differently as paths than as segments, a marker, and a name with spaces and accents.
    const a = await insert(f, null, "a", "folder");
    await insert(f, null, "a-c", "file");
    await insert(f, a, "b.md", "file");
    await insert(f, a, "", "file");
    await insert(f, a, "Café notes.md", "file");

    const rows = await allRows(f);
    expect(rows.length).toBeGreaterThan(15);
    await f.t.run(async (ctx) => {
      const paths = treePaths(ctx.db, f.ws);
      for (const row of rows) {
        expect(await paths.pathOf(row)).toBe(row.path);
        expect((await paths.rowAt(row.path))?._id).toBe(row._id);
      }
      expect(await paths.rowAt("a/nothing.md")).toBeNull();
      expect(await paths.rowAt("a-c/x.md")).toBeNull();
      expect(await paths.rowAt("")).toBeNull();
    });
  });

  test("a folder's row moved alone carries everything under it", async () => {
    const f = await keyedFixture();
    const launch = await rowOf(f, "1-projects/launch");
    const resources = await rowOf(f, "3-resources");
    const deep = await rowOf(f, "1-projects/launch/sub/deep.md");
    await f.t.run(async (ctx) => {
      await ctx.db.patch(launch._id, { parentId: resources._id, name: "launched" });
    });

    await f.t.run(async (ctx) => {
      const paths = treePaths(ctx.db, f.ws);
      expect(await paths.pathOf((await ctx.db.get(deep._id))!)).toBe("3-resources/launched/sub/deep.md");
      expect((await paths.liveAt("3-resources/launched/sub/deep.md"))?._id).toBe(deep._id);
      expect(await paths.rowAt("1-projects/launch/sub/deep.md")).toBeNull();
    });
  });

  test("a live row is found at a name a gone one also holds", async () => {
    const f = await keyedFixture();
    const projects = await rowOf(f, "1-projects");
    await insert(f, projects as Doc<"nodes">, "old.md", "file", 5);
    const live = await insert(f, projects as Doc<"nodes">, "old.md", "file");
    await f.t.run(async (ctx) => {
      const paths = treePaths(ctx.db, f.ws);
      expect((await paths.rowAt("1-projects/old.md"))?._id).toBe(live._id);
    });
  });

  test("a loop, a missing parent and a parent in another workspace give no path", async () => {
    const f = await keyedFixture();
    const sub = await rowOf(f, "1-projects/launch/sub");
    const launch = await rowOf(f, "1-projects/launch");
    const deep = await rowOf(f, "1-projects/launch/sub/deep.md");
    const keep = await rowOf(f, "1-projects/keep.md");
    const other = await f.t.run(async (ctx) => {
      const ws = await ctx.db.insert("workspaces", {
        slug: "other",
        displayName: "Other",
        createdBy: (await ctx.db.query("users").first())!._id,
        kind: "shared",
        structureTemplate: "para",
        createdAt: 1,
        updatedAt: 1,
      });
      return await ctx.db.insert("nodes", { workspaceId: ws, path: "theirs", name: "theirs", kind: "folder", observedAt: 1 });
    });
    const gone = await f.t.run(async (ctx) => {
      const id = await ctx.db.insert("nodes", { workspaceId: f.ws, path: "x", name: "x", kind: "folder", observedAt: 1 });
      await ctx.db.delete(id);
      return id;
    });
    await f.t.run(async (ctx) => {
      await ctx.db.patch(launch._id, { parentId: sub._id });
      await ctx.db.patch(keep._id, { parentId: other as Id<"nodes"> });
    });
    const pic = await rowOf(f, "1-projects/launch/pic.png");
    await f.t.run(async (ctx) => {
      await ctx.db.patch(pic._id, { parentId: gone });
    });

    await f.t.run(async (ctx) => {
      const paths = treePaths(ctx.db, f.ws);
      expect(await paths.pathOf((await ctx.db.get(deep._id))!)).toBeNull();
      expect(await paths.pathOf((await ctx.db.get(keep._id))!)).toBeNull();
      expect(await paths.pathOf((await ctx.db.get(pic._id))!)).toBeNull();
    });
  });
});
