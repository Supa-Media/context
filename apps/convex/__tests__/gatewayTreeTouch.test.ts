/**
 * `POST /gateway/tree/touch`: the gateway names what a write touched, so the
 * Convex tree can re-check it.
 *
 * Malformed input is refused before anything is scheduled, and a well-formed
 * id that names no context gets the same `ok` as a real one, so the route is
 * not a way to learn which contexts exist. A `dirty` touch asks for a sweep
 * through the tree's own row (`nodeTrees.dirty`). A move's forwarding
 * addresses and icon moves are recorded in Convex (`smallData.ts`) before the
 * answer, and only for a context that exists.
 */

import { describe, expect, test } from "vitest";
import { internal } from "../_generated/api";
import type { Id } from "../_generated/dataModel";
import { createUser, createWorkspace, gatewayPost, setupTest } from "./fixtures.helpers";

const LONG = "x".repeat(1025);

async function owned() {
  const t = setupTest();
  const owner = await createUser(t, "owner@example.invalid");
  const workspaceId = (await createWorkspace(t, owner, "touch")) as Id<"workspaces">;
  return { t, workspaceId };
}

describe("POST /gateway/tree/touch", () => {
  test("a malformed body is refused with 400, whatever the workspace", async () => {
    const { t, workspaceId } = await owned();
    const bad = [
      {},
      { workspaceId, paths: "1-projects/a.md" },
      { workspaceId, paths: Array.from({ length: 51 }, (_, index) => `a${index}.md`) },
      { workspaceId, paths: [LONG] },
      { workspaceId, files: [42] },
      { workspaceId, paths: [], dirty: "yes" },
      { workspaceId, paths: ["a.md"], moves: "a.md" },
      { workspaceId, paths: ["a.md"], moves: [["a.md", "b.md"]] },
      { workspaceId, paths: ["a.md"], moves: [{ from: "a.md" }] },
      { workspaceId, paths: ["a.md"], moves: [{ from: "a.md", to: LONG }] },
      { workspaceId, paths: ["a.md"], moves: Array.from({ length: 51 }, (_, index) => ({ from: `a${index}`, to: `b${index}` })) },
    ];
    for (const body of bad) {
      const response = await gatewayPost(t, "/gateway/tree/touch", body);
      expect(response.status, JSON.stringify(body).slice(0, 80)).toBe(400);
    }
  });

  test("a valid touch is answered ok, and so is one that names no context", async () => {
    const { t, workspaceId } = await owned();
    const real = await gatewayPost(t, "/gateway/tree/touch", { workspaceId, paths: ["1-projects/a.md"], files: [] });
    expect(real.status).toBe(200);
    expect(await real.json()).toEqual({ ok: true });
    const moved = await gatewayPost(t, "/gateway/tree/touch", {
      workspaceId,
      paths: ["1-projects/a.md", "2-areas/a.md"],
      files: [],
      moves: [{ from: "1-projects/a.md", to: "2-areas/a.md" }],
    });
    expect(moved.status).toBe(200);

    // A well-formed id of a context that was deleted, answered as a real one is.
    const gone = (await createWorkspace(t, await createUser(t, "gone@example.invalid"), "gone")) as Id<"workspaces">;
    await t.run(async (ctx) => {
      await ctx.db.delete(gone);
    });
    const missing = await gatewayPost(t, "/gateway/tree/touch", { workspaceId: gone, paths: ["a.md"], files: [] });
    expect(missing.status).toBe(200);
    expect(await missing.json()).toEqual({ ok: true });
  });

  test("a dirty touch marks the workspace's tree dirty, so the next walk sweeps it", async () => {
    const { t, workspaceId } = await owned();
    const response = await gatewayPost(t, "/gateway/tree/touch", {
      workspaceId,
      paths: [],
      files: [],
      dirty: true,
    });
    expect(response.status).toBe(200);
    const row = await t.run(async (ctx) =>
      await ctx.db
        .query("nodeTrees")
        .withIndex("by_workspace", (q) => q.eq("workspaceId", workspaceId))
        .unique(),
    );
    expect(row?.dirty).toBe(true);
  });
});

