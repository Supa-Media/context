/**
 * Convex written behind a workspace object's note write (`functions/objectRowsMirror.ts` `wrote`, the route
 * `POST /gateway/rows/mirror` in `functions/lib/gatewayRoutes/rowsMirror.ts`).
 *
 * Sabotage, confirmed to fail the outbox case: build `wrote` with the plain rowWatch `internalMutation` (which opens an
 * outbox entry for an object-home workspace), so the mirror bounces each change back to the object.
 */

import { describe, expect, test, vi } from "vitest";
import { getFunctionName } from "convex/server";
import { internal } from "../_generated/api";
import type { Id } from "../_generated/dataModel";
import type { ActionCtx } from "../_generated/server";
import { idKeyFor } from "../functions/lib/nodes/noteIds";
import { ensureCopyRow } from "../functions/lib/noteIds/state";
import { gatewayRowsMirrorHandler, ROWS_MIRROR_MAX_CHANGES } from "../functions/lib/gatewayRoutes/rowsMirror";
import { gatewayPost, TEST_GATEWAY_SECRET } from "./fixtures.helpers";
import { boundWorkspace, rowAt, tester, type T } from "./noteIds/noteIds.helpers";

const A = "0190a000-0000-7000-8000-00000000000a";
const B = "0190a000-0000-7000-8000-00000000000b";
const PLAIN = "1-projects/plain.md";
const COPY = "1-projects/copy.md";

/** The keyed workspace (the switch at keys, the flip begun), as `noteIdsKeyed.test.ts` sets one up. */
async function keyedWorkspace(t: T, ws: Id<"workspaces">) {
  await t.run(async (ctx) => {
    const layout = await ctx.db.query("noteIdLayout").first();
    if (layout === null) await ctx.db.insert("noteIdLayout", { paused: false, mode: "keys", updatedAt: 1, updatedBy: "test" });
    else await ctx.db.patch(layout._id, { mode: "keys" });
    const copies = await ensureCopyRow(ctx, ws);
    await ctx.db.patch(copies._id, { keyedAt: 1 });
  });
}

/** A live keyed note at `path`, adopted at its own id key (the gateway's first write for it). */
async function keyedNote(t: T, ws: Id<"workspaces">, path: string, noteId: string) {
  await keyedWorkspace(t, ws);
  const adopted = await t.mutation(internal.functions.noteIdsKeyed.adoptKeyed, {
    workspaceId: ws,
    path,
    noteId,
    key: idKeyFor(noteId, path),
    etag: "k1",
    at: 100,
  });
  expect(adopted).toEqual({ adopted: true });
}

/** Marks `ws` as an object-home workspace, as the flip does (after any setup writes, which are not the mirror's). */
async function objectHome(t: T, ws: Id<"workspaces">) {
  await t.run((ctx) => ctx.db.insert("workspaceObjectHomes", { workspaceId: ws, home: "object", since: 0 }));
}

const outbox = (t: T) => t.run((ctx) => ctx.db.query("workspaceObjectOutbox").collect());

const keyedRecord = (path: string, etag: string, at: number, extra: Record<string, unknown> = {}) => ({
  path,
  key: idKeyFor(A, path),
  etag,
  keyed: true,
  at,
  ...extra,
});

describe("objectRowsMirror.wrote, keyed", () => {
  test("takes the key's version, size and time like recordKeyed, and the object's clock", async () => {
    const t = tester();
    const ws = await boundWorkspace(t, "mirror-keyed");
    await keyedNote(t, ws, PLAIN, A);
    await objectHome(t, ws);
    const answer = await t.mutation(internal.functions.objectRowsMirror.wrote, {
      workspaceId: ws,
      objectAt: 250,
      record: keyedRecord(PLAIN, "k2", 300, { size: 40 }),
    });
    expect(answer).toEqual({ applied: true });
    expect(await rowAt(t, ws, PLAIN)).toMatchObject({ etag: "k2", size: 40, observedAt: 300, objectAt: 250, storageKey: idKeyFor(A, PLAIN) });
  });

  test("opens no outbox entry for an object-home workspace: the object already holds the change", async () => {
    const t = tester();
    const ws = await boundWorkspace(t, "mirror-no-outbox");
    await keyedNote(t, ws, PLAIN, A);
    await objectHome(t, ws);
    const before = (await outbox(t)).length;
    expect(await t.mutation(internal.functions.objectRowsMirror.wrote, { workspaceId: ws, objectAt: 250, record: keyedRecord(PLAIN, "k2", 300) })).toEqual({
      applied: true,
    });
    expect((await outbox(t)).length).toBe(before);
    expect(await outbox(t)).not.toContainEqual(expect.objectContaining({ workspaceId: ws }));
  });

  test("a keyed record with no time is refused, not thrown", async () => {
    const t = tester();
    const ws = await boundWorkspace(t, "mirror-no-time");
    await keyedNote(t, ws, PLAIN, A);
    const record = { path: PLAIN, key: idKeyFor(A, PLAIN), etag: "k2", keyed: true };
    expect(await t.mutation(internal.functions.objectRowsMirror.wrote, { workspaceId: ws, objectAt: 5, record })).toEqual({
      applied: false,
      reason: "bad_record",
    });
  });
});

