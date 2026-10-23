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
import { internal } from "../../_generated/api";
import type { Id } from "../../_generated/dataModel";
import type { MutationCtx } from "../../_generated/server";
import schema from "../../schema";
import { modules } from "../../test.setup";
import { convexNodeTable } from "../../functions/lib/nodes/convexTable";
import { translateMirror } from "../seededRules.helpers";

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
    await translateMirror(t, beta, { invalid: false, folders: [{ prefix: "secret/", visibility: "private" }], notes: [] },);

    const listed = await t.query(internal.functions.nodes.listLive, { workspaceId: alpha, limit: 100 });
    expect(listed.rows).toEqual([]);
    expect(await t.query(internal.functions.nodes.countLive, { workspaceId: alpha })).toEqual({ count: 0, cursor: null });
    expect(await t.query(internal.functions.nodes.state, { workspaceId: alpha })).toBeNull();
    expect(await t.query(internal.functions.nodes.privacy, { workspaceId: alpha })).toBeNull();

    // And the other way round: beta sees its own rows, and only them.
    expect(rowsOf(await t.query(internal.functions.nodes.listLive, { workspaceId: beta, limit: 100 }))).toEqual([
      "secret/beta.md",
    ]);
    // Rules are the rows now: beta's version is the one its own `secret/` row makes, and alpha's is not it.
    // (No `nodePrivacy` mirror is kept in rows mode, so the mirror table is not what answers here.)
    const betaVersion = await t.query(internal.functions.nodesAccess.privacyEtagNow, { workspaceId: beta });
    expect(betaVersion).toMatch(/^rows:/);
    expect(betaVersion).not.toBe(await t.query(internal.functions.nodesAccess.privacyEtagNow, { workspaceId: alpha }));
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
  test("dirty creates the row when absent, and an unsupported store is tried again from the top", async () => {
    const t = convexTest(schema, modules);
    const ws = await workspace(t, "flags");
    await t.mutation(internal.functions.nodes.dirty, { workspaceId: ws });
    expect(await t.query(internal.functions.nodes.state, { workspaceId: ws })).toMatchObject({
      status: "empty",
      dirty: true,
      files: 0,
    });
    await t.mutation(internal.functions.nodes.unsupported, { workspaceId: ws });
    const unsupported = await t.query(internal.functions.nodes.state, { workspaceId: ws });
    expect(unsupported).toMatchObject({ status: "unsupported" });
    // Marked with when it was found unlistable, so the retry waits its day.
    expect(typeof unsupported?.leaseAt).toBe("number");
    expect(await t.mutation(internal.functions.nodes.begin, { workspaceId: ws, at: 5 })).toMatchObject({ cursor: "" });
    expect(await t.query(internal.functions.nodes.state, { workspaceId: ws })).toMatchObject({ status: "filling" });
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

describe("nodes: parity keeps being earned", () => {
  async function treeRow(t: ReturnType<typeof convexTest>, ws: Id<"workspaces">) {
    return await t.run(async (ctx: MutationCtx) =>
      await ctx.db.query("nodeTrees").withIndex("by_workspace", (q) => q.eq("workspaceId", ws)).unique(),
    );
  }
  async function parityJobs(t: ReturnType<typeof convexTest>) {
    return await t.run(async (ctx) =>
      (await ctx.db.system.query("_scheduled_functions").collect()).filter(
        (job) => (job.args[0] as { operation?: { kind?: string } })?.operation?.kind === "nodesParity",
      ),
    );
  }
  async function sweepAt(t: ReturnType<typeof convexTest>, ws: Id<"workspaces">, at: number) {
    await t.mutation(internal.functions.nodes.begin, { workspaceId: ws, at });
    await t.mutation(internal.functions.nodes.finish, { workspaceId: ws, at: at + 1, files: 0 });
  }

  test("a finished sweep checks a tree whose proof is fresh only when it is a day old", async () => {
    const t = convexTest(schema, modules);
    const ws = await workspace(t, "fresh");
    const day = 24 * 60 * 60_000;
    await t.mutation(internal.functions.nodes.saveParity, {
      workspaceId: ws,
      parity: { checkedAt: 1_000, clearances: 2, mismatches: 0, privacyMatches: true },
    });
    await sweepAt(t, ws, 2_000);
    expect(await parityJobs(t)).toHaveLength(0);
    await sweepAt(t, ws, 1_000 + day);
    expect(await parityJobs(t)).toHaveLength(1);
  });

  test("a finished sweep checks again a tree whose last check differed", async () => {
    const t = convexTest(schema, modules);
    const ws = await workspace(t, "differed");
    await t.mutation(internal.functions.nodes.dirty, { workspaceId: ws });
    await t.mutation(internal.functions.nodes.saveParity, {
      workspaceId: ws,
      parity: { checkedAt: 1_000, clearances: 2, mismatches: 3, privacyMatches: true },
    });
    await sweepAt(t, ws, 2_000);
    expect(await parityJobs(t)).toHaveLength(1);
  });

  test("a newly differing check marks the tree dirty; one that already differed does not", async () => {
    const t = convexTest(schema, modules);
    const ws = await workspace(t, "flip");
    await sweepAt(t, ws, 1_000);
    await t.mutation(internal.functions.nodes.saveParity, {
      workspaceId: ws,
      parity: { checkedAt: 1_100, clearances: 2, mismatches: 0, privacyMatches: true },
    });
    expect((await treeRow(t, ws))?.dirty).toBe(false);
    await t.mutation(internal.functions.nodes.saveParity, {
      workspaceId: ws,
      parity: { checkedAt: 1_200, clearances: 2, mismatches: 1, privacyMatches: true },
    });
    const flipped = await treeRow(t, ws);
    expect(flipped?.dirty).toBe(true);
    expect(flipped?.parity?.mismatches).toBe(1);

    await t.run(async (ctx) => {
      await ctx.db.patch(flipped!._id, { dirty: false });
    });
    await t.mutation(internal.functions.nodes.saveParity, {
      workspaceId: ws,
      parity: { checkedAt: 1_300, clearances: 2, mismatches: 1, privacyMatches: true },
    });
    expect((await treeRow(t, ws))?.dirty).toBe(false);
  });
});
