/**
 * The workspace object's encryption flag (`ws.encryption`, `workspaceStore/rows.js`): told `keyed` before the first
 * data key is written (`functions/encryptionKeys.ts`), and set from the key rows when a workspace's rows are pushed
 * (`functions/workspaceObjects.ts`), so a gateway can tell from the object alone whether a read needs a key.
 *
 * Sabotage, each confirmed to fail a case here: write the key before telling the object, drop the push of the flag.
 */

import { describe, expect, test } from "vitest";
import { convexTest, type TestConvex } from "convex-test";
import schema from "../schema";
import { modules } from "../test.setup";
import { internal } from "../_generated/api";
import type { Id } from "../_generated/dataModel";
import { serveWorkspaceStore } from "../../mcp/src/workspaceStore/serve.js";
import { objectFor } from "./workspaceObject.helpers";

const A = "notes/0199a000-0000-7000-8000-00000000000a.md";

describe("the object's encryption flag follows the data key", () => {
  const clean = { bucketKeys: 1, objectKeys: 1, missingInObject: 0, extraInObject: 0, differ: 0 };

  async function workspaceWithANote(t: TestConvex<typeof schema>) {
    return await t.run(async (ctx) => {
      const userId = await ctx.db.insert("users", {});
      const id = await ctx.db.insert("workspaces", { slug: "acme", displayName: "Acme", createdBy: userId, kind: "shared", structureTemplate: "para", createdAt: 1, updatedAt: 1 } as never);
      await ctx.db.insert("nodes", { workspaceId: id, path: "plan.md", name: "plan.md", kind: "file", etag: "e1", size: 3, observedAt: 1, noteId: "0199a000-0000-7000-8000-00000000000a", storageKey: A });
      return id;
    });
  }

  /**
   * The real object behind a stand-in for the gateway's door (as the copy tests do), with its `ws.*` calls recorded,
   * a switch that makes `ws.encryption` fail as an unreachable object would, and the env the client reads restored after.
   */
  function gatewayFor(workspaceId: string) {
    const { store, client: direct } = objectFor(workspaceId);
    const ops: string[] = [];
    const flags = { failEncryption: false };
    const env = process.env;
    process.env = { ...env, STORAGE_MOVER_ORIGIN: "https://gateway.example.invalid", GATEWAY_SECRET: "test-secret" };
    const fetchBefore = globalThis.fetch;
    globalThis.fetch = (async (_url: string, init: RequestInit) => {
      const call = String((init.headers as Record<string, string>)["x-tex-call"] ?? "");
      const op = JSON.parse(decodeURIComponent(call)).op as string;
      ops.push(op);
      if (op === "ws.encryption" && flags.failEncryption) throw new Error("the object is not reachable yet");
      let body = init.body as ArrayBuffer;
      if (op.startsWith("ws.")) body = new TextEncoder().encode(JSON.stringify({ ...JSON.parse(new TextDecoder().decode(body) || "{}"), workspaceId })).buffer as ArrayBuffer;
      return await serveWorkspaceStore(store, new Request("https://workspace-store.internal/door", { method: "POST", headers: { "x-tex-call": call }, body }));
    }) as typeof fetch;
    return {
      direct,
      ops,
      flags,
      restore: () => {
        globalThis.fetch = fetchBefore;
        process.env = env;
      },
    };
  }

  /** The switch to `object`, after the backfill and a clean parity check, as the workflow would leave them. */
  async function switchToObject(t: TestConvex<typeof schema>, workspaceId: Id<"workspaces">) {
    await t.mutation(internal.functions.workspaceObjectsRows.recordHome, { workspaceId, home: "dual", now: Date.now() });
    await t.mutation(internal.functions.workspaceObjectsRows.recordCopy, { workspaceId, backfilledAt: Date.now() });
    await t.mutation(internal.functions.workspaceObjectsRows.recordParity, {
      workspaceId,
      parity: { at: Date.now(), bodies: clean, rows: { convex: 1, object: 1, match: true }, rules: { match: true }, visibility: { principals: 2, checked: 2, differ: 0 } },
    });
    return await t.action(internal.functions.workspaceObjects.setHome, { workspaceId, home: "object" });
  }

  const keyRowsOf = (t: TestConvex<typeof schema>, workspaceId: Id<"workspaces">) =>
    t.run((ctx) => ctx.db.query("workspaceDataKeys").withIndex("by_workspace", (q) => q.eq("workspaceId", workspaceId)).collect());

  test("a workspace with no data key flips to object and its object says none", async () => {
    const t = convexTest(schema, modules);
    const workspaceId = await workspaceWithANote(t);
    const gateway = gatewayFor(String(workspaceId));
    try {
      expect((await gateway.direct.state()).encryption).toBeNull();
      expect(await switchToObject(t, workspaceId)).toEqual({ ok: true });
      expect(gateway.ops).toContain("ws.encryption");
      expect((await gateway.direct.state()).encryption).toBe("none");
    } finally {
      gateway.restore();
    }
  });

  test("a workspace with a data key flips to object and its object says keyed", async () => {
    const t = convexTest(schema, modules);
    const workspaceId = await workspaceWithANote(t);
    await t.run((ctx) => ctx.db.insert("workspaceDataKeys", { workspaceId, generation: "k1", encryptedDataKey: "sealed-fixture", createdAt: 1 }));
    const gateway = gatewayFor(String(workspaceId));
    try {
      expect(await switchToObject(t, workspaceId)).toEqual({ ok: true });
      expect((await gateway.direct.state()).encryption).toBe("keyed");
    } finally {
      gateway.restore();
    }
  });

  test("the first data key is written only after the object has been told keyed, so an unreachable object makes no key", async () => {
    const t = convexTest(schema, modules);
    const workspaceId = await workspaceWithANote(t);
    const gateway = gatewayFor(String(workspaceId));
    try {
      gateway.flags.failEncryption = true;
      await expect(t.action(internal.functions.encryptionKeys.openWorkspaceDataKey, { workspaceId, create: true })).rejects.toThrow();
      expect(gateway.ops).toContain("ws.encryption");
      expect(await keyRowsOf(t, workspaceId)).toEqual([]);
      expect((await gateway.direct.state()).encryption).toBeNull();

      gateway.flags.failEncryption = false;
      const opened = await t.action(internal.functions.encryptionKeys.openWorkspaceDataKey, { workspaceId, create: true });
      expect(opened?.current).toBe("k1");
      expect(await keyRowsOf(t, workspaceId)).toHaveLength(1);
      expect((await gateway.direct.state()).encryption).toBe("keyed");
    } finally {
      gateway.restore();
    }
  });
});
