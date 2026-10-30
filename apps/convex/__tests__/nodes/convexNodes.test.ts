/**
 * The tree's Convex functions, run through convex-test against the real schema.
 *
 * The isolation cases matter most: one workspace's tree must never be listed,
 * read or written through another workspace's id. Each of those cases fails if
 * the `workspaceId` scoping is removed from the index read it depends on
 * (`convexTable.ts`, `functions/nodes.ts`).
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
import { seedTreeRows } from "../fixtures.helpers";
import { nodeAt as treeNodeAt } from "../../functions/lib/nodes/paths";

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

describe("nodes: read back", () => {
  test("rows come back from listLive in path order, folders excluded", async () => {
    const t = convexTest(schema, modules);
    const ws = await workspace(t, "alpha");
    await seedTreeRows(t, ws, [
      { path: "1-projects/a.md", etag: "e1", size: 3 },
      { path: "root.md", etag: "e2" },
    ]);

    const listed = await t.query(internal.functions.nodes.listLive, { workspaceId: ws, limit: 100 });
    expect(rowsOf(listed)).toEqual(["1-projects/a.md", "root.md"]);
    expect(listed.rows[0]).toMatchObject({ path: "1-projects/a.md", etag: "e1", size: 3 });
    expect(listed.cursor).toBeNull();
  });

  test("listLive pages by cursor and stops at the limit", async () => {
    const t = convexTest(schema, modules);
    const ws = await workspace(t, "paged");
    await seedTreeRows(t, ws, ["a.md", "b.md", "c.md"].map((path) => ({ path, etag: path })));

    const first = await t.query(internal.functions.nodes.listLive, { workspaceId: ws, limit: 2 });
    expect(rowsOf(first)).toEqual(["a.md", "b.md"]);
    expect(first.cursor).toBe("b.md");
    const second = await t.query(internal.functions.nodes.listLive, { workspaceId: ws, limit: 2, after: first.cursor ?? undefined });
    expect(rowsOf(second)).toEqual(["c.md"]);
    expect(second.cursor).toBeNull();
  });
});

describe("nodes: a folder's listing stays in the folder", () => {
  /**
   * A folder List read the rows after the folder's name to the page's cap,
   * through the rest of the tree, and dropped what lay outside: most of
   * `listLive`'s database reads (Convex invoice, owner 2026-10-30). With
   * `root`, the walk ends at the folder's last row. Sabotage: walk "" again
   * and the rows after `inbox/` come back.
   */
  test("root keeps the walk beneath one folder, and ends there", async () => {
    const t = convexTest(schema, modules);
    const ws = await workspace(t, "rooted");
    await seedTreeRows(t, ws, ["areas/x.md", "inbox/a.md", "inbox/sub/b.md", "projects/c.md", "z.md"].map((path) => ({ path, etag: path })));

    const inbox = await t.query(internal.functions.nodes.listLive, { workspaceId: ws, limit: 100, root: "inbox" });
    expect(rowsOf(inbox)).toEqual(["inbox/a.md", "inbox/sub/b.md"]);
    expect(inbox.cursor).toBeNull();
    const after = await t.query(internal.functions.nodes.listLive, { workspaceId: ws, limit: 100, root: "inbox", after: "inbox/a.md" });
    expect(rowsOf(after)).toEqual(["inbox/sub/b.md"]);
    const missing = await t.query(internal.functions.nodes.listLive, { workspaceId: ws, limit: 100, root: "nowhere" });
    expect(rowsOf(missing)).toEqual([]);
  });
});

describe("nodes: tenant isolation", () => {
  test("one workspace's rows, privacy and served marker are never another's", async () => {
    const t = convexTest(schema, modules);
    const alpha = await workspace(t, "iso-a");
    const beta = await workspace(t, "iso-b");

    await seedTreeRows(t, beta, [{ path: "secret/beta.md", etag: "b" }]);
    await translateMirror(t, beta, { invalid: false, folders: [{ prefix: "secret/", visibility: "private" }], notes: [] });

    const listed = await t.query(internal.functions.nodes.listLive, { workspaceId: alpha, limit: 100 });
    expect(listed.rows).toEqual([]);
    expect(await t.query(internal.functions.nodes.privacy, { workspaceId: alpha })).toBeNull();
    expect(await t.query(internal.functions.nodes.served, { workspaceId: alpha })).toBeNull();

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

  test("patch and remove refuse a row that belongs to another workspace", async () => {
    const t = convexTest(schema, modules);
    const alpha = await workspace(t, "cross-a");
    const beta = await workspace(t, "cross-b");
    await seedTreeRows(t, beta, [{ path: "b.md", etag: "v" }]);
    const betaNode = await t.run(async (ctx) => {
      const doc = await treeNodeAt(ctx.db, beta, "b.md");
      return doc?._id as string;
    });

    await t.run(async (ctx: MutationCtx) => {
      const table = convexNodeTable(ctx, alpha);
      await expect(table.patch(betaNode, { goneAt: 99 })).rejects.toThrow(/not in this workspace/);
      await expect(table.remove(betaNode)).rejects.toThrow(/not in this workspace/);
    });

    // The row is untouched by the refused writes.
    const after = await t.run(async (ctx) => await ctx.db.get(betaNode as Id<"nodes">));
    expect(after).toMatchObject({ path: "b.md", workspaceId: beta });
    expect(after?.goneAt).toBeUndefined();
  });
});
