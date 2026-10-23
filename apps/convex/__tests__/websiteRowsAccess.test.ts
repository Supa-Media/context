/**
 * An access change written to the rows marks a published site unsafe, as a
 * `privacy.md` change through a file operation did (`markWebsiteAfterOperation`):
 * narrowing a published folder must withhold the site's menu until the index
 * is rebuilt, whoever made the change (the console, an AI client, a grant).
 *
 * Sabotage: drop the `recordRouteChangeAtHandler` call from `setAccessRow`
 * and the first case fails.
 */

import { describe, expect, test } from "vitest";
import type { Id } from "../_generated/dataModel";
import { setAccessRow } from "../functions/lib/nodes/setAccess";
import { tester, user, type T } from "./noteIds/noteIds.helpers";

async function site(t: T, enabled: boolean): Promise<{ ws: Id<"workspaces">; owner: Id<"users"> }> {
  const owner = await user(t, "owner@example.test");
  const ws = await t.run(async (ctx) => {
    const now = Date.now();
    const ws = await ctx.db.insert("workspaces", {
      slug: "site",
      displayName: "Site",
      createdBy: owner,
      kind: "shared",
      structureTemplate: "para",
      createdAt: now,
      updatedAt: now,
    });
    await ctx.db.insert("workspaceMembers", { workspaceId: ws, userId: owner, role: "owner", joinedAt: now });
    await ctx.db.insert("websiteStates", { workspaceId: ws, state: enabled ? "enabled" : "disabled", routeGeneration: 1, updatedAt: now });
    await ctx.db.insert("nodes", { workspaceId: ws, path: "website", name: "website", kind: "folder", observedAt: now });
    await ctx.db.insert("nodes", { workspaceId: ws, path: "projects", name: "projects", kind: "folder", observedAt: now });
    return ws;
  });
  return { ws, owner };
}

async function narrow(t: T, ws: Id<"workspaces">, owner: Id<"users">, path: string) {
  return await t.run((ctx) => setAccessRow(ctx, { workspaceId: ws, path, base: "private", actor: { userId: owner, role: "owner" } }));
}

async function stateOf(t: T, ws: Id<"workspaces">) {
  return await t.run(async (ctx) => (await ctx.db.query("websiteStates").collect()).find((row) => row.workspaceId === ws) ?? null);
}

describe("a row access change and the website", () => {
  test("narrowing the published folder marks the site unsafe until it is rebuilt", async () => {
    const t = tester();
    const { ws, owner } = await site(t, true);
    expect(await narrow(t, ws, owner, "website")).toMatchObject({ ok: true });
    const state = await stateOf(t, ws);
    expect(state?.routeGeneration).toBe(2);
    expect(state?.routeUnsafeGeneration).toBe(2);
  });

  test("a change the site does not reach leaves it alone", async () => {
    const t = tester();
    const { ws, owner } = await site(t, true);
    expect(await narrow(t, ws, owner, "projects")).toMatchObject({ ok: true });
    expect((await stateOf(t, ws))?.routeUnsafeGeneration).toBeUndefined();
  });

  test("a workspace whose site is off is not marked", async () => {
    const t = tester();
    const { ws, owner } = await site(t, false);
    expect(await narrow(t, ws, owner, "website")).toMatchObject({ ok: true });
    expect((await stateOf(t, ws))?.routeGeneration).toBe(1);
  });
});
