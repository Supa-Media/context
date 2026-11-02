/**
 * Who still sends their token in a URL (`functions/tokenTransport.ts`).
 *
 * `/gateway/session` stamps the grant when the gateway says the token came as
 * `/t/<token>/...`, at most hourly per route; the census counts live grants
 * by route and by console vs outside client, and names none of them.
 *
 * Sabotage (temporary local edits, reverted): stamping on every resolve,
 * whatever `transport` says, fails "a header token stamps nothing"; dropping
 * the `status !== "active"` check from the census fails "a revoked grant is
 * not counted".
 */

import { describe, expect, test } from "vitest";
import { internal } from "../../_generated/api";
import type { Id } from "../../_generated/dataModel";
import { CONSOLE_CLIENT_ID } from "../../functions/agentGrant";
import { hashToken } from "../../functions/lib/crypto";
import { createUser, createWorkspace, gatewayPost, seedGrant, setupTest } from "../fixtures.helpers";

type T = ReturnType<typeof setupTest>;

async function grantWithToken(t: T, clientId: string, accessToken: string): Promise<Id<"oauthGrants">> {
  const owner = await createUser(t, `${clientId}@example.test`);
  const workspaceId = await createWorkspace(t, owner, `ws-${clientId.replace(/_/g, "-")}`);
  const grantId = await seedGrant(t, workspaceId, owner, clientId, await hashToken(`${accessToken}-refresh`), Date.now() + 3_600_000);
  const hashedAccessToken = await hashToken(accessToken);
  await t.run(async (ctx) => {
    await ctx.db.patch(grantId, { hashedAccessToken });
    await ctx.db.insert("oauthClients", {
      clientId,
      clientName: "Transport test client",
      redirectUris: [],
      hashedClientSecret: null,
      tokenEndpointAuthMethod: "none",
      grantTypes: [],
      responseTypes: [],
      createdAt: Date.now(),
    } as never);
  });
  return grantId;
}

async function stamp(t: T, grantId: Id<"oauthGrants">) {
  return await t.run(async (ctx) => {
    const grant = await ctx.db.get(grantId);
    return { at: grant?.pathTokenSeenAt, route: grant?.pathTokenRoute };
  });
}

describe("counting URL tokens", () => {
  test("a URL token stamps its grant with the route, and resolves as before", async () => {
    const t = setupTest();
    const token = "outside-client-access-token-0001";
    const grantId = await grantWithToken(t, "client_outside", token);
    const response = await gatewayPost(t, "/gateway/session", { accessToken: token, transport: "path", route: "mcp" });
    expect(((await response.json()) as { session: { grantId: string } | null }).session?.grantId).toBe(grantId);
    const seen = await stamp(t, grantId);
    expect(seen.route).toBe("mcp");
    expect(typeof seen.at).toBe("number");
  });

  test("a header token stamps nothing", async () => {
    const t = setupTest();
    const token = "outside-client-access-token-0002";
    const grantId = await grantWithToken(t, "client_outside", token);
    await gatewayPost(t, "/gateway/session", { accessToken: token });
    expect(await stamp(t, grantId)).toEqual({ at: undefined, route: undefined });
  });

  test("an unknown route name is recorded as other, never as given", async () => {
    const t = setupTest();
    const token = "outside-client-access-token-0003";
    const grantId = await grantWithToken(t, "client_outside", token);
    await gatewayPost(t, "/gateway/session", { accessToken: token, transport: "path", route: "/notes/secret.md" });
    expect((await stamp(t, grantId)).route).toBe("other");
  });

  test("the census counts live grants by route and client kind, and names none", async () => {
    const t = setupTest();
    const outside = await grantWithToken(t, "client_outside", "outside-client-access-token-0004");
    const app = await grantWithToken(t, CONSOLE_CLIENT_ID, "console-client-access-token-0005");
    const revoked = await grantWithToken(t, "client_gone", "revoked-client-access-token-0006");
    await t.mutation(internal.functions.tokenTransport.notePathToken, { grantId: outside, route: "mcp" });
    await t.mutation(internal.functions.tokenTransport.notePathToken, { grantId: app, route: "presence" });
    await t.mutation(internal.functions.tokenTransport.notePathToken, { grantId: revoked, route: "mcp" });
    await t.run(async (ctx) => await ctx.db.patch(revoked, { status: "revoked" }));

    const census = await t.query(internal.functions.tokenTransport.pathTokenCensus, {});
    expect(census).toMatchObject({ grants: 2, byRoute: { mcp: 1, presence: 1 }, console: 1, otherClients: 1 });
    expect(JSON.stringify(census)).not.toContain(outside);
  });

  test("a stamp is written at most hourly for the same route", async () => {
    const t = setupTest();
    const grantId = await grantWithToken(t, "client_outside", "outside-client-access-token-0007");
    await t.mutation(internal.functions.tokenTransport.notePathToken, { grantId, route: "mcp" });
    const first = await stamp(t, grantId);
    await new Promise((resolve) => setTimeout(resolve, 5));
    await t.mutation(internal.functions.tokenTransport.notePathToken, { grantId, route: "mcp" });
    expect((await stamp(t, grantId)).at).toBe(first.at);
    await t.mutation(internal.functions.tokenTransport.notePathToken, { grantId, route: "presence" });
    expect((await stamp(t, grantId)).route).toBe("presence");
  });
});
