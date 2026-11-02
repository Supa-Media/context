/**
 * Row and access changes reach a workspace's object: every mutation is watched (`lib/rowWatch/`), and the push
 * (`workspaceObjectPush.ts`) carries them through the gateway's real door (`apps/mcp/src/workspaceStore/door.js`)
 * into a real workspace object (`apps/mcp/src/workspaceStore/serve.js`, on node:sqlite), which then judges reads.
 *
 * Sabotage, each confirmed to fail a case here: drop `flushRowChanges` from the wrapper (the object keeps judging
 * by the old rules), skip a home check (a bucket workspace gets entries), push without the rules (a narrowed
 * folder stays readable), push a folder's stored path instead of its built one (its notes stay at the old path).
 */

import { describe, expect, test, vi, afterEach } from "vitest";
import { api, internal } from "../_generated/api";
import type { MutationCtx } from "../_generated/server";
import { flushRowChanges } from "../functions/lib/rowWatch/mutations";
import { watchDb } from "../functions/lib/rowWatch/watch";
import { asUser, drainScheduled, seedStorageBinding, seedTreeRows } from "./fixtures.helpers";
import { drain, noteIdAt, outbox, setFolder, setHome, world } from "./workspaceObjectWorld.helpers";

afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
});

describe("row changes reach the workspace's object", () => {
  test("a workspace still on the bucket writes no outbox and never calls its object", async () => {
    const { t, owner, workspaceId, calls } = await world();
    await seedTreeRows(t, workspaceId, ["plans/a.md"]);
    await setFolder(t, workspaceId, owner, "plans", "private");
    expect(await outbox(t, workspaceId)).toEqual([]);
    expect(calls()).toBe(0);
  });

  test("a folder narrowed to private is refused to the team by the object once the push lands, and the outbox empties", async () => {
    const { t, owner, workspaceId, lookup } = await world();
    await seedTreeRows(t, workspaceId, ["plans/a.md"]);
    await setFolder(t, workspaceId, owner, "plans", "team");
    await setHome(t, workspaceId, "object");
    // Seed the object as the backfill would: everything up to now, team-visible.
    await t.run(async (ctx) => {
      const ids = (await ctx.db.query("nodes").withIndex("by_workspace_path", (q) => q.eq("workspaceId", workspaceId)).collect()).map((row) => row._id);
      await ctx.db.insert("workspaceObjectOutbox", { workspaceId, nodeIds: ids, access: true, at: Date.now() });
    });
    await drain(t, workspaceId);
    const noteId = await noteIdAt(t, workspaceId, "plans/a.md");
    expect(noteId).not.toBeNull();
    expect(await lookup("plans/a.md", "team")).toMatchObject({ found: true, path: "plans/a.md" });

    // The narrowing, through the real mutation: the wrapper alone tells the object.
    await setFolder(t, workspaceId, owner, "plans", "private");
    expect((await outbox(t, workspaceId)).length).toBe(1);
    await drain(t, workspaceId);
    expect(await outbox(t, workspaceId)).toEqual([]);
    expect(await lookup("plans/a.md", "team")).toMatchObject({ found: false });
    // The owner still sees it.
    expect(await lookup("plans/a.md", "private")).toMatchObject({ found: true });
    // The lease was let go with the last entry.
    expect(await t.run((ctx) => ctx.db.query("workspaceObjectPushLeases").collect())).toEqual([]);
  });

  test("a share taken back by the app's own mutation is never served from the object before its push lands", async () => {
    const { t, owner, workspaceId, lookup, hold } = await world();
    await seedStorageBinding(t, { workspaceId, boundBy: owner, status: "connected" });
    await seedTreeRows(t, workspaceId, ["plans/a.md"]);
    await setFolder(t, workspaceId, owner, "plans", "team");
    await setHome(t, workspaceId, "object");
    await t.run(async (ctx) => {
      const ids = (await ctx.db.query("nodes").withIndex("by_workspace_path", (q) => q.eq("workspaceId", workspaceId)).collect()).map((row) => row._id);
      await ctx.db.insert("workspaceObjectOutbox", { workspaceId, nodeIds: ids, access: true, at: Date.now() });
    });
    await drain(t, workspaceId);
    const binding = () => t.action(internal.functions.storage.getBindingForGateway, { workspaceId });
    expect(await binding()).not.toHaveProperty("notesBehind");

    // The app takes the folder back from the team through the public mutation, which cannot wait for the push; the
    // push is held off so the window between the commit and the push is pinned open rather than raced.
    hold(true);
    expect(await asUser(t, owner).mutation(api.functions.nodesAccess.setGrantees, { workspaceId, path: "plans", grantees: [], base: "private" })).toMatchObject({ ok: true });
    // The window: until the push lands, the object still holds the team's old rule…
    expect(await lookup("plans/a.md", "team")).toMatchObject({ found: true });
    // …so every binding opened now says so, and the gateway asks the control plane instead (`objectLookup.js`).
    expect(await binding()).toMatchObject({ notesHome: "object", notesBehind: true });

    // The push lands.
    hold(false);
    await drainScheduled(t);
    await drain(t, workspaceId);
    expect(await outbox(t, workspaceId)).toEqual([]);
    expect(await lookup("plans/a.md", "team")).toMatchObject({ found: false });
    expect(await binding()).not.toHaveProperty("notesBehind");
  });

  test("a team folder moved under a private one is judged at its new path, with its notes, once the push lands", async () => {
    // Production builds every path from parents (all workspaces flipped 2026-10-25): a move is one row.
    vi.stubEnv("CONTEXT_TREE_PATHS", "built");
    const { t, owner, workspaceId, lookup } = await world();
    await seedTreeRows(t, workspaceId, ["plans/a.md", "secret/b.md"]);
    await setFolder(t, workspaceId, owner, "plans", "team");
    await setFolder(t, workspaceId, owner, "secret", "private");
    await setHome(t, workspaceId, "object");
    await t.run(async (ctx) => {
      const ids = (await ctx.db.query("nodes").withIndex("by_workspace_path", (q) => q.eq("workspaceId", workspaceId)).collect()).map((row) => row._id);
      await ctx.db.insert("workspaceObjectOutbox", { workspaceId, nodeIds: ids, access: true, at: Date.now() });
    });
    await drain(t, workspaceId);
    expect(await lookup("plans/a.md", "team")).toMatchObject({ found: true });

    // The move is one row: the folder's parent. Nothing is written for the note under it.
    await t.run(async (ctx) => {
      const rows = await ctx.db.query("nodes").withIndex("by_workspace_path", (q) => q.eq("workspaceId", workspaceId)).collect();
      const plans = rows.find((row) => row.kind === "folder" && row.name === "plans")!;
      const secret = rows.find((row) => row.kind === "folder" && row.name === "secret")!;
      const watch = watchDb((ctx as MutationCtx).db);
      await watch.db.patch(plans._id, { parentId: secret._id });
      await flushRowChanges(ctx as MutationCtx, watch.changes);
    });
    await drain(t, workspaceId);
    expect(await lookup("plans/a.md", "team")).toMatchObject({ found: false });
    expect(await lookup("secret/plans/a.md", "team")).toMatchObject({ found: false });
    expect(await lookup("secret/plans/a.md", "private")).toMatchObject({ found: true, path: "secret/plans/a.md" });
  });

  test("a push that cannot reach the object keeps its entries and lets the workspace go", async () => {
    const { t, owner, workspaceId } = await world();
    await seedTreeRows(t, workspaceId, ["plans/a.md"]);
    await setHome(t, workspaceId, "object");
    await setFolder(t, workspaceId, owner, "plans", "private");
    vi.stubGlobal("fetch", async () => new Response("down", { status: 503 }));
    await drain(t, workspaceId);
    expect((await outbox(t, workspaceId)).length).toBe(1);
    expect(await t.run((ctx) => ctx.db.query("workspaceObjectPushLeases").collect())).toEqual([]);
  });

  test("a second drain while one holds the workspace does nothing", async () => {
    const { t, owner, workspaceId, calls } = await world();
    await seedTreeRows(t, workspaceId, ["plans/a.md"]);
    await setHome(t, workspaceId, "object");
    await setFolder(t, workspaceId, owner, "plans", "private");
    expect(await t.mutation(internal.functions.workspaceObjectPush.claim, { workspaceId, now: Date.now() })).toBe(true);
    await drain(t, workspaceId);
    expect(calls()).toBe(0);
    expect((await outbox(t, workspaceId)).length).toBe(1);
  });
});
