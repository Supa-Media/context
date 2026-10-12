/**
 * `POST /gateway/tree/touch`: the gateway names what a write touched, so the
 * Convex tree can re-check it.
 *
 * Malformed input is refused before anything is scheduled, and a well-formed
 * id that names no context gets the same `ok` as a real one, so the route is
 * not a way to learn which contexts exist. A `dirty` touch asks for a sweep
 * through the tree's own row (`nodeTrees.dirty`).
 */

import { describe, expect, test } from "vitest";
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
  test("a malformed body is refused with 400, whatever the workspace", async () => {
    const { t, workspaceId } = await owned();
    const bad = [
      {},
      { workspaceId, paths: "1-projects/a.md" },
      { workspaceId, paths: Array.from({ length: 51 }, (_, index) => `a${index}.md`) },
      { workspaceId, paths: [LONG] },
      { workspaceId, files: [42] },
      { workspaceId, paths: [], dirty: "yes" },
    ];
    for (const body of bad) {
      const response = await gatewayPost(t, "/gateway/tree/touch", body);
      expect(response.status, JSON.stringify(body).slice(0, 80)).toBe(400);
    }
  });

  test("a valid touch is answered ok, and so is one that names no context", async () => {
    const { t, workspaceId } = await owned();
    const real = await gatewayPost(t, "/gateway/tree/touch", { workspaceId, paths: ["1-projects/a.md"], files: [] });
    expect(real.status).toBe(200);
    expect(await real.json()).toEqual({ ok: true });

    // A well-formed id of a context that was deleted, answered as a real one is.
    const gone = (await createWorkspace(t, await createUser(t, "gone@example.invalid"), "gone")) as Id<"workspaces">;
    await t.run(async (ctx) => {
      await ctx.db.delete(gone);
    });
    const missing = await gatewayPost(t, "/gateway/tree/touch", { workspaceId: gone, paths: ["a.md"], files: [] });
    expect(missing.status).toBe(200);
    expect(await missing.json()).toEqual({ ok: true });
  });

  test("a dirty touch marks the workspace's tree dirty, so the next walk sweeps it", async () => {
    const { t, workspaceId } = await owned();
    const response = await gatewayPost(t, "/gateway/tree/touch", {
      workspaceId,
      paths: [],
      files: [],
      dirty: true,
    });
    expect(response.status).toBe(200);
    const row = await t.run(async (ctx) =>
      await ctx.db
        .query("nodeTrees")
        .withIndex("by_workspace", (q) => q.eq("workspaceId", workspaceId))
        .unique(),
    );
    expect(row?.dirty).toBe(true);
  });
});
