/**
 * The control plane stops keeping notes' facts where the notes live in their workspace object
 * (`functions/nodeFactsDrop.ts`, `lib/nodes/factFill.ts`; `facts-in-objects.md`): a facts pass there drops the
 * copy instead of filling it, reads no note, and a workspace whose home goes back walks every note again.
 *
 * Sabotage (temporary local edits, reverted): dropping the home check in `runFactFill` → "a pass where the notes
 * live in the object drops the copy" fails (the copy stays and the notes are read again); leaving the fill's state
 * row behind → "a home that goes back" fails (the fill thinks it is caught up and reads nothing); dropping the home check
 * in `record` → "a fact pass's record that lands after the home went to object writes nothing" fails (the links and
 * props land after the copy was dropped).
 */

import { describe, expect, test } from "vitest";
import { internal } from "../../_generated/api";
import type { Id } from "../../_generated/dataModel";
import type { FileStore } from "../../functions/lib/fileOps";
import { runFactFill } from "../../functions/lib/nodes/factFill";
import { factsDue } from "../../functions/lib/nodes/facts";
import { DROP_PAGE } from "../../functions/nodeFactsDrop";
import { memoryStore, type MemoryStore } from "../storeStub.helpers";
import { drainScheduled, type TestConvex } from "../fixtures.helpers";
import { factCtx, fillAll, observeBucket, tester, workspace, type Tester } from "./facts.helpers";

type Bucket = MemoryStore & FileStore;

function bucket(): Bucket {
  const store = memoryStore() as Bucket;
  store.seed("1-projects/plan.md", "---\nstatus: active\n---\n# Plan\n\nSee [[notes]] and [the area](../2-areas/area.md).\n");
  store.seed("1-projects/notes.md", "# Notes\n\nBack to [[plan]].\n");
  store.seed("2-areas/area.md", `# Area\n\n${Array.from({ length: 1_200 }, (_, n) => `line ${n}`).join("\n")}\n`);
  return store;
}

async function setHome(t: Tester, workspaceId: Id<"workspaces">, home: "bucket" | "dual" | "object") {
  await t.run(async (ctx) => {
    const held = await ctx.db.query("workspaceObjectHomes").withIndex("by_workspace", (q) => q.eq("workspaceId", workspaceId)).unique();
    if (held === null) await ctx.db.insert("workspaceObjectHomes", { workspaceId, home, since: Date.now() });
    else await ctx.db.patch(held._id, { home, since: Date.now() });
  });
}

/** What the control plane keeps of the workspace's facts: link rows, rows with facts, and the fill's state. */
async function kept(t: Tester, workspaceId: Id<"workspaces">) {
  return await t.run(async (ctx) => {
    const links = (await ctx.db.query("nodeLinks").withIndex("by_workspace_source", (q) => q.eq("workspaceId", workspaceId)).collect()).length;
    const rows = await ctx.db.query("nodes").withIndex("by_workspace_path", (q) => q.eq("workspaceId", workspaceId)).collect();
    const facts = rows.filter((row) => row.parsed !== undefined || row.props !== undefined || row.sealed !== undefined || row.chaosNote !== undefined).length;
    const state = (await ctx.db.query("nodeFactState").withIndex("by_workspace", (q) => q.eq("workspaceId", workspaceId)).collect()).length;
    return { links, facts, state };
  });
}

function counting(store: Bucket): string[] {
  const reads: string[] = [];
  const get = store.get.bind(store);
  store.get = (async (key: string, ...rest: unknown[]) => {
    reads.push(key);
    return await (get as (...args: unknown[]) => Promise<unknown>)(key, ...rest);
  }) as never;
  return reads;
}

