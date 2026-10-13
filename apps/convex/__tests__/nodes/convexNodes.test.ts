/**
 * The tree's Convex functions, run through convex-test against the real schema.
 *
 * The isolation cases matter most: one workspace's tree must never be listed,
 * counted, read or written through another workspace's id. Each of those
 * cases fails if the `workspaceId` scoping is removed from the index read it
 * depends on (`convexTable.ts`, `functions/nodes.ts`).
 */

import { describe, expect, test } from "vitest";
import { convexTest } from "convex-test";
import { ConvexError } from "convex/values";
import { internal } from "../../_generated/api";
import type { Id } from "../../_generated/dataModel";
import type { MutationCtx } from "../../_generated/server";
import schema from "../../schema";
import { modules } from "../../test.setup";
import { convexNodeTable } from "../../functions/lib/nodes/convexTable";

async function workspace(t: ReturnType<typeof convexTest>, slug: string): Promise<Id<"workspaces">> {
  return await t.run(async (ctx) => {
    const now = Date.now();
    const createdBy = await ctx.db.insert("users", { email: `${slug}@example.test`, emailVerificationTime: now } as never);
    return await ctx.db.insert("workspaces", {
      slug,
      displayName: `Workspace ${slug}`,
      createdBy,
      kind: "shared",
      structureTemplate: "para",
      createdAt: now,
      updatedAt: now,
    });
  });
}

const rowsOf = (result: { rows: { path: string }[] }) => result.rows.map((row) => row.path);

describe("nodes: observe and read back", () => {
  test("observed files come back from listLive in path order, folders excluded", async () => {
    const t = convexTest(schema, modules);
    const ws = await workspace(t, "alpha");
    await t.mutation(internal.functions.nodes.observe, {
      workspaceId: ws,
      at: 10,
      rows: [{ path: "1-projects/a.md", etag: "e1", size: 3, uploaded: 7 }, { path: "root.md", etag: "e2" }],
      gone: [],
      vanishedUnder: [],
    });

    const listed = await t.query(internal.functions.nodes.listLive, { workspaceId: ws, limit: 100 });
    expect(rowsOf(listed)).toEqual(["1-projects/a.md", "root.md"]);
    expect(listed.rows[0]).toMatchObject({ path: "1-projects/a.md", etag: "e1", size: 3, uploaded: 7 });
    expect(listed.cursor).toBeNull();
  });

  test("listLive pages by cursor and stops at the limit", async () => {
    const t = convexTest(schema, modules);
    const ws = await workspace(t, "paged");
    await t.mutation(internal.functions.nodes.observe, {
      workspaceId: ws,
      at: 10,
      rows: ["a.md", "b.md", "c.md"].map((path) => ({ path })),
      gone: [],
      vanishedUnder: [],
    });
    const first = await t.query(internal.functions.nodes.listLive, { workspaceId: ws, limit: 2 });
    expect(rowsOf(first)).toEqual(["a.md", "b.md"]);
    expect(first.cursor).toBe("b.md");
    const second = await t.query(internal.functions.nodes.listLive, { workspaceId: ws, after: first.cursor ?? undefined, limit: 2 });
    expect(rowsOf(second)).toEqual(["c.md"]);
    expect(second.cursor).toBeNull();
  });

  test("a sweep from begin to finish records the live file count", async () => {
    const t = convexTest(schema, modules);
    const ws = await workspace(t, "swept");
    const { startedAt } = await t.mutation(internal.functions.nodes.begin, { workspaceId: ws, at: 10 });
    await t.mutation(internal.functions.nodes.observe, {
      workspaceId: ws,
      at: 11,
      rows: [{ path: "d/x.md" }, { path: "y.md" }],
      gone: [],
      vanishedUnder: [],
    });
    await t.mutation(internal.functions.nodes.progress, { workspaceId: ws, cursor: "y.md", at: 12 });
    await t.mutation(internal.functions.nodes.prune, { workspaceId: ws, startedAt });
    const counted = await t.query(internal.functions.nodes.countLive, { workspaceId: ws });
    expect(counted).toEqual({ count: 2, cursor: null });
    await t.mutation(internal.functions.nodes.finish, { workspaceId: ws, at: 20, files: counted.count });

    expect(await t.query(internal.functions.nodes.state, { workspaceId: ws })).toMatchObject({
      status: "ready",
      sweptAt: 20,
      files: 2,
      dirty: false,
    });
  });

  test("observe refuses a batch over the row cap", async () => {
    const t = convexTest(schema, modules);
    const ws = await workspace(t, "big");
    const rows = Array.from({ length: 251 }, (_, index) => ({ path: `f${index}.md` }));
    await expect(
      t.mutation(internal.functions.nodes.observe, { workspaceId: ws, at: 1, rows, gone: [], vanishedUnder: [] }),
    ).rejects.toThrow(/TOO_MANY_ROWS/);
  });
});

