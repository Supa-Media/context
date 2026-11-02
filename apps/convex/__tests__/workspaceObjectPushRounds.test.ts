/**
 * A push round reads at most `ROUND_IDS` rows (`functions/workspaceObjectPush.ts` `pending`). Fifty entries of up to
 * `OUTBOX_MAX_IDS` rows each went over Convex's per-query read limit, so the round failed every time, the outbox never
 * drained, and every save in the workspace waited on it (production, 2026-11-02, "pending: Error: limit").
 *
 * Sabotage, each confirmed to fail a case here: take every waiting entry whatever it names (the round names all the
 * rows), or delete a trimmed entry on ack instead of keeping its rest (rows never reach the object).
 */

import { afterEach, describe, expect, test, vi } from "vitest";
import { internal } from "../_generated/api";
import type { Id } from "../_generated/dataModel";
import { ROUND_IDS } from "../functions/workspaceObjectPush";
import { seedTreeRows } from "./fixtures.helpers";
import { drain, outbox, setHome, world } from "./workspaceObjectWorld.helpers";

afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
});

describe("a push round's size", () => {
  test("entries naming more rows than a round reads are taken in parts, and every row still reaches the object", { timeout: 120_000 }, async () => {
    const { t, workspaceId, stores } = await world();
    const paths = Array.from({ length: ROUND_IDS + 300 }, (_, index) => `notes/n-${String(index).padStart(4, "0")}.md`);
    await seedTreeRows(t, workspaceId, paths);
    await setHome(t, workspaceId, "object");
    const ids = await t.run(async (ctx) =>
      (await ctx.db.query("nodes").withIndex("by_workspace_path", (q) => q.eq("workspaceId", workspaceId)).collect()).map((row) => row._id),
    );
    // One entry bigger than a round, then two small ones.
    const big = ids.slice(0, ROUND_IDS + 100);
    const rest = ids.slice(ROUND_IDS + 100);
    await t.run(async (ctx) => {
      await ctx.db.insert("workspaceObjectOutbox", { workspaceId, nodeIds: big, access: true, at: 1 });
      await ctx.db.insert("workspaceObjectOutbox", { workspaceId, nodeIds: rest.slice(0, 50), access: false, at: 2 });
      await ctx.db.insert("workspaceObjectOutbox", { workspaceId, nodeIds: rest.slice(50), access: false, at: 3 });
    });

    const first = await t.query(internal.functions.workspaceObjectPush.pending, { workspaceId });
    expect(first.rows.length + first.removed.length).toBe(ROUND_IDS);
    expect(first.entryIds).toEqual([]);
    expect(first.trim?.nodeIds).toHaveLength(ROUND_IDS);
    // A round that leaves entries behind closes no marks.
    expect(first.close).toEqual([]);

    await drain(t, workspaceId);
    expect(await outbox(t, workspaceId)).toEqual([]);
    const held = stores.get(`workspace:${workspaceId}`)!;
    const inObject = new Set((held.rows.get(ids.map(String)) as { id: string }[]).map((row) => row.id));
    for (const id of ids) expect(inObject.has(String(id as Id<"nodes">))).toBe(true);
  });

  test("small entries are taken together, up to the round's size", async () => {
    const { t, workspaceId } = await world();
    await seedTreeRows(t, workspaceId, ["a.md", "b.md", "c.md"]);
    await setHome(t, workspaceId, "object");
    const ids = await t.run(async (ctx) =>
      (await ctx.db.query("nodes").withIndex("by_workspace_path", (q) => q.eq("workspaceId", workspaceId)).collect()).map((row) => row._id),
    );
    await t.run(async (ctx) => {
      for (const [index, id] of ids.entries()) await ctx.db.insert("workspaceObjectOutbox", { workspaceId, nodeIds: [id], access: false, at: index + 1 });
    });
    const round = await t.query(internal.functions.workspaceObjectPush.pending, { workspaceId });
    expect(round.entryIds).toHaveLength(ids.length);
    expect(round.trim).toBeUndefined();
  });
});