describe("POST /gateway/tree/touch: edited notes", () => {
  async function treeRow(t: Awaited<ReturnType<typeof owned>>["t"], workspaceId: Id<"workspaces">) {
    return await t.run(async (ctx) =>
      await ctx.db
        .query("nodeTrees")
        .withIndex("by_workspace", (q) => q.eq("workspaceId", workspaceId))
        .unique(),
    );
  }
  async function editQueue(t: Awaited<ReturnType<typeof owned>>["t"], workspaceId: Id<"workspaces">) {
    return await t.run(async (ctx) =>
      await ctx.db
        .query("nodeTreeEdits")
        .withIndex("by_workspace", (q) => q.eq("workspaceId", workspaceId))
        .unique(),
    );
  }

  test("a malformed edited list is refused", async () => {
    const { t, workspaceId } = await owned();
    for (const edited of ["a.md", [42], [LONG], Array.from({ length: 51 }, (_, index) => `e${index}.md`)]) {
      const response = await gatewayPost(t, "/gateway/tree/touch", { workspaceId, paths: [], files: [], edited });
      expect(response.status).toBe(400);
    }
  });

  test("edits are gathered on their own row, never the tree's, with one flush scheduled for the burst", async () => {
    const { t, workspaceId } = await owned();
    await t.mutation(internal.functions.nodes.dirty, { workspaceId });
    await t.run(async (ctx) => {
      const row = await ctx.db.query("nodeTrees").withIndex("by_workspace", (q) => q.eq("workspaceId", workspaceId)).unique();
      await ctx.db.patch(row!._id, { status: "ready", dirty: false });
    });
    for (const edited of [["1-projects/a.md"], ["1-projects/b.md", "1-projects/a.md"], ["/1-projects/a.md/"]]) {
      const response = await gatewayPost(t, "/gateway/tree/touch", { workspaceId, paths: [], files: [], edited });
      expect(response.status).toBe(200);
    }
    const before = await treeRow(t, workspaceId);
    const queue = await editQueue(t, workspaceId);
    expect(queue?.edits.sort()).toEqual(["1-projects/a.md", "1-projects/b.md"]);
    expect(queue?.editsDueAt).toBeTypeOf("number");
    // The tree's row, read by every listing, was not written by the saves.
    expect(before?.edits).toBeUndefined();
    const flushes = await t.run(async (ctx) =>
      (await ctx.db.system.query("_scheduled_functions").collect()).filter((job) => job.name.includes("flushEdits")),
    );
    expect(flushes).toHaveLength(1);
  });

  test("the flush takes the edits off the row and schedules one re-check naming them", async () => {
    const { t, workspaceId } = await owned();
    await t.mutation(internal.functions.nodes.dirty, { workspaceId });
    await t.run(async (ctx) => {
      const row = await ctx.db.query("nodeTrees").withIndex("by_workspace", (q) => q.eq("workspaceId", workspaceId)).unique();
      await ctx.db.patch(row!._id, { status: "ready", dirty: false });
    });
    await t.mutation(internal.functions.nodes.queueEdits, { workspaceId, files: ["a.md", "b.md"] });
    await t.mutation(internal.functions.nodes.flushEdits, { workspaceId });
    expect(await editQueue(t, workspaceId)).toBeNull();
    const touches = await t.run(async (ctx) =>
      (await ctx.db.system.query("_scheduled_functions").collect()).filter((job) => job.name.includes("runFileOperation")),
    );
    expect(touches).toHaveLength(1);
    expect(touches[0]!.args[0]).toMatchObject({ workspaceId, operation: { kind: "nodesTouch", paths: [], files: ["a.md", "b.md"] } });
  });

  test("more than fifty gathered edits mark the tree dirty instead", async () => {
    const { t, workspaceId } = await owned();
    await t.mutation(internal.functions.nodes.dirty, { workspaceId });
    await t.run(async (ctx) => {
      const row = await ctx.db.query("nodeTrees").withIndex("by_workspace", (q) => q.eq("workspaceId", workspaceId)).unique();
      await ctx.db.patch(row!._id, { status: "ready", dirty: false });
    });
    await t.mutation(internal.functions.nodes.queueEdits, { workspaceId, files: Array.from({ length: 30 }, (_, i) => `a${i}.md`) });
    await t.mutation(internal.functions.nodes.queueEdits, { workspaceId, files: Array.from({ length: 30 }, (_, i) => `b${i}.md`) });
    const row = await treeRow(t, workspaceId);
    expect(row?.dirty).toBe(true);
    expect(await editQueue(t, workspaceId)).toBeNull();
  });

  test("a save writes nothing a folder listing reads, and an empty flush writes nothing at all", async () => {
    const { t, workspaceId } = await owned();
    await t.mutation(internal.functions.nodes.dirty, { workspaceId });
    await t.run(async (ctx) => {
      const row = await ctx.db.query("nodeTrees").withIndex("by_workspace", (q) => q.eq("workspaceId", workspaceId)).unique();
      await ctx.db.patch(row!._id, { status: "ready", dirty: false });
    });
    const before = await treeRow(t, workspaceId);
    await t.mutation(internal.functions.nodes.queueEdits, { workspaceId, files: ["a.md"] });
    await t.mutation(internal.functions.nodes.queueEdits, { workspaceId, files: ["b.md"] });
    await t.mutation(internal.functions.nodes.flushEdits, { workspaceId });
    await t.mutation(internal.functions.nodes.flushEdits, { workspaceId });
    expect(await treeRow(t, workspaceId)).toEqual(before);
  });

  test("edits a tree row held from before their own row are flushed once", async () => {
    const { t, workspaceId } = await owned();
    await t.mutation(internal.functions.nodes.dirty, { workspaceId });
    await t.run(async (ctx) => {
      const row = await ctx.db.query("nodeTrees").withIndex("by_workspace", (q) => q.eq("workspaceId", workspaceId)).unique();
      await ctx.db.patch(row!._id, { status: "ready", dirty: false, edits: ["old.md"], editsDueAt: Date.now() });
    });
    await t.mutation(internal.functions.nodes.queueEdits, { workspaceId, files: ["new.md"] });
    await t.mutation(internal.functions.nodes.flushEdits, { workspaceId });
    const row = await treeRow(t, workspaceId);
    expect(row?.edits).toBeUndefined();
    expect(row?.editsDueAt).toBeUndefined();
    const touches = await t.run(async (ctx) =>
      (await ctx.db.system.query("_scheduled_functions").collect()).filter((job) => job.name.includes("runFileOperation")),
    );
    expect(touches).toHaveLength(1);
    expect((touches[0]!.args[0] as { operation: { files: string[] } }).operation.files.sort()).toEqual(["new.md", "old.md"]);
  });

  test("a tree never swept gathers nothing: its first sweep lists the notes", async () => {
    const { t, workspaceId } = await owned();
    await t.mutation(internal.functions.nodes.queueEdits, { workspaceId, files: ["a.md"] });
    expect(await treeRow(t, workspaceId)).toBeNull();
  });
});

