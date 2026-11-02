/**
 * A change to what a workspace's storage binding is made of clears the sealed copy its object keeps
 * (`lib/rowWatch/watch.ts` `BINDING_TABLES`, `workspaceObjectPush.ts`, `workspaceObjectBinding.ts`;
 * `apps/mcp/src/workspaceStore/bindingRows.js`), through the gateway's real door into a real object on node:sqlite.
 *
 * Until the clear lands the workspace reads as behind, so the gateway never opens a store from the old copy
 * (`apps/mcp/src/store/objectBinding.js`). Sabotage, each confirmed to fail a case here: drop the binding tables from
 * the watch (no entry), drop the clear from the drain (the copy survives), drop the scheduled clear for a workspace
 * not on its object (the copy survives a switch back).
 */

import { createRequire } from "node:module";
import { afterEach, describe, expect, test, vi } from "vitest";
import { internal } from "../_generated/api";
import type { Id } from "../_generated/dataModel";
import type { MutationCtx } from "../_generated/server";
import { handleWorkspaceStoreDoor } from "../../mcp/src/workspaceStore/door.js";
import { serveWorkspaceStore } from "../../mcp/src/workspaceStore/serve.js";
import { workspaceRows } from "../../mcp/src/workspaceStore/rows.js";
import { bindingRows } from "../../mcp/src/workspaceStore/bindingRows.js";
import { texObjects } from "../../mcp/src/texStore/objects.js";
import { flushRowChanges } from "../functions/lib/rowWatch/mutations";
import { watchDb } from "../functions/lib/rowWatch/watch";
import { TEST_GATEWAY_SECRET, createUser, createWorkspace, drainScheduled, gatewayPost, seedStorageBinding, setupTest, type TestConvex } from "./fixtures.helpers";

const { DatabaseSync } = createRequire(import.meta.url)("node:sqlite") as typeof import("node:sqlite");
const GATEWAY = "https://gateway.example.invalid";

afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
});

function durableSql() {
  const db = new DatabaseSync(":memory:");
  return {
    exec(query: string, ...binds: unknown[]) {
      const statement = db.prepare(query);
      if (/^\s*SELECT/i.test(query)) {
        const all = statement.all(...(binds as never[]));
        return { toArray: () => all };
      }
      statement.run(...(binds as never[]));
      return { toArray: () => [] };
    },
  };
}

type Kept = ReturnType<typeof bindingRows>;

async function world() {
  const t = setupTest();
  const owner = await createUser(t, "binding-clear@example.com");
  const workspaceId = await createWorkspace(t, owner, "binding-clear", { kind: "shared" });
  await seedStorageBinding(t, { workspaceId, boundBy: owner, status: "connected" });
  const sql = durableSql();
  const store = { rows: workspaceRows(sql), objects: texObjects(sql), binding: bindingRows(sql) };
  const env = {
    GATEWAY_SECRET: TEST_GATEWAY_SECRET,
    WORKSPACE_STORE: { idFromName: (name: string) => name, get: () => ({ fetch: (request: Request) => serveWorkspaceStore(store, request) }) },
  };
  const controlPlane = {
    async openTexStoreTicket(ticket: string) {
      const response = await gatewayPost(t, "/gateway/tex-store/open", { ticket });
      return ((await response.json()) as { opened: { workspaceId: string; owners: string[] } | null }).opened;
    },
  };
  const ops: string[] = [];
  // Door calls wait on this gate, so the window between a write and its push is pinned open, not raced.
  let open: () => void = () => {};
  let gate: Promise<void> = Promise.resolve();
  const hold = () => (gate = new Promise((resolve) => (open = resolve)));
  vi.stubEnv("STORAGE_MOVER_ORIGIN", GATEWAY);
  vi.stubEnv("GATEWAY_SECRET", TEST_GATEWAY_SECRET);
  vi.stubGlobal("fetch", async (url: string, init: RequestInit) => {
    await gate;
    ops.push(JSON.parse(decodeURIComponent(new Headers(init.headers).get("x-tex-call") ?? "{}")).op);
    return await handleWorkspaceStoreDoor(new Request(url, init), env, { controlPlane });
  });
  // The object pins its workspace on the first call, as the gateway's own first call would.
  store.rows.pinWorkspace(workspaceId);
  const kept: Kept = store.binding;
  kept.put({ sealed: "v1.aaaa.bbbb", at: Date.now(), epoch: 0 });
  return { t, workspaceId, kept, ops, hold, release: () => open() };
}

