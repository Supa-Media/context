/**
 * A new note the workspace object made, taken behind it (`functions/objectRowsMirror.ts` `adopt`, sent as op `adopt`
 * through `POST /gateway/rows/mirror`).
 *
 * Sabotage, confirmed to fail "keeps the object's id": drop the `objectId` patch, and the next push would hand the
 * object a second row at the path.
 */

import { describe, expect, test } from "vitest";
import { internal } from "../_generated/api";
import type { Id } from "../_generated/dataModel";
import type { ActionCtx } from "../_generated/server";
import { idKeyFor } from "../functions/lib/nodes/noteIds";
import { ensureCopyRow } from "../functions/lib/noteIds/state";
import { gatewayRowsMirrorHandler } from "../functions/lib/gatewayRoutes/rowsMirror";
import { boundWorkspace, rowAt, tester, type T } from "./noteIds/noteIds.helpers";

const A = "0190a000-0000-7000-8000-00000000000a";
const B = "0190a000-0000-7000-8000-00000000000b";
const PATH = "1-projects/new.md";
const OID = `o_${"a".repeat(32)}`;
const OTHER_OID = `o_${"b".repeat(32)}`;

async function keyedWorkspace(t: T, ws: Id<"workspaces">) {
  await t.run(async (ctx) => {
    const layout = await ctx.db.query("noteIdLayout").first();
    if (layout === null) await ctx.db.insert("noteIdLayout", { paused: false, mode: "keys", updatedAt: 1, updatedBy: "test" });
    else await ctx.db.patch(layout._id, { mode: "keys" });
    const copies = await ensureCopyRow(ctx, ws);
    await ctx.db.patch(copies._id, { keyedAt: 1 });
  });
}

async function objectHome(t: T, ws: Id<"workspaces">) {
  await t.run((ctx) => ctx.db.insert("workspaceObjectHomes", { workspaceId: ws, home: "object", since: 0 }));
}

const record = (noteId: string, objectId: string, extra: Record<string, unknown> = {}) => ({
  path: PATH,
  noteId,
  key: idKeyFor(noteId, PATH),
  etag: "e1",
  size: 12,
  at: 300,
  objectId,
  ...extra,
});

const outbox = (t: T) => t.run((ctx) => ctx.db.query("workspaceObjectOutbox").collect());

describe("objectRowsMirror.adopt", () => {
  test("gives the note its row, keeps the object's id and clock, and opens no outbox entry", async () => {
    const t = tester();
    const ws = await boundWorkspace(t, "adopt-new");
    await keyedWorkspace(t, ws);
    await objectHome(t, ws);
    const before = (await outbox(t)).length;
    expect(await t.mutation(internal.functions.objectRowsMirror.adopt, { workspaceId: ws, objectAt: 250, record: record(A, OID) })).toEqual({ applied: true });
    expect(await rowAt(t, ws, PATH)).toMatchObject({ noteId: A, storageKey: idKeyFor(A, PATH), etag: "e1", size: 12, objectId: OID, objectAt: 250 });
    expect((await outbox(t)).length).toBe(before);
  });

  test("sent again, the row the object's id names is the answer, and nothing is made twice", async () => {
    const t = tester();
    const ws = await boundWorkspace(t, "adopt-again");
    await keyedWorkspace(t, ws);
    await t.mutation(internal.functions.objectRowsMirror.adopt, { workspaceId: ws, objectAt: 250, record: record(A, OID) });
    expect(await t.mutation(internal.functions.objectRowsMirror.adopt, { workspaceId: ws, objectAt: 260, record: record(A, OID) })).toEqual({ applied: true });
    const rows = (await t.run((ctx) => ctx.db.query("nodes").collect())).filter((row) => row.workspaceId === ws && row.objectId === OID);
    expect(rows).toHaveLength(1);
    expect(rows[0]!.objectAt).toBe(260);
  });

  test("a name Convex holds for another note is taken: dropped, and the holder keeps its row", async () => {
    const t = tester();
    const ws = await boundWorkspace(t, "adopt-taken");
    await keyedWorkspace(t, ws);
    expect(await t.mutation(internal.functions.noteIdsKeyed.adoptKeyed, { workspaceId: ws, path: PATH, noteId: B, key: idKeyFor(B, PATH), etag: "b1", at: 100 })).toEqual({
      adopted: true,
    });
    expect(await t.mutation(internal.functions.objectRowsMirror.adopt, { workspaceId: ws, objectAt: 250, record: record(A, OID) })).toEqual({
      applied: false,
      reason: "taken",
    });
    const row = await rowAt(t, ws, PATH);
    expect(row).toMatchObject({ noteId: B });
    expect(row?.objectId).toBeUndefined();
  });

  test("an id that is not the object's shape, or a key that is not the note's, is refused", async () => {
    const t = tester();
    const ws = await boundWorkspace(t, "adopt-refused");
    await keyedWorkspace(t, ws);
    expect(await t.mutation(internal.functions.objectRowsMirror.adopt, { workspaceId: ws, objectAt: 1, record: record(A, "not-an-object-id") })).toEqual({
      applied: false,
      reason: "bad_record",
    });
    expect(await t.mutation(internal.functions.objectRowsMirror.adopt, { workspaceId: ws, objectAt: 1, record: record(A, OTHER_OID, { key: "notes/elsewhere.md" }) })).toEqual({
      applied: false,
      reason: "refused",
    });
    expect(await rowAt(t, ws, PATH)).toBeNull();
  });

  test("the route applies an adopt change by its op", async () => {
    const t = tester();
    const ws = await boundWorkspace(t, "adopt-route");
    await keyedWorkspace(t, ws);
    const mutate = t.mutation as (ref: unknown, args: unknown) => Promise<unknown>;
    const ctx = { runMutation: (ref: unknown, args: unknown) => mutate(ref, args) } as unknown as ActionCtx;
    const response = await gatewayRowsMirrorHandler(ctx, { workspaceId: ws, changes: [{ seq: 1, op: "adopt", objectAt: 9, record: record(A, OID) }] });
    expect(await response.json()).toEqual({ applied: [1], skipped: [] });
    expect(await rowAt(t, ws, PATH)).toMatchObject({ objectId: OID });
  });
});