describe("objectRowsMirror.wrote, clocks and missing rows", () => {
  test("objectAt never goes backwards: 200 then 100 stays 200", async () => {
    const t = tester();
    const ws = await boundWorkspace(t, "mirror-clock");
    await keyedNote(t, ws, PLAIN, A);
    expect(await t.mutation(internal.functions.objectRowsMirror.wrote, { workspaceId: ws, objectAt: 200, record: keyedRecord(PLAIN, "k2", 300) })).toEqual({
      applied: true,
    });
    expect(await t.mutation(internal.functions.objectRowsMirror.wrote, { workspaceId: ws, objectAt: 100, record: keyedRecord(PLAIN, "k3", 400) })).toEqual({
      applied: true,
    });
    expect(await rowAt(t, ws, PLAIN)).toMatchObject({ etag: "k3", objectAt: 200 });
  });

  test("a missing row answers applied false with a reason and throws nothing", async () => {
    const t = tester();
    const ws = await boundWorkspace(t, "mirror-missing");
    expect(await t.mutation(internal.functions.objectRowsMirror.wrote, { workspaceId: ws, objectAt: 1, record: keyedRecord("1-projects/none.md", "k2", 3) })).toEqual({
      applied: false,
      reason: "no_row",
    });
  });

  test("a keyed write to a key the row does not hold is refused, and its objectAt does not move", async () => {
    const t = tester();
    const ws = await boundWorkspace(t, "mirror-refused");
    await keyedNote(t, ws, PLAIN, A);
    const other = { ...keyedRecord(PLAIN, "k9", 300), key: idKeyFor(B, PLAIN) };
    expect(await t.mutation(internal.functions.objectRowsMirror.wrote, { workspaceId: ws, objectAt: 900, record: other })).toEqual({
      applied: false,
      reason: "refused",
    });
    expect(await rowAt(t, ws, PLAIN)).toMatchObject({ etag: "k1" });
    expect((await rowAt(t, ws, PLAIN))?.objectAt ?? 0).toBe(0);
  });

  test("an unkeyed copy takes the object's clock on its row", async () => {
    const t = tester();
    const ws = await boundWorkspace(t, "mirror-copy");
    const noteId = B;
    await t.run((ctx) => ctx.db.insert("nodes", { workspaceId: ws, path: COPY, name: "copy.md", kind: "file", etag: "e1", noteId, observedAt: 1 }));
    const answer = await t.mutation(internal.functions.objectRowsMirror.wrote, {
      workspaceId: ws,
      objectAt: 42,
      record: { path: COPY, key: idKeyFor(noteId, COPY), etag: "e1", keyed: false },
    });
    expect(answer).toEqual({ applied: true });
    expect(await rowAt(t, ws, COPY)).toMatchObject({ objectAt: 42, idCopy: { key: idKeyFor(noteId, COPY), etag: "e1" } });
  });
});

describe("POST /gateway/rows/mirror", () => {
  const route = (t: T, body: unknown, options?: { secret?: string | null }) => gatewayPost(t, "/gateway/rows/mirror", body, options);

  test("refuses a missing or wrong gateway secret", async () => {
    const t = tester();
    const ws = await boundWorkspace(t, "mirror-route-secret");
    const body = { workspaceId: ws, changes: [] };
    expect((await route(t, body, { secret: null })).status).toBe(401);
    expect((await route(t, body, { secret: `${TEST_GATEWAY_SECRET}-wrong` })).status).toBe(401);
  });

  test("a body that is not a batch is a 400", async () => {
    const t = tester();
    const ws = await boundWorkspace(t, "mirror-route-400");
    expect((await route(t, { workspaceId: "not valid!", changes: [] })).status).toBe(400);
    expect((await route(t, { workspaceId: ws })).status).toBe(400);
    expect((await route(t, { workspaceId: ws, changes: "nope" })).status).toBe(400);
    const tooMany = Array.from({ length: ROWS_MIRROR_MAX_CHANGES + 1 }, (_, i) => ({ seq: i, op: "wrote", record: {}, objectAt: 1 }));
    expect((await route(t, { workspaceId: ws, changes: tooMany })).status).toBe(400);
  });

  test("applies in order, skips an unknown op and a bad change, and keeps going", async () => {
    const t = tester();
    const ws = await boundWorkspace(t, "mirror-route-order");
    await keyedNote(t, ws, PLAIN, A);
    const response = await route(t, {
      workspaceId: ws,
      changes: [
        { seq: 1, op: "drop_table", record: {}, objectAt: 1 },
        { seq: 2, op: "wrote", objectAt: 10, record: keyedRecord(PLAIN, "k2", 300) },
        { seq: 3, op: "wrote", objectAt: 11, record: { path: PLAIN, keyed: "yes" } },
        { seq: 4, op: "wrote", objectAt: 12, record: keyedRecord("1-projects/none.md", "k2", 300) },
        { seq: 5, op: "wrote", objectAt: 13, record: keyedRecord(PLAIN, "k3", 400) },
      ],
    });
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      applied: [2, 5],
      skipped: [
        { seq: 1, reason: "unknown op" },
        { seq: 3, reason: "bad change" },
        { seq: 4, reason: "no_row" },
      ],
    });
    expect(await rowAt(t, ws, PLAIN)).toMatchObject({ etag: "k3", objectAt: 13 });
  });

  test("a transient failure stops the batch and says so; the rest is not attempted", async () => {
    const runs: string[] = [];
    let calls = 0;
    const ctx = {
      runMutation: vi.fn(async (ref: Parameters<typeof getFunctionName>[0]) => {
        runs.push(getFunctionName(ref));
        calls += 1;
        if (calls === 2) throw new Error("upstream reset");
        return { applied: true };
      }),
    } as unknown as ActionCtx;
    const request = {
      workspaceId: "ws-transient",
      changes: [1, 2, 3].map((seq) => ({ seq, op: "wrote", objectAt: seq, record: { path: "a.md", key: "k", etag: "e", keyed: false } })),
    };
    const response = await gatewayRowsMirrorHandler(ctx, request);
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ applied: [1], skipped: [], stopped: true });
    expect(calls).toBe(2);
    expect(runs.every((name) => name === "functions/objectRowsMirror:wrote")).toBe(true);
  });
});
