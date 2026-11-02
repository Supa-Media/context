/**
 * The writers with no request behind them tell the workspace's object first too (`functions/lib/rowWatch/objectFirst.ts`),
 * so the gateway can stop asking the control plane, beside every object read, whether the object is behind.
 *
 * Production's report of narrowing writes that opened no mark (`workspaceObjectMarks.report`, 2026-11-02, 72 hours)
 * named three writers: the fact fill's `nodeFacts.record` (43 writes), `bugNotes.shareWithTeam` (3) and
 * `nodeRowMoves.rowMove` (3, a restore out of the trash). Here: a fact fill is not a narrowing at all; the trash's
 * erasure and a stalled move's watchdog page open a mark before their mutation commits; and a narrowing that still
 * skipped the object is held to "behind" by the push that carries it, even when that push fails.
 *
 * Sabotage, each confirmed to fail a case here: put `sealed` back among the fields that place a row (the fact fill is
 * recorded as unmarked), run the erasure's claims outside `objectFirst` (the rows are gone before the mark opens),
 * page the watchdog's move straight from the mutation again (the page is unmarked), and drop the drain's cover for
 * unmarked entries (the object serves the old share with no behind while the push fails).
 */

import { afterEach, describe, expect, test, vi } from "vitest";
import { api, internal } from "../_generated/api";
import type { Id } from "../_generated/dataModel";
import { asUser, drainScheduled, seedStorageBinding, seedTreeRows, type TestConvex } from "./fixtures.helpers";
import { drain, outbox, setFolder, setHome, world } from "./workspaceObjectWorld.helpers";

afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
});

const marks = (t: TestConvex) => t.run(async (ctx) => await ctx.db.query("workspaceObjectMarks").collect());
const unmarked = (t: TestConvex) => t.run(async (ctx) => await ctx.db.query("workspaceObjectUnmarked").collect());
const liveAt = (t: TestConvex, workspaceId: Id<"workspaces">, path: string) =>
  t.run(async (ctx) => {
    const rows = await ctx.db.query("nodes").withIndex("by_workspace_path", (q) => q.eq("workspaceId", workspaceId).eq("path", path)).collect();
    return rows.some((row) => row.goneAt === undefined);
  });

/** A team folder of notes (and whatever else `paths` adds), judged in its object, the object caught up. */
async function inObject(paths: string[] = []) {
  const w = await world();
  const { t, owner, workspaceId } = w;
  await seedStorageBinding(t, { workspaceId, boundBy: owner, status: "connected" });
  await seedTreeRows(t, workspaceId, ["plans/a.md", "plans/b.md", ...paths]);
  await setFolder(t, workspaceId, owner, "plans", "team");
  await setHome(t, workspaceId, "object");
  await t.run(async (ctx) => {
    const ids = (await ctx.db.query("nodes").withIndex("by_workspace_path", (q) => q.eq("workspaceId", workspaceId)).collect()).map((row) => row._id);
    await ctx.db.insert("workspaceObjectOutbox", { workspaceId, nodeIds: ids, access: true, at: Date.now() });
  });
  await drain(t, workspaceId);
  expect(await w.lookup("plans/a.md", "team")).toMatchObject({ found: true });
  return w;
}