describe("nodes: tenant isolation", () => {
  test("one workspace's rows, state, privacy and counts are never another's", async () => {
    const t = convexTest(schema, modules);
    const alpha = await workspace(t, "iso-a");
    const beta = await workspace(t, "iso-b");

    await t.mutation(internal.functions.nodes.observe, {
      workspaceId: beta,
      at: 10,
      rows: [{ path: "secret/beta.md", etag: "b" }],
      gone: [],
      vanishedUnder: [],
    });
    await t.mutation(internal.functions.nodes.begin, { workspaceId: beta, at: 10 });
    await t.mutation(internal.functions.nodes.savePrivacy, {
      workspaceId: beta,
      at: 10,
      mirror: { invalid: false, folders: [{ prefix: "secret/", visibility: "private" }], notes: [] },
    });

    const listed = await t.query(internal.functions.nodes.listLive, { workspaceId: alpha, limit: 100 });
    expect(listed.rows).toEqual([]);
    expect(await t.query(internal.functions.nodes.countLive, { workspaceId: alpha })).toEqual({ count: 0, cursor: null });
    expect(await t.query(internal.functions.nodes.state, { workspaceId: alpha })).toBeNull();
    expect(await t.query(internal.functions.nodes.privacy, { workspaceId: alpha })).toBeNull();

    // And the other way round: beta sees its own rows, and only them.
    expect(rowsOf(await t.query(internal.functions.nodes.listLive, { workspaceId: beta, limit: 100 }))).toEqual([
      "secret/beta.md",
    ]);
    expect(await t.query(internal.functions.nodes.privacy, { workspaceId: beta })).toMatchObject({ invalid: false });
  });

  test("a vanish scan in one workspace never tombstones another's files under the same prefix", async () => {
    const t = convexTest(schema, modules);
    const alpha = await workspace(t, "vanish-a");
    const beta = await workspace(t, "vanish-b");
    await t.mutation(internal.functions.nodes.observe, {
      workspaceId: beta,
      at: 10,
      rows: [{ path: "p/keep.md" }],
      gone: [],
      vanishedUnder: [],
    });
    await t.mutation(internal.functions.nodes.observe, {
      workspaceId: alpha,
      at: 20,
      rows: [],
      gone: [],
      vanishedUnder: ["p/"],
    });
    expect(rowsOf(await t.query(internal.functions.nodes.listLive, { workspaceId: beta, limit: 100 }))).toEqual([
      "p/keep.md",
    ]);
  });

  test("patch and remove refuse a row that belongs to another workspace", async () => {
    const t = convexTest(schema, modules);
    const alpha = await workspace(t, "cross-a");
    const beta = await workspace(t, "cross-b");
    await t.mutation(internal.functions.nodes.observe, {
      workspaceId: beta,
      at: 10,
      rows: [{ path: "b.md", etag: "v" }],
      gone: [],
      vanishedUnder: [],
    });
    const betaNode = await t.run(async (ctx) => {
      const doc = await ctx.db
        .query("nodes")
        .withIndex("by_workspace_path", (q) => q.eq("workspaceId", beta).eq("path", "b.md"))
        .unique();
      return doc?._id as string;
    });

    await t.run(async (ctx: MutationCtx) => {
      const table = convexNodeTable(ctx, alpha);
      await expect(table.patch(betaNode, { goneAt: 99 })).rejects.toThrow(/not in this workspace/);
      await expect(table.remove(betaNode)).rejects.toThrow(/not in this workspace/);
    });

    // The row is untouched by the refused writes.
    const after = await t.run(async (ctx) => await ctx.db.get(betaNode as Id<"nodes">));
    expect(after).toMatchObject({ path: "b.md", workspaceId: beta, observedAt: 10 });
    expect(after?.goneAt).toBeUndefined();
  });
});

describe("nodes: dirty, unsupported and failure bookkeeping", () => {
  test("dirty creates the row when absent and an unsupported store refuses to sweep", async () => {
    const t = convexTest(schema, modules);
    const ws = await workspace(t, "flags");
    await t.mutation(internal.functions.nodes.dirty, { workspaceId: ws });
    expect(await t.query(internal.functions.nodes.state, { workspaceId: ws })).toMatchObject({
      status: "empty",
      dirty: true,
      files: 0,
    });
    await t.mutation(internal.functions.nodes.unsupported, { workspaceId: ws });
    const error = await t
      .mutation(internal.functions.nodes.begin, { workspaceId: ws, at: 5 })
      .catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(ConvexError);
    expect((error as ConvexError<{ code: string }>).data).toMatchObject({ code: "UNSUPPORTED" });
  });

  test("saveParity keeps its result on the row across a later sweep", async () => {
    const t = convexTest(schema, modules);
    const ws = await workspace(t, "parity");
    await t.mutation(internal.functions.nodes.saveParity, {
      workspaceId: ws,
      parity: { checkedAt: 5, clearances: 2, mismatches: 0, privacyMatches: true },
    });
    await t.mutation(internal.functions.nodes.begin, { workspaceId: ws, at: 6 });
    const row = await t.run(async (ctx) =>
      await ctx.db
        .query("nodeTrees")
        .withIndex("by_workspace", (q) => q.eq("workspaceId", ws))
        .unique(),
    );
    expect(row?.parity).toEqual({ checkedAt: 5, clearances: 2, mismatches: 0, privacyMatches: true });
    expect(row?.status).toBe("filling");
  });
});
