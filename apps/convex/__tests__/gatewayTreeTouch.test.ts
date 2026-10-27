/**
 * `POST /gateway/tree/touch`: the gateway names what a write touched, so the
 * Convex tree can re-check it.
 *
 * Malformed input is refused before anything is recorded, and a well-formed
 * id that names no context gets the same `ok` as a real one, so the route is
 * not a way to learn which contexts exist. A move's forwarding addresses and
 * icon moves are recorded in Convex (`smallData.ts`) before the answer, and only
 * for a context that exists. The route no longer takes paths, files or a dirty
 * flag: the tree learns of writes through the product's own seam, not from a
 * name the gateway sends.
 */

import { describe, expect, test } from "vitest";
import { internal } from "../_generated/api";
import type { Id } from "../_generated/dataModel";
import { createUser, createWorkspace, gatewayPost, setupTest } from "./fixtures.helpers";

const LONG = "x".repeat(1025);

async function owned() {
  const t = setupTest();
  const owner = await createUser(t, "owner@example.invalid");
  const workspaceId = (await createWorkspace(t, owner, "touch")) as Id<"workspaces">;
  return { t, workspaceId };
}

describe("POST /gateway/tree/touch", () => {
  test("a body with no context id is refused with 400", async () => {
    const { t, workspaceId } = await owned();
    const bad = [{}, { workspaceId: 42 }, { workspaceId: "" }];
    for (const body of bad) {
      const response = await gatewayPost(t, "/gateway/tree/touch", body);
      expect(response.status, JSON.stringify(body).slice(0, 80)).toBe(400);
    }
  });

  test("a valid touch is answered ok, and so is one that names no context", async () => {
    const { t, workspaceId } = await owned();
    const real = await gatewayPost(t, "/gateway/tree/touch", { workspaceId });
    expect(real.status).toBe(200);
    expect(await real.json()).toEqual({ ok: true });

    // A well-formed id of a context that was deleted, answered as a real one is.
    const gone = (await createWorkspace(t, await createUser(t, "gone@example.invalid"), "gone")) as Id<"workspaces">;
    await t.run(async (ctx) => {
      await ctx.db.delete(gone);
    });
    const missing = await gatewayPost(t, "/gateway/tree/touch", { workspaceId: gone });
    expect(missing.status).toBe(200);
    expect(await missing.json()).toEqual({ ok: true });
  });
});

describe("POST /gateway/tree/touch: forwarding and icons", () => {
  test("malformed ones are refused, and nothing is recorded", async () => {
    const { t, workspaceId } = await owned();
    const bad = [
      { workspaceId, forwarding: "a.md" },
      { workspaceId, forwarding: [{ from: "a.md", to: "b.md" }] },
      { workspaceId, forwarding: [{ from: "a.md", to: "b.md", kind: "file" }] },
      { workspaceId, forwarding: [{ from: "a.md", to: LONG, kind: "note" }] },
      { workspaceId, forwarding: Array.from({ length: 101 }, (_, n) => ({ from: `a${n}.md`, to: `b${n}.md`, kind: "note" })) },
      { workspaceId, icons: [{ from: "a" }] },
    ];
    for (const body of bad) {
      const response = await gatewayPost(t, "/gateway/tree/touch", body);
      expect(response.status, JSON.stringify(body).slice(0, 80)).toBe(400);
    }
    expect(await t.query(internal.functions.smallData.ledger, { workspaceId })).toEqual([]);
  });

  test("a move's forwarding and icons are recorded before the answer, and a gone context records nothing", async () => {
    const { t, workspaceId } = await owned();
    await t.mutation(internal.functions.smallData.setIcon, { workspaceId, path: "1-projects/q3", icon: "📦" });
    const response = await gatewayPost(t, "/gateway/tree/touch", {
      workspaceId,
      forwarding: [{ from: "1-projects/q3", to: "4-archive/q3", kind: "folder" }],
      icons: [{ from: "1-projects/q3", to: "4-archive/q3" }],
    });
    expect(response.status).toBe(200);
    const ledger = await t.query(internal.functions.smallData.ledger, { workspaceId });
    expect(ledger.map(({ from, to, kind }) => ({ from, to, kind }))).toEqual([{ from: "1-projects/q3", to: "4-archive/q3", kind: "folder" }]);
    expect(await t.query(internal.functions.smallData.icons, { workspaceId })).toEqual([{ path: "4-archive/q3", icon: "📦" }]);

    const gone = (await createWorkspace(t, await createUser(t, "gone2@example.invalid"), "gone-two")) as Id<"workspaces">;
    await t.run(async (ctx) => ctx.db.delete(gone));
    const missing = await gatewayPost(t, "/gateway/tree/touch", {
      workspaceId: gone,
      forwarding: [{ from: "a.md", to: "b.md", kind: "note" }],
    });
    expect(await missing.json()).toEqual({ ok: true });
    expect(await t.run(async (ctx) => (await ctx.db.query("forwardingEntries").collect()).filter((row) => row.workspaceId === gone))).toEqual([]);
  });
});
