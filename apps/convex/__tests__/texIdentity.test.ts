import { describe, expect, test, vi } from "vitest";
import type { Id } from "../_generated/dataModel";
import { hashToken } from "../functions/lib/crypto";
import { HEARTBEAT_CLIENT_ID } from "../functions/lib/heartbeats/model";
import { ROUTINES_CLIENT_ID } from "../functions/lib/routines/model";
import { TEXTS_CLIENT_ID } from "../functions/textLinks";
import { createUser, createWorkspace, gatewayPost, seedGoogleConnection, setupTest } from "./fixtures.helpers";

/**
 * WHO IS TEXTING TEX (`lib/texIdentity/identity.ts`).
 *
 * Through the real `/gateway/agent/identity` route: Tex's own one-person
 * clients learn the grant's own person (phone, name, emails, Google
 * accounts) on their personal workspace, and every other caller gets the
 * same `null`.
 */
/*
 * ## Sabotage record
 *
 * Run as temporary local edits and reverted.
 *
 *   `IDENTITY_CLIENTS.has(...)` check removed
 *     → "a third-party MCP client never learns the phone" fails ("a group
 *       chat's grant" still holds: a group grant with no live group is dead
 *       before this runs, `liveGrants.ts`)
 *   `home !== args.expectedWorkspaceId` check removed
 *     → "a grant on a shared workspace learns nobody" fails
 *   the `disconnectedAt` filter removed
 *     → "Tex's texting grant learns its own person" fails (the old account comes back)
 */

vi.setConfig({ testTimeout: 20_000 });

const PHONE = "+15555550100";
const OWNER_SCOPES = ["context:read", "context:write", "context:private"];
type T = ReturnType<typeof setupTest>;

async function person(t: T, slug: string) {
  const userId = await createUser(t, `${slug}@example.invalid`);
  await t.run((ctx) => ctx.db.patch(userId, { name: "Ada Lovelace" }));
  const workspaceId = await createWorkspace(t, userId, slug, { kind: "personal" });
  await t.run((ctx) => ctx.db.insert("phoneLinks", { userId, phone: PHONE, linkedAt: Date.now() }));
  return { userId, workspaceId };
}

async function google(t: T, workspaceId: Id<"workspaces">, boundBy: Id<"users">, address: string, disconnected = false) {
  await seedGoogleConnection(t, { workspaceId, boundBy, address, googleAccountId: `acct-${address}`, disconnected });
}

async function grant(t: T, workspaceId: Id<"workspaces">, userId: Id<"users">, clientId: string) {
  const accessToken = `cat_identity_${Math.random().toString(16).slice(2)}${"0".repeat(16)}`;
  const hashedAccessToken = await hashToken(accessToken);
  await t.run(async (ctx) => {
    const known = await ctx.db
      .query("oauthClients")
      .withIndex("by_clientId", (q) => q.eq("clientId", clientId))
      .unique();
    if (known === null) {
      await ctx.db.insert("oauthClients", {
        clientId,
        clientName: "Identity test client",
        redirectUris: [],
        hashedClientSecret: null,
        tokenEndpointAuthMethod: "none",
        grantTypes: [],
        responseTypes: [],
        createdAt: Date.now(),
      });
    }
    await ctx.db.insert("oauthGrants", {
      workspaceId,
      userId,
      clientId,
      scopes: OWNER_SCOPES,
      hashedAccessToken,
      hashedRefreshToken: `refresh_${hashedAccessToken}`,
      accessTokenExpiresAt: Date.now() + 60 * 60 * 1000,
      status: "active",
      createdAt: Date.now(),
    });
  });
  return accessToken;
}

async function identity(t: T, accessToken: string, expectedWorkspaceId: string, secret?: string | null) {
  const response = await gatewayPost(t, "/gateway/agent/identity", { accessToken, expectedWorkspaceId }, secret === undefined ? {} : { secret });
  if (response.status !== 200) return { status: response.status };
  return ((await response.json()) as { identity: Record<string, unknown> | null }).identity;
}

describe("who is texting Tex", () => {
  test("Tex's texting grant learns its own person: phone, name, handle, emails, Google accounts", async () => {
    const t = setupTest();
    const { userId, workspaceId } = await person(t, "ada");
    await google(t, workspaceId, userId, "Ada.Work@example.invalid");
    await google(t, workspaceId, userId, "old@example.invalid", true);
    const token = await grant(t, workspaceId, userId, TEXTS_CLIENT_ID);
    expect(await identity(t, token, workspaceId)).toEqual({
      name: "Ada Lovelace",
      handle: "ada",
      phones: [PHONE],
      emails: ["ada@example.invalid", "ada.work@example.invalid"],
      google: [{ address: "Ada.Work@example.invalid", products: ["gmail"] }],
    });
  });

  test("routines and check-ins, which answer for one person too, learn the same", async () => {
    const t = setupTest();
    const { userId, workspaceId } = await person(t, "ada");
    for (const client of [ROUTINES_CLIENT_ID, HEARTBEAT_CLIENT_ID]) {
      const answer = await identity(t, await grant(t, workspaceId, userId, client), workspaceId);
      expect(answer).toMatchObject({ phones: [PHONE], handle: "ada" });
    }
  });

  test("with no name on the account, the personal workspace's name stands in", async () => {
    const t = setupTest();
    const userId = await createUser(t, "bo@example.invalid");
    const workspaceId = await createWorkspace(t, userId, "bo", { kind: "personal", displayName: "Bo Diddley" });
    const answer = await identity(t, await grant(t, workspaceId, userId, TEXTS_CLIENT_ID), workspaceId);
    expect(answer).toMatchObject({ name: "Bo Diddley", phones: [], emails: ["bo@example.invalid"] });
  });

  test("a third-party MCP client never learns the phone", async () => {
    const t = setupTest();
    const { userId, workspaceId } = await person(t, "ada");
    expect(await identity(t, await grant(t, workspaceId, userId, "mcp_client_someone_else"), workspaceId)).toBeNull();
  });

  test("a group chat's grant learns nobody: several people are in it", async () => {
    const t = setupTest();
    const { userId, workspaceId } = await person(t, "ada");
    expect(await identity(t, await grant(t, workspaceId, userId, "context_texts_group"), workspaceId)).toBeNull();
  });

  test("a grant on a shared workspace learns nobody", async () => {
    const t = setupTest();
    const { userId } = await person(t, "ada");
    const shared = await createWorkspace(t, userId, "ada-team", { kind: "shared" });
    expect(await identity(t, await grant(t, shared, userId, TEXTS_CLIENT_ID), shared)).toBeNull();
  });

  test("one person's token never reads another's, whatever workspace it names", async () => {
    const t = setupTest();
    const ada = await person(t, "ada");
    const bo = await person(t, "bo");
    const token = await grant(t, bo.workspaceId, bo.userId, TEXTS_CLIENT_ID);
    expect(await identity(t, token, ada.workspaceId)).toBeNull();
  });

  test("an unknown token, and a caller without the gateway's secret, get nothing", async () => {
    const t = setupTest();
    const { userId, workspaceId } = await person(t, "ada");
    expect(await identity(t, "cat_unknown_token_000000000000000000", workspaceId)).toBeNull();
    const token = await grant(t, workspaceId, userId, TEXTS_CLIENT_ID);
    const refused = await identity(t, token, workspaceId, null);
    expect(refused).not.toHaveProperty("phones");
  });
});