describe("background writers tell the object first", () => {
  test("a fact fill that finds a sealed note narrows nothing, and is not recorded as unmarked", async () => {
    const { t, workspaceId } = await inObject();
    await t.mutation(internal.functions.nodeFacts.record, { workspaceId, notes: [{ path: "plans/a.md", links: [], props: null }] });
    const row = await t.run(async (ctx) => await ctx.db.query("nodes").withIndex("by_workspace_path", (q) => q.eq("workspaceId", workspaceId).eq("path", "plans/a.md")).first());
    expect(row?.sealed).toBe(true);
    expect(await unmarked(t)).toEqual([]);
  });

  test("emptying the trash opens a mark before its rows go, and closes it once the object has them", async () => {
    const trashed = ".context/trash/2026-09-01T05-00-00-000Z/plans/old.md";
    const { t, workspaceId, ops, onCall, lookup } = await inObject([trashed]);
    const atMarkOpen: boolean[] = [];
    onCall(async (op) => {
      if (op === "ws.mark.open") atMarkOpen.push(await liveAt(t, workspaceId, trashed));
    });
    const before = ops().length;
    await t.action(internal.functions.trashEmptying.eraseWorkspace, { workspaceId });
    // The mark went in while the row was still there: the object knew before the control plane changed.
    expect(atMarkOpen[0]).toBe(true);
    expect(await liveAt(t, workspaceId, trashed)).toBe(false);
    const order = ops().slice(before);
    expect(order.indexOf("ws.mark.open")).toBeLessThan(order.indexOf("ws.apply"));
    expect(await lookup(trashed, "private")).toMatchObject({ found: false });
    expect(await unmarked(t)).toEqual([]);
    expect(await marks(t)).toEqual([]);
  });

  test("a stalled move's watchdog pages with a mark open, never from the mutation alone", async () => {
    const { t, workspaceId, ops } = await inObject();
    // A chunked move of `plans` whose request died after moving the folder itself.
    const id = await t.run(async (ctx) => {
      const root = await ctx.db.query("nodes").withIndex("by_workspace_path", (q) => q.eq("workspaceId", workspaceId).eq("path", "plans")).first();
      await ctx.db.patch(root!._id, { path: "moved", name: "moved" });
      // Only a keyed file moves by its row.
      for (const name of ["a", "b"]) {
        const file = await ctx.db.query("nodes").withIndex("by_workspace_path", (q) => q.eq("workspaceId", workspaceId).eq("path", `plans/${name}.md`)).first();
        await ctx.db.patch(file!._id, { storageKey: `notes/${name}.md` });
      }
      return await ctx.db.insert("rowMoves", {
        workspaceId,
        from: "plans",
        to: "moved",
        trash: false,
        state: "moving",
        scope: "private",
        grantedNames: [],
        privacyEtag: null,
        pass: 1,
        moved: 1,
        left: 0,
        now: Date.now(),
        createdAt: Date.now(),
        updatedAt: 0,
      });
    });
    const before = ops().length;
    await t.mutation(internal.functions.nodeRowMoves.continueRowMove, { id });
    await drainScheduled(t);
    expect(await liveAt(t, workspaceId, "moved/a.md")).toBe(true);
    expect(ops().slice(before)).toContain("ws.mark.open");
    expect(await unmarked(t)).toEqual([]);
  });

  test("a narrowing that skipped the object still says behind while its push fails, and the push closes it", { timeout: 60_000 }, async () => {
    const { t, owner, workspaceId, lookup, fail } = await inObject();
    fail(["ws.apply"]);
    // The old app path: a public mutation, which cannot tell the object first.
    expect(await asUser(t, owner).mutation(api.functions.nodesAccess.setGrantees, { workspaceId, path: "plans", grantees: [], base: "private" })).toMatchObject({ ok: true });
    expect(await unmarked(t)).toHaveLength(1);
    await drain(t, workspaceId);
    expect(await lookup("plans/a.md", "team")).toMatchObject({ found: true, behind: true });

    // The cover's record says done; a later push closes it with the rows. The real retry comes 30 s later, well past
    // the clock margin a close waits for, so the test moves the record's clock back instead of waiting.
    expect((await marks(t)).map((mark) => mark.doneAt !== undefined)).toEqual([true]);
    await t.run(async (ctx) => {
      for (const mark of await ctx.db.query("workspaceObjectMarks").collect()) await ctx.db.patch(mark._id, { doneAt: 0 });
    });
    fail([]);
    await drain(t, workspaceId);
    expect(await outbox(t, workspaceId)).toEqual([]);
    expect(await lookup("plans/a.md", "team")).toEqual({ path: "plans/a.md", found: false });
    expect(await marks(t)).toEqual([]);
  });
});
