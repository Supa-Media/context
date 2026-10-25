/**
 * The stuck-rename report (`functions/folderNumbersDiagnose.ts`) is printed in a
 * public job log: it names built-in folders and counts, and never a note's or
 * an own folder's name.
 */

import { describe, expect, test } from "vitest";
import { internal } from "../../_generated/api";
import { keyedFixture, rowOf } from "./keyedFixture.helpers";
import { parentRows } from "./treeRows.helpers";

describe("the stuck-rename report", () => {
  test("a numbered folder left beside its plain twin is reported with what is under it", async () => {
    const f = await keyedFixture();
    const projects = await rowOf(f, "1-projects");
    await f.t.run(async (ctx) => {
      await ctx.db.insert("nodes", {
        workspaceId: f.ws,
        path: "projects",
        name: "projects",
        kind: "folder",
        observedAt: 1,
        role: "projects",
      } as never);
      await ctx.db.insert("nodes", {
        workspaceId: f.ws,
        path: "1-projects/secret-plan.md",
        name: "secret-plan.md",
        kind: "file",
        observedAt: 1,
        parentId: projects._id,
      } as never);
      for (const path of [
        "1-projects/Email/thread.md",
        "1-projects/Secret Folder/x.md",
      ]) {
        await ctx.db.insert("nodes", {
          workspaceId: f.ws,
          path,
          name: path.slice(path.lastIndexOf("/") + 1),
          kind: "file",
          observedAt: 1,
        } as never);
      }
      await parentRows(ctx, f.ws);
      await ctx.db.insert("rowMoves", {
        workspaceId: f.ws,
        from: "1-projects",
        to: "projects",
        trash: false,
        state: "moving",
        scope: "private",
        grantedNames: [],
        privacyEtag: "e",
        pass: 1,
        moved: 3,
        left: 1,
        now: 1,
        createdAt: 1,
        updatedAt: Date.now(),
      } as never);
      await ctx.db.insert("rowMoves", {
        workspaceId: f.ws,
        from: "my-own",
        to: "my-other",
        trash: false,
        state: "moving",
        scope: "private",
        grantedNames: [],
        privacyEtag: null,
        pass: 1,
        moved: 0,
        left: 0,
        now: 1,
        createdAt: 1,
        updatedAt: Date.now(),
      } as never);
    });

    const page = await f.t.query(
      internal.functions.folderNumbersDiagnose.page,
      {},
    );
    const text = JSON.stringify(page);
    expect(text).not.toContain("secret-plan");
    expect(text).not.toContain("my-own");
    expect(text).not.toContain("Secret Folder");
    expect(text).not.toContain("thread");
    const mine = page.workspaces[0];
    expect(mine.otherMoves).toBe(1);
    expect(mine.moves).toEqual([
      expect.objectContaining({
        from: "1-projects",
        to: "projects",
        state: "moving",
        left: 1,
        privacyEtag: true,
      }),
    ]);
    expect(mine.jobs).toContainEqual(
      expect.objectContaining({
        role: "projects",
        name: "1-projects",
        atRoot: true,
        gone: false,
      }),
    );
    expect(mine.plain).toContainEqual(
      expect.objectContaining({
        path: "projects",
        role: "projects",
        noParent: true,
      }),
    );
    expect(mine.numbered).toContainEqual(
      expect.objectContaining({
        name: "1-projects",
        plainTaken: true,
        plainRole: "projects",
        unkeyedFiles: 3,
      }),
    );
    type Numbered = {
      name: string;
      unkeyedWhere: { channel: string | null; ext: string; etag: boolean }[];
    };
    const where =
      (mine.numbered as Numbered[]).find((row) => row.name === "1-projects")
        ?.unkeyedWhere ?? [];
    expect(where.map((row) => row.channel).sort()).toEqual(
      ["email", "other", null].sort(),
    );
    expect(where.every((row) => row.ext === "md" && !row.etag)).toBe(true);
  });
});