describe("the control plane's copy of facts where the notes live in their object", () => {
  test("a pass where the notes live in the object drops the copy, and reads no note", async () => {
    const t = tester();
    const ws = await workspace(t, "alpha");
    const store = bucket();
    await observeBucket(t, ws, store);
    await fillAll(t, ws, store);
    expect(await kept(t, ws)).toMatchObject({ links: 3, state: 1 });
    expect((await kept(t, ws)).facts).toBeGreaterThan(0);

    await setHome(t, ws, "object");
    const reads = counting(store);
    const { ctx } = factCtx(t);
    expect(await runFactFill(ctx, ws, store, 0)).toEqual({ kind: "nodesKept", complete: true });
    expect(await kept(t, ws)).toEqual({ links: 0, facts: 0, state: 0 });
    expect(reads).toEqual([]);
    // Another change's pass finds nothing left to drop and reads nothing.
    expect(await t.mutation(internal.functions.nodeFactsDrop.drop, { workspaceId: ws })).toEqual({ more: false, cursor: null, links: 0, notes: 0 });
  });

  test("a fact pass's record that lands after the home went to object writes nothing", async () => {
    const t = tester();
    const ws = await workspace(t, "eta");
    await observeBucket(t, ws, bucket());
    await setHome(t, ws, "object");
    const notes = [
      { path: "1-projects/plan.md", links: [["path", "2-areas/area.md"], ["name", "notes"]], props: JSON.stringify({ properties: { status: "active" } }) },
      { path: "1-projects/notes.md", gone: true, links: [], props: null },
    ];
    await t.mutation(internal.functions.nodeFacts.record, { workspaceId: ws, notes });
    expect(await kept(t, ws)).toEqual({ links: 0, facts: 0, state: 0 });
  });

  test("the same record on a bucket home writes the links and the props", async () => {
    const t = tester();
    const ws = await workspace(t, "theta");
    await observeBucket(t, ws, bucket());
    await setHome(t, ws, "bucket");
    const notes = [{ path: "1-projects/plan.md", links: [["path", "2-areas/area.md"], ["name", "notes"]], props: JSON.stringify({ properties: { status: "active" } }) }];
    await t.mutation(internal.functions.nodeFacts.record, { workspaceId: ws, notes });
    expect(await kept(t, ws)).toMatchObject({ links: 2, facts: 1 });
  });

  test("a large copy is dropped a page at a time, each page scheduling the next", async () => {
    const t = tester();
    const ws = await workspace(t, "beta");
    await observeBucket(t, ws, bucket());
    await t.run(async (ctx) => {
      await ctx.db.insert("nodeFactState", { workspaceId: ws, ready: true, seq: 0 });
      for (let n = 0; n < DROP_PAGE * 2 + 5; n += 1) await ctx.db.insert("nodeLinks", { workspaceId: ws, source: "1-projects/plan.md", kind: "name", target: `t${n}` });
    });
    await setHome(t, ws, "object");
    expect((await t.mutation(internal.functions.nodeFactsDrop.drop, { workspaceId: ws })).more).toBe(true);
    await drainScheduled(t as unknown as TestConvex);
    expect(await kept(t, ws)).toEqual({ links: 0, facts: 0, state: 0 });
  });

  test("a home that goes back to the bucket walks every note again", async () => {
    const t = tester();
    const ws = await workspace(t, "gamma");
    const store = bucket();
    await observeBucket(t, ws, store);
    await fillAll(t, ws, store);
    await setHome(t, ws, "object");
    await runFactFill(factCtx(t).ctx, ws, store, 0);
    expect(await kept(t, ws)).toEqual({ links: 0, facts: 0, state: 0 });

    await setHome(t, ws, "dual");
    await fillAll(t, ws, store);
    expect(await kept(t, ws)).toMatchObject({ links: 3, state: 1 });
  });

  test("another workspace's copy is left alone", async () => {
    const t = tester();
    const kept1 = await workspace(t, "kept");
    const gone = await workspace(t, "gone");
    for (const ws of [kept1, gone]) {
      const store = bucket();
      await observeBucket(t, ws, store);
      await fillAll(t, ws, store);
    }
    await setHome(t, gone, "object");
    await t.mutation(internal.functions.nodeFactsDrop.drop, { workspaceId: gone });
    expect(await kept(t, gone)).toEqual({ links: 0, facts: 0, state: 0 });
    expect(await kept(t, kept1)).toMatchObject({ links: 3, state: 1 });
  });

  test("the backstop starts a pass where the notes live in the object only while a copy is left to drop", async () => {
    const t = tester();
    const ws = await workspace(t, "delta");
    const store = bucket();
    await observeBucket(t, ws, store);
    await setHome(t, ws, "object");
    // Never filled: nothing to drop, so nothing is due (a bucket-home workspace would start its first fill).
    expect(await t.run(async (ctx) => await factsDue(ctx.db, ws, Date.now()))).toBe(false);
    await t.run(async (ctx) => {
      await ctx.db.insert("nodeFactState", { workspaceId: ws, ready: true, seq: 0 });
    });
    expect(await t.run(async (ctx) => await factsDue(ctx.db, ws, Date.now()))).toBe(true);
    await t.mutation(internal.functions.nodeFactsDrop.drop, { workspaceId: ws });
    expect(await t.run(async (ctx) => await factsDue(ctx.db, ws, Date.now()))).toBe(false);
  });
});