async function setHome(t: TestConvex, workspaceId: Id<"workspaces">, home: "bucket" | "dual" | "object") {
  await t.run(async (ctx) => {
    const held = await ctx.db.query("workspaceObjectHomes").withIndex("by_workspace", (q) => q.eq("workspaceId", workspaceId)).unique();
    if (held === null) await ctx.db.insert("workspaceObjectHomes", { workspaceId, home, since: Date.now() });
    else await ctx.db.patch(held._id, { home });
  });
}

/** A watched write, as every mutation in the deployment makes one (`lib/rowWatch/mutations.ts`). */
async function watched(t: TestConvex, write: (db: MutationCtx["db"]) => Promise<unknown>) {
  await t.run(async (ctx) => {
    const watch = watchDb((ctx as MutationCtx).db);
    await write(watch.db);
    await flushRowChanges(ctx as MutationCtx, watch.changes);
  });
}

const outbox = (t: TestConvex, workspaceId: Id<"workspaces">) =>
  t.run(async (ctx) => await ctx.db.query("workspaceObjectOutbox").withIndex("by_workspace_at", (q) => q.eq("workspaceId", workspaceId)).collect());

const bindingRow = (t: TestConvex, workspaceId: Id<"workspaces">) =>
  t.run(async (ctx) => (await ctx.db.query("storageBindings").withIndex("by_workspace", (q) => q.eq("workspaceId", workspaceId)).unique())!);

describe("a binding change clears the object's kept copy", () => {
  test("a bucket credential change: the workspace reads as behind until the push clears the copy, with no row push", async () => {
    const { t, workspaceId, kept, ops, hold, release } = await world();
    await setHome(t, workspaceId, "object");
    const row = await bindingRow(t, workspaceId);
    hold();
    await watched(t, (db) => db.patch(row._id, { accessKeyId: "rotated-key-id" }));
    expect(await outbox(t, workspaceId)).toMatchObject([{ binding: true, nodeIds: [], access: false }]);
    expect(await t.query(internal.functions.workspaceObjectPush.waitingSince, { workspaceId, at: Number.MAX_SAFE_INTEGER })).toBe(true);
    expect(kept.get().sealed).not.toBeNull();

    // The push the write scheduled.
    release();
    await drainScheduled(t);
    expect(kept.get()).toMatchObject({ sealed: null, epoch: 1 });
    expect(await outbox(t, workspaceId)).toEqual([]);
    expect(ops).toEqual(["ws.binding.clear"]);
  });

  test("managed encryption starting clears it too", async () => {
    const { t, workspaceId, kept } = await world();
    await setHome(t, workspaceId, "object");
    await watched(t, (db) => db.insert("managedEncryptionWorkspaces", { workspaceId, state: "encrypting", filesDone: 0, runId: 1, updatedAt: Date.now() } as never));
    expect(await outbox(t, workspaceId)).toMatchObject([{ binding: true }]);
    await drainScheduled(t);
    expect(kept.get().sealed).toBeNull();
  });

  test("a field no store is built from leaves the copy alone", async () => {
    const { t, workspaceId, kept } = await world();
    await setHome(t, workspaceId, "object");
    const row = await bindingRow(t, workspaceId);
    await watched(t, (db) => db.patch(row._id, { scaffoldQueuedAt: Date.now() }));
    expect(await outbox(t, workspaceId)).toEqual([]);
    expect(kept.get().sealed).not.toBeNull();
  });

  test("a workspace switched back off its object has its copy cleared all the same", async () => {
    const { t, workspaceId, kept } = await world();
    await setHome(t, workspaceId, "object");
    await watched(t, async (db) => {
      const home = await db.query("workspaceObjectHomes").withIndex("by_workspace", (q) => q.eq("workspaceId", workspaceId)).unique();
      await db.patch(home!._id, { home: "dual" });
    });
    expect(await outbox(t, workspaceId)).toEqual([]);
    await drainScheduled(t);
    expect(kept.get()).toMatchObject({ sealed: null, epoch: 1 });
  });
});
