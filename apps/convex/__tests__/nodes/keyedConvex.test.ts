/**
 * The keyed-workspace guards, run through convex-test against the real schema:
 * what "keyed" means (`keyedWorkspace`), that the bucket-side mutations honour
 * it (`nodes.observe`, `nodes.prune`), and that the table writes the new
 * columns (`convexNodeTable`). Each case fails if its guard is removed.
 */

import { describe, expect, test } from "vitest";
import { convexTest } from "convex-test";
import { internal } from "../../_generated/api";
import type { Id } from "../../_generated/dataModel";
import schema from "../../schema";
import { modules } from "../../test.setup";
import { convexNodeTable } from "../../functions/lib/nodes/convexTable";
import { keyedWorkspace } from "../../functions/lib/noteIds/keyedState";

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

/** Sets the switch to `mode` and the workspace's copy row to keyed (`keyedAt`) or not. */
async function setKeyedState(
  t: ReturnType<typeof convexTest>,
  ws: Id<"workspaces">,
  mode: "paths" | "ids" | "keys",
  keyedAt: number | undefined,
): Promise<void> {
  await t.run(async (ctx) => {
    const layout = await ctx.db.query("noteIdLayout").first();
    const fields = { mode, updatedAt: 1 };
    if (layout === null) await ctx.db.insert("noteIdLayout", { paused: false, ...fields });
    else await ctx.db.patch(layout._id, fields);
    await ctx.db.insert("noteIdCopies", {
      workspaceId: ws,
      status: "done",
      runId: 1,
      files: 0,
      copied: 0,
      failed: 0,
      failures: [],
      updatedAt: 1,
      ...(keyedAt === undefined ? {} : { keyedAt }),
    });
  });
}

describe("keyedWorkspace: what counts as keyed", () => {
  test("a workspace with no layout row and no copy row is not keyed", async () => {
    const t = convexTest(schema, modules);
    const ws = await workspace(t, "fresh");
    expect(await t.run((ctx) => keyedWorkspace(ctx.db, ws))).toBe(false);
  });

  test("keys mode without the copy's keyedAt is not keyed (the flip has not started)", async () => {
    const t = convexTest(schema, modules);
    const ws = await workspace(t, "keysonly");
    await setKeyedState(t, ws, "keys", undefined);
    expect(await t.run((ctx) => keyedWorkspace(ctx.db, ws))).toBe(false);
  });

  test("keyedAt makes a keyed workspace, and only that workspace", async () => {
    const t = convexTest(schema, modules);
    const ws = await workspace(t, "keyed");
    const other = await workspace(t, "other");
    await setKeyedState(t, ws, "keys", 5);
    expect(await t.run((ctx) => keyedWorkspace(ctx.db, ws))).toBe(true);
    expect(await t.run((ctx) => keyedWorkspace(ctx.db, other))).toBe(false);
  });
});

describe("nodes.observe honours a keyed workspace", () => {
  test("a bucket row with no row is adopted in a workspace that is not keyed", async () => {
    const t = convexTest(schema, modules);
    const ws = await workspace(t, "adopt");
    await t.mutation(internal.functions.nodes.observe, {
      workspaceId: ws,
      at: 10,
      rows: [{ path: "1-projects/a.md", etag: "e1" }],
      gone: [],
      vanishedUnder: [],
    });
    const listed = await t.query(internal.functions.nodes.listLive, { workspaceId: ws, limit: 100 });
    expect(listed.rows.map((row) => row.path)).toEqual(["1-projects/a.md"]);
  });

  test("the same row is not adopted in a keyed workspace", async () => {
    const t = convexTest(schema, modules);
    const ws = await workspace(t, "noadopt");
    await setKeyedState(t, ws, "keys", 5);
    await t.mutation(internal.functions.nodes.observe, {
      workspaceId: ws,
      at: 10,
      rows: [{ path: "1-projects/a.md", etag: "e1" }],
      gone: [],
      vanishedUnder: [],
    });
    const listed = await t.query(internal.functions.nodes.listLive, { workspaceId: ws, limit: 100 });
    expect(listed.rows).toEqual([]);
  });
});

async function scheduledCount(t: ReturnType<typeof convexTest>): Promise<number> {
  return await t.run(async (ctx) => (await ctx.db.system.query("_scheduled_functions").collect()).length);
}

