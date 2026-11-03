/**
 * Writes that may narrow tell the workspace's object first (`functions/lib/rowWatch/objectFirst.ts`): a mark is
 * opened in the object before Convex takes the change, so the object knows it is behind without anybody asking
 * Convex, and never serves a share somebody just took back (`apps/mcp/src/workspaceStore/marks.js`).
 *
 * Sabotage, each confirmed to fail a case here: open the mark after the mutation (the object is asked while the
 * change has already committed), close the mark when the push failed (the object serves the old share with no
 * behind), let the write go on when the object refused the mark (Convex changes, the object never heard), and drop
 * the unmarked record from the row watch (a writer that skipped the object goes unseen).
 */

import { afterEach, describe, expect, test, vi } from "vitest";
import { api, internal } from "../_generated/api";
import type { Id } from "../_generated/dataModel";
import { asUser, seedStorageBinding, seedTreeRows, type TestConvex } from "./fixtures.helpers";
import { drain, outbox, setFolder, setHome, world } from "./workspaceObjectWorld.helpers";

afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
});

const marks = (t: TestConvex) => t.run(async (ctx) => await ctx.db.query("workspaceObjectMarks").collect());
const unmarked = (t: TestConvex) => t.run(async (ctx) => await ctx.db.query("workspaceObjectUnmarked").collect());

/** A team folder with one note, judged in its object, the object caught up. */
async function teamFolderInObject() {
  const w = await world();
  const { t, owner, workspaceId } = w;
  await seedStorageBinding(t, { workspaceId, boundBy: owner, status: "connected" });
  await seedTreeRows(t, workspaceId, ["plans/a.md"]);
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

const takeBack = (t: TestConvex, owner: Id<"users">, workspaceId: Id<"workspaces">) =>
  asUser(t, owner).action(api.functions.nodesAccessFirst.setGrantees, { workspaceId, path: "plans", grantees: [], base: "private" });

describe("narrowing writes tell the object first", () => {
  test("the mark is open in the object before Convex takes the change, and closed once the object has it", async () => {
    const { t, owner, workspaceId, lookup, ops, onCall } = await teamFolderInObject();
    const before = ops().length;
    const atMarkOpen: { outbox: number; marks: number }[] = [];
    onCall(async (op) => {
      if (op === "ws.mark.open") atMarkOpen.push({ outbox: (await outbox(t, workspaceId)).length, marks: (await marks(t)).length });
    });
    expect(await takeBack(t, owner, workspaceId)).toMatchObject({ ok: true });
    // Asked of the object with nothing yet committed: no outbox entry, only the control plane's note of the mark.
    expect(atMarkOpen).toEqual([{ outbox: 0, marks: 1 }]);
    const order = ops().slice(before);
    expect(order.indexOf("ws.mark.open")).toBeLessThan(order.indexOf("ws.apply"));
    expect(order.indexOf("ws.apply")).toBeLessThan(order.lastIndexOf("ws.mark.close"));
    expect(await lookup("plans/a.md", "team")).toEqual({ path: "plans/a.md", found: false });
    expect(await marks(t)).toEqual([]);
    expect(await unmarked(t)).toEqual([]);
  });

  test("a share taken back whose push cannot land is never served from the object: it says behind until the push lands", { timeout: 60_000 }, async () => {
    const { t, owner, workspaceId, lookup, fail } = await teamFolderInObject();
    // The object takes the mark, then every push is refused: the change is in Convex and not in the object.
    fail(["ws.apply"]);
    expect(await takeBack(t, owner, workspaceId)).toMatchObject({ ok: true });
    const stale = await lookup("plans/a.md", "team");
    // The object's rows are still the old ones, and it says so: the gateway asks Convex (`objectLookup.js`).
    expect(stale).toMatchObject({ found: true, behind: true });
    expect((await marks(t)).map((mark) => mark.doneAt !== undefined)).toEqual([true]);
    // The marks report says the push is failing, and why, as a code: never a path.
    const failing = await t.query(internal.functions.workspaceObjectMarks.report, { since: 0 });
    expect(failing.outbox).toMatchObject({ workspaces: 1 });
    expect(failing.failing[0]).toMatchObject({ reason: "ws.apply: Error" });

    // The push lands, carrying the mark's close with its rows.
    fail([]);
    await drain(t, workspaceId);
    expect(await lookup("plans/a.md", "team")).toEqual({ path: "plans/a.md", found: false });
    expect(await marks(t)).toEqual([]);
    const landed = await t.query(internal.functions.workspaceObjectMarks.report, { since: 0 });
    expect(landed.outbox).toEqual({ entries: 0, workspaces: 0, oldestAgeMs: 0 });
    expect(landed.failing).toEqual([]);
  });

  test("if the object cannot be told, the change does not happen", async () => {
    const { t, owner, workspaceId, lookup, fail } = await teamFolderInObject();
    fail(["ws.mark.open"]);
    await expect(takeBack(t, owner, workspaceId)).rejects.toThrow();
    fail([]);
    expect(await outbox(t, workspaceId)).toEqual([]);
    expect(await marks(t)).toEqual([]);
    expect(await lookup("plans/a.md", "team")).toMatchObject({ found: true });
    expect(await asUser(t, owner).query(api.functions.nodesAccess.shareList, { workspaceId, path: "plans" })).toMatchObject({ base: "team" });
  });

  test("someone who does not own the workspace opens nothing in its object", async () => {
    const { t, workspaceId, ops } = await teamFolderInObject();
    const stranger = await t.run(async (ctx) => await ctx.db.insert("users", { email: "stranger@example.com" }));
    const before = ops().length;
    const answer = await asUser(t, stranger).action(api.functions.nodesAccessFirst.setGrantees, { workspaceId, path: "plans", grantees: [], base: "private" }).catch(() => null);
    expect(answer === null || answer.ok === false).toBe(true);
    expect(ops().slice(before)).not.toContain("ws.mark.open");
    expect(await marks(t)).toEqual([]);
  });

  test("a workspace still on the bucket opens no mark and never calls its object", async () => {
    const { t, owner, workspaceId, calls } = await world();
    await seedStorageBinding(t, { workspaceId, boundBy: owner, status: "connected" });
    await seedTreeRows(t, workspaceId, ["plans/a.md"]);
    await setFolder(t, workspaceId, owner, "plans", "team");
    expect(await takeBack(t, owner, workspaceId)).toMatchObject({ ok: true });
    expect(calls()).toBe(0);
    expect(await marks(t)).toEqual([]);
  });

  test("a narrowing that skipped the object is recorded with where its mutation lives, and reported", async () => {
    const { t, owner, workspaceId } = await teamFolderInObject();
    // The old app path: the public mutation, which cannot tell the object first.
    expect(await asUser(t, owner).mutation(api.functions.nodesAccess.setGrantees, { workspaceId, path: "plans", grantees: [], base: "private" })).toMatchObject({ ok: true });
    const recorded = await unmarked(t);
    expect(recorded).toHaveLength(1);
    expect(recorded[0].source).toMatch(/nodesAccess/);
    const report = await t.query(internal.functions.workspaceObjectMarks.report, { since: 0 });
    expect(report.unmarked).toBe(1);
    expect(report.bySource[0]).toMatchObject({ writes: 1, workspaces: 1 });
    // A write that only adds, or only changes bytes, is not a narrowing.
    await seedTreeRows(t, workspaceId, ["plans/b.md"]);
    expect(await unmarked(t)).toHaveLength(1);
  });
});
