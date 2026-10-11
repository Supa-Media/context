/**
 * /gateway/binding — the meaning index beside the binding.
 *
 * Search by meaning's sibling of `searchIndex` (`searchIndex.test.ts` argues
 * the route and the two-factor bound; this file asserts the same bound holds
 * for the new payload). The gateway writes a note's passages into the index it
 * is handed, so the properties are the same three: the index is the workspace
 * the grant resolved to and never one the caller named, nothing is handed out
 * until the index takes writes, and off stops handing it out at once.
 *
 * ## Sabotage record
 *
 * Run as temporary local edits and reverted.
 *
 *   `writeTargetForWorkspace` dropping its status check and
 *     reporting every row `ready`                               → "a half-built or switched-off index is handed nothing" fails
 *     (returning the raw `provisioning` instead is refused by the query's
 *     return validator, which the route's `.catch` reads as absent: two guards)
 *   `writeTargetForWorkspace` ignoring `enabled`                → the same test fails
 *   `getStorageBinding` dropping the `meaningIndex` sibling     → "the gateway reads it out of the real response" fails
 */

import { describe, expect, test } from "vitest";
import type { Id } from "../../_generated/dataModel";
import { FAKE_D1, TEST_GATEWAY_SECRET, gatewayPost, seedAppSecret, type TestConvex } from "../fixtures.helpers";
import { ACCESS_A, bodyOf, twoConnectedTenants } from "./fixtures.helpers";

async function configureD1(t: TestConvex): Promise<void> {
  await seedAppSecret(t, "SEARCH_D1_API_TOKEN", FAKE_D1.apiToken);
  await seedAppSecret(t, "SEARCH_D1_ACCOUNT_ID", FAKE_D1.accountId);
}

/** A meaning row, inserted directly so no provision is scheduled. */
async function seedMeaningIndex(
  t: TestConvex,
  workspaceId: Id<"workspaces">,
  options: {
    status?: "provisioning" | "backfilling" | "ready" | "failed" | "releasing";
    enabled?: boolean;
    indexName?: string | null;
  } = {},
): Promise<void> {
  const now = Date.now();
  await t.run(async (ctx) => {
    await ctx.db.insert("meaningIndexes", {
      workspaceId,
      enabled: options.enabled ?? true,
      enabledAt: now,
      status: options.status ?? "ready",
      ...(options.indexName === null ? {} : { indexName: options.indexName ?? `context-meaning-${workspaceId}` }),
      createdAt: now,
      updatedAt: now,
    });
  });
}

async function bindingText(t: TestConvex, expectedWorkspaceId: Id<"workspaces"> | null): Promise<string> {
  return await (await gatewayPost(t, "/gateway/binding", { accessToken: ACCESS_A, expectedWorkspaceId })).text();
}

describe("/gateway/binding — the meaning index", () => {
  test("an index that takes writes rides beside the binding", async () => {
    const { t, aliceWs } = await twoConnectedTenants();
    await configureD1(t);
    await seedMeaningIndex(t, aliceWs, { status: "backfilling", indexName: "context-meaning-alice" });

    const body = await bodyOf(await gatewayPost(t, "/gateway/binding", { accessToken: ACCESS_A, expectedWorkspaceId: aliceWs }));
    expect((body.binding as { bucket: string }).bucket).toBe("tenant-a");
    expect(body.meaningIndex).toEqual({
      indexName: "context-meaning-alice",
      accountId: FAKE_D1.accountId,
      apiToken: FAKE_D1.apiToken,
      state: "backfilling",
    });
    // Fast search is off for alice; turning meaning on must not hand that out.
    expect(body.searchIndex).toBeUndefined();
  });

  test("a half-built or switched-off index is handed nothing", async () => {
    const { t, aliceWs } = await twoConnectedTenants();
    await configureD1(t);
    await seedMeaningIndex(t, aliceWs, { status: "provisioning", indexName: "context-meaning-alice" });
    const states: Array<{ status?: "provisioning" | "backfilling" | "ready" | "failed" | "releasing"; enabled?: boolean; indexName?: string | null }> = [
      { status: "provisioning" },
      { status: "failed" },
      { status: "releasing", enabled: false },
      { status: "ready", enabled: false },
      { status: "ready", indexName: null },
    ];
    for (const state of states) {
      await t.run(async (ctx) => {
        const row = await ctx.db
          .query("meaningIndexes")
          .withIndex("by_workspace", (q) => q.eq("workspaceId", aliceWs))
          .unique();
        await ctx.db.patch(row!._id, {
          status: state.status ?? "ready",
          enabled: state.enabled ?? true,
          indexName: state.indexName === null ? undefined : "context-meaning-alice",
        });
      });
      const text = await bindingText(t, aliceWs);
      expect(text, JSON.stringify(state)).not.toContain("meaningIndex");
      expect(text, JSON.stringify(state)).not.toContain("context-meaning-alice");
      expect(text, JSON.stringify(state)).not.toContain(FAKE_D1.apiToken);
    }
  });

  test("with no credential configured the binding still opens, and nothing else rides", async () => {
    const { t, aliceWs } = await twoConnectedTenants();
    await seedMeaningIndex(t, aliceWs);
    const body = JSON.parse(await bindingText(t, aliceWs)) as Record<string, unknown>;
    expect(Object.keys(body)).toEqual(["binding"]);
  });

  test("a caller cannot obtain another tenant's meaning index by naming it", async () => {
    const { t, aliceWs, bobWs } = await twoConnectedTenants();
    await configureD1(t);
    await seedMeaningIndex(t, aliceWs, { indexName: "context-meaning-alice" });
    await seedMeaningIndex(t, bobWs, { indexName: "context-meaning-bob" });

    const text = await bindingText(t, bobWs);
    expect(JSON.parse(text)).toEqual({ binding: null });
    expect(text).not.toContain("context-meaning-bob");
    expect(text).not.toContain(FAKE_D1.apiToken);

    // Non-vacuity: alice's own call gets alice's own index.
    const own = JSON.parse(await bindingText(t, aliceWs)) as { meaningIndex?: { indexName: string } };
    expect(own.meaningIndex?.indexName).toBe("context-meaning-alice");
  });

  test("the gateway reads it out of the response this route really sends", async () => {
    const { t, aliceWs } = await twoConnectedTenants();
    await configureD1(t);
    await seedMeaningIndex(t, aliceWs, { indexName: "context-meaning-contract" });
    const wire = await bindingText(t, aliceWs);

    const { createControlPlane } = await import("../../../mcp/src/controlPlane.js");
    const { storeForSession } = await import("../../../mcp/src/session.js");
    const controlPlane = createControlPlane(
      { CONTROL_PLANE_URL: "https://control-plane.test", GATEWAY_SECRET: TEST_GATEWAY_SECRET },
      { fetchImpl: async () => new Response(wire, { status: 200, headers: { "Content-Type": "application/json" } }) },
    );
    const store = (await storeForSession({ workspaceId: aliceWs, accessToken: ACCESS_A }, {}, controlPlane)) as unknown as {
      bucket: string;
      meaningIndex: { indexName: string; state: string } | null;
    };
    expect(store.meaningIndex?.indexName).toBe("context-meaning-contract");
    expect(store.meaningIndex?.state).toBe("ready");
    expect(store.bucket).toBe("tenant-a");
    // Non-enumerable, like `searchIndex`: one `{...store}` must not carry the token.
    expect(JSON.stringify({ ...store })).not.toContain(FAKE_D1.apiToken);
  });
});
