/**
 * `POST /gateway/objects/behind`: whether a workspace's object is behind (a tree or access change committed here and
 * not yet taken by the object), which the gateway asks beside every object read so a share just taken back is never
 * served from the object's older rows (`apps/mcp/src/store/objectLookup.js`, `checkBehind`). Every mutation that
 * writes a workspace's rows leaves an outbox entry in its own transaction (`lib/rowWatch/mutations.ts`, proven in the
 * rowWatch tests); this route reports exactly that entry, and fails closed.
 *
 * Sabotage, each confirmed to fail a case here: answer `false` when the read fails, or read only entries older than
 * now (an entry stamped by a mutation whose clock leads is missed).
 */

import { describe, expect, test } from "vitest";
import type { Id } from "../_generated/dataModel";
import { createUser, createWorkspace, gatewayPost, setupTest } from "./fixtures.helpers";

async function owned() {
  const t = setupTest();
  const owner = await createUser(t, "owner@example.invalid");
  const workspaceId = (await createWorkspace(t, owner, "behind")) as Id<"workspaces">;
  return { t, workspaceId };
}

const behindOf = async (t: ReturnType<typeof setupTest>, body: Record<string, unknown>) => {
  const response = await gatewayPost(t, "/gateway/objects/behind", body);
  expect(response.status).toBe(200);
  return ((await response.json()) as { behind: boolean }).behind;
};

describe("POST /gateway/objects/behind", () => {
  test("behind while a change waits in the outbox, even one stamped ahead of now; not behind once it is taken", async () => {
    const { t, workspaceId } = await owned();
    expect(await behindOf(t, { workspaceId })).toBe(false);
    const entryId = await t.run(async (ctx) => await ctx.db.insert("workspaceObjectOutbox", { workspaceId, nodeIds: [], access: true, at: Date.now() + 60_000 } as never));
    expect(await behindOf(t, { workspaceId })).toBe(true);
    await t.run(async (ctx) => {
      await ctx.db.delete(entryId);
    });
    expect(await behindOf(t, { workspaceId })).toBe(false);
  });

  test("another workspace's waiting change does not make this one behind", async () => {
    const { t, workspaceId } = await owned();
    const other = (await createWorkspace(t, await createUser(t, "other@example.invalid"), "other")) as Id<"workspaces">;
    await t.run(async (ctx) => await ctx.db.insert("workspaceObjectOutbox", { workspaceId: other, nodeIds: [], access: true, at: Date.now() } as never));
    expect(await behindOf(t, { workspaceId })).toBe(false);
    expect(await behindOf(t, { workspaceId: other })).toBe(true);
  });

  test("anything it cannot read is behind, which only sends the reader to the control plane", async () => {
    const { t } = await owned();
    for (const body of [{}, { workspaceId: 42 }, { workspaceId: "" }, { workspaceId: "not-an-id" }]) {
      expect(await behindOf(t, body), JSON.stringify(body)).toBe(true);
    }
  });

  test("without the gateway secret it is refused", async () => {
    const { t, workspaceId } = await owned();
    const response = await t.fetch("/gateway/objects/behind", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ workspaceId }) });
    expect(response.status).toBe(401);
  });
});