describe("POST /gateway/tree/touch: forwarding and icons", () => {
  test("malformed ones are refused, and nothing is recorded", async () => {
    const { t, workspaceId } = await owned();
    const bad = [
      { workspaceId, forwarding: "a.md" },
      { workspaceId, forwarding: [{ from: "a.md", to: "b.md" }] },
      { workspaceId, forwarding: [{ from: "a.md", to: "b.md", kind: "file" }] },
      { workspaceId, forwarding: [{ from: "a.md", to: LONG, kind: "note" }] },
      { workspaceId, forwarding: Array.from({ length: 101 }, (_, n) => ({ from: `a${n}.md`, to: `b${n}.md`, kind: "note" })) },
      { workspaceId, icons: [{ from: "a" }] },
    ];
    for (const body of bad) {
      const response = await gatewayPost(t, "/gateway/tree/touch", body);
      expect(response.status, JSON.stringify(body).slice(0, 80)).toBe(400);
    }
    expect(await t.query(internal.functions.smallData.ledger, { workspaceId })).toEqual([]);
  });

  test("a move's forwarding and icons are recorded before the answer, and a gone context records nothing", async () => {
    const { t, workspaceId } = await owned();
    await t.mutation(internal.functions.smallData.setIcon, { workspaceId, path: "1-projects/q3", icon: "📦" });
    const response = await gatewayPost(t, "/gateway/tree/touch", {
      workspaceId,
      forwarding: [{ from: "1-projects/q3", to: "4-archive/q3", kind: "folder" }],
      icons: [{ from: "1-projects/q3", to: "4-archive/q3" }],
    });
    expect(response.status).toBe(200);
    const ledger = await t.query(internal.functions.smallData.ledger, { workspaceId });
    expect(ledger.map(({ from, to, kind }) => ({ from, to, kind }))).toEqual([{ from: "1-projects/q3", to: "4-archive/q3", kind: "folder" }]);
    expect(await t.query(internal.functions.smallData.icons, { workspaceId })).toEqual([{ path: "4-archive/q3", icon: "📦" }]);

    const gone = (await createWorkspace(t, await createUser(t, "gone2@example.invalid"), "gone-two")) as Id<"workspaces">;
    await t.run(async (ctx) => ctx.db.delete(gone));
    const missing = await gatewayPost(t, "/gateway/tree/touch", {
      workspaceId: gone,
      forwarding: [{ from: "a.md", to: "b.md", kind: "note" }],
    });
    expect(await missing.json()).toEqual({ ok: true });
    expect(await t.run(async (ctx) => (await ctx.db.query("forwardingEntries").collect()).filter((row) => row.workspaceId === gone))).toEqual([]);
  });
});