describe("nodes.requestSweep and nodes.finish honour a keyed workspace", () => {
  test("a dirty mark starts a sweep in a workspace that is not keyed", async () => {
    const t = convexTest(schema, modules);
    const ws = await workspace(t, "dirty-plain");
    const before = await scheduledCount(t);
    await t.mutation(internal.functions.nodes.requestSweep, { workspaceId: ws });
    expect(await scheduledCount(t)).toBe(before + 1);
  });

  test("a dirty mark starts no sweep in a keyed workspace, which is never swept", async () => {
    const t = convexTest(schema, modules);
    const ws = await workspace(t, "dirty-keyed");
    await setKeyedState(t, ws, "keys", 5);
    const before = await scheduledCount(t);
    await t.mutation(internal.functions.nodes.requestSweep, { workspaceId: ws });
    expect(await scheduledCount(t)).toBe(before);
  });

  test("a finished sweep checks its tree against the bucket, unless the workspace is keyed", async () => {
    const t = convexTest(schema, modules);
    const plain = await workspace(t, "parity-plain");
    const keyed = await workspace(t, "parity-keyed");
    await setKeyedState(t, keyed, "keys", 5);

    const beforePlain = await scheduledCount(t);
    await t.mutation(internal.functions.nodes.finish, { workspaceId: plain, at: 10, files: 0 });
    expect(await scheduledCount(t)).toBe(beforePlain + 1);

    const beforeKeyed = await scheduledCount(t);
    await t.mutation(internal.functions.nodes.finish, { workspaceId: keyed, at: 10, files: 0 });
    expect(await scheduledCount(t)).toBe(beforeKeyed);
  });

  test("the keyed check is one query for the workspace's own state", async () => {
    const t = convexTest(schema, modules);
    const ws = await workspace(t, "isKeyed");
    const other = await workspace(t, "isKeyedOther");
    await setKeyedState(t, ws, "keys", 5);
    expect(await t.query(internal.functions.nodes.isKeyed, { workspaceId: ws })).toBe(true);
    expect(await t.query(internal.functions.nodes.isKeyed, { workspaceId: other })).toBe(false);
  });
});

describe("nodes.prune honours a keyed workspace", () => {
  async function seedUnobserved(t: ReturnType<typeof convexTest>, ws: Id<"workspaces">) {
    await t.mutation(internal.functions.nodes.observe, {
      workspaceId: ws,
      at: 10,
      rows: [{ path: "1-projects/a.md", etag: "e1" }],
      gone: [],
      vanishedUnder: [],
    });
  }

  test("a sweep that finds its workspace not keyed prunes what nobody observed since it began", async () => {
    const t = convexTest(schema, modules);
    const ws = await workspace(t, "prunes");
    await seedUnobserved(t, ws);
    await t.mutation(internal.functions.nodes.prune, { workspaceId: ws, startedAt: 100 });
    const listed = await t.query(internal.functions.nodes.listLive, { workspaceId: ws, limit: 100 });
    expect(listed.rows).toEqual([]);
  });

  test("a keyed workspace's prune removes nothing and answers that it is done", async () => {
    const t = convexTest(schema, modules);
    const ws = await workspace(t, "keptall");
    await seedUnobserved(t, ws);
    await setKeyedState(t, ws, "keys", 5);

    const answer = await t.mutation(internal.functions.nodes.prune, { workspaceId: ws, startedAt: 100 });

    expect(answer).toEqual({ more: false });
    const listed = await t.query(internal.functions.nodes.listLive, { workspaceId: ws, limit: 100 });
    expect(listed.rows.map((row) => row.path)).toEqual(["1-projects/a.md"]);
  });
});

describe("convexNodeTable: noteId and storageKey", () => {
  test("an insert with no noteId mints one; an insert with a given noteId and storageKey keeps them", async () => {
    const t = convexTest(schema, modules);
    const ws = await workspace(t, "ids-table");
    const given = "0190a000-0000-7000-8000-00000000000d";
    await t.run(async (ctx) => {
      const table = convexNodeTable(ctx, ws);
      await table.insert({ path: "plain.md", name: "plain.md", kind: "file", observedAt: 1 });
      await table.insert({
        path: "keyed.md",
        name: "keyed.md",
        kind: "file",
        observedAt: 1,
        noteId: given,
        storageKey: `notes/${given}.md`,
      });
    });
    const plain = await t.run((ctx) => convexNodeTable(ctx, ws).byPath("plain.md"));
    const keyed = await t.run((ctx) => convexNodeTable(ctx, ws).byPath("keyed.md"));
    expect(plain?.noteId).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
    expect(plain?.storageKey).toBeUndefined();
    expect(keyed).toMatchObject({ noteId: given, storageKey: `notes/${given}.md` });
  });

  test("a patch sets storageKey, keyedFrom and idCopy, and undefined clears them", async () => {
    const t = convexTest(schema, modules);
    const ws = await workspace(t, "patch-table");
    const id = await t.run(async (ctx) => {
      const table = convexNodeTable(ctx, ws);
      return await table.insert({ path: "a.md", name: "a.md", kind: "file", observedAt: 1 });
    });
    await t.run(async (ctx) => {
      await convexNodeTable(ctx, ws).patch(id, {
        storageKey: "notes/n.md",
        keyedFrom: { pathEtag: "p", keyEtag: "k" },
        idCopy: { key: "notes/n.md", etag: "p", copiedAt: 2 },
      });
    });
    const set = await t.run((ctx) => convexNodeTable(ctx, ws).byPath("a.md"));
    expect(set).toMatchObject({ storageKey: "notes/n.md", keyedFrom: { pathEtag: "p", keyEtag: "k" }, idCopy: { key: "notes/n.md" } });

    await t.run(async (ctx) => {
      await convexNodeTable(ctx, ws).patch(id, { storageKey: undefined, keyedFrom: undefined, idCopy: undefined });
    });
    const cleared = await t.run((ctx) => convexNodeTable(ctx, ws).byPath("a.md"));
    expect(cleared?.storageKey).toBeUndefined();
    expect(cleared?.keyedFrom).toBeUndefined();
    expect(cleared?.idCopy).toBeUndefined();
  });
});
