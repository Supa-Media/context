/**
 * Two Google OAuth clients for one app (`functions/googleClients.ts`): the
 * standard grant for the person's own use, the agent grant for Tex, AI
 * clients and sync for AI, and no fallback between them once the agent
 * client is switched on.
 *
 * Sabotage (temporary local edits, reverted): `grantFor` answering
 * "standard" for an active agent role fails "after activation an agent call
 * never uses the standard grant"; dropping the `googleAccountId` comparison
 * in `applyAgentGrant` fails "a consent from another Google account binds
 * nothing"; refreshing the agent grant with the standard client fails "the
 * agent grant refreshes with the agent client".
 */

import { afterEach, describe, expect, test, vi } from "vitest";
import { api, internal } from "../../_generated/api";
import type { Id } from "../../_generated/dataModel";
import { encryptSecret, requireKeyset } from "../../functions/lib/crypto";
import { drainScheduled, seedGoogleConnection } from "../fixtures.helpers";
import { withSession } from "../session.helpers";
import { APP, personalScenario } from "./fixtures.helpers";

const STANDARD_ID = "standard-client.apps.googleusercontent.example";
const AGENT_ID = "agent-client.apps.googleusercontent.example";
const CALLBACK = `${APP}/connect/google`;
const HOUR = 60 * 60 * 1000;

afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
});

function configure({ active }: { active: boolean }) {
  vi.stubEnv("GOOGLE_OAUTH_CLIENT_ID", STANDARD_ID);
  vi.stubEnv("GOOGLE_AGENT_OAUTH_CLIENT_ID", AGENT_ID);
  vi.stubEnv("GOOGLE_AGENT_CLIENT_ACTIVE", active ? "true" : "");
  vi.stubEnv("APP_ORIGIN", APP);
}

function idToken(claims: Record<string, unknown>): string {
  const part = (value: unknown) => Buffer.from(JSON.stringify(value)).toString("base64url");
  return `${part({ alg: "none" })}.${part(claims)}.sig`;
}

/** Google's token endpoint: records which client asked, answers as told. */
function tokenEndpoint(answer: { refused?: boolean; sub?: string } = {}) {
  const asked: Array<{ grantType: string | null; clientId: string | null }> = [];
  const realFetch = globalThis.fetch;
  vi.stubGlobal("fetch", async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    if (url.startsWith("https://oauth2.googleapis.com/revoke")) return new Response("{}", { status: 200 });
    if (!url.startsWith("https://oauth2.googleapis.com/token")) return await realFetch(input, init);
    const form = new URLSearchParams(String(init?.body ?? ""));
    asked.push({ grantType: form.get("grant_type"), clientId: form.get("client_id") });
    if (answer.refused) return new Response(JSON.stringify({ error: "invalid_grant" }), { status: 400 });
    return new Response(
      JSON.stringify({
        access_token: `access-for-${form.get("client_id")}`,
        refresh_token: "agent-refresh-token-not-real",
        expires_in: 3600,
        scope: "https://www.googleapis.com/auth/gmail.readonly",
        id_token: idToken({ sub: answer.sub ?? "example-google-account-id", email: "person@example.invalid" }),
      }),
      { headers: { "content-type": "application/json" } },
    );
  });
  return asked;
}

async function connection(withAgentGrant = false) {
  const { t, owner, workspaceId } = await personalScenario();
  const connectionId = await seedGoogleConnection(t, { workspaceId, boundBy: owner });
  const keyset = requireKeyset();
  const context = { workspaceId: workspaceId as string };
  const standardAccess = await encryptSecret("standard-access-token", keyset, context);
  await t.run(async (ctx) => {
    await ctx.db.patch(connectionId, { encryptedAccessToken: standardAccess, accessTokenExpiresAt: Date.now() + HOUR });
  });
  if (withAgentGrant) {
    const agentGrant = {
      encryptedRefreshToken: await encryptSecret("agent-refresh-token", keyset, context),
      encryptedAccessToken: await encryptSecret("agent-access-token", keyset, context),
      accessTokenExpiresAt: Date.now() + HOUR,
      scopes: ["https://www.googleapis.com/auth/gmail.readonly"],
      grantedAt: Date.now(),
    };
    await t.run(async (ctx) => await ctx.db.patch(connectionId, { agentGrant }));
  }
  return { t, owner, workspaceId, connectionId };
}

async function mint(t: Awaited<ReturnType<typeof connection>>["t"], connectionId: Id<"googleConnections">, role: "standard" | "agent", forceRefresh = false) {
  return await t.action(internal.functions.googleConnect.mintGoogleAccessTokenOutcome, { connectionId, role, forceRefresh });
}

describe("which grant a call uses", () => {
  test("before activation an agent call uses the one grant the person gave, as today", async () => {
    configure({ active: false });
    const { t, connectionId } = await connection();
    expect(await mint(t, connectionId, "agent")).toMatchObject({ kind: "minted", accessToken: "standard-access-token" });
  });

  test("after activation an agent call never uses the standard grant", async () => {
    configure({ active: true });
    const asked = tokenEndpoint();
    const { t, connectionId } = await connection();
    expect(await mint(t, connectionId, "agent")).toEqual({ kind: "refused" });
    expect(await mint(t, connectionId, "agent", true)).toEqual({ kind: "refused" });
    expect(asked).toEqual([]);
  });

  test("after activation the person's own use stays on the standard grant, and AI on the agent one", async () => {
    configure({ active: true });
    const { t, connectionId } = await connection(true);
    expect(await mint(t, connectionId, "standard")).toMatchObject({ kind: "minted", accessToken: "standard-access-token" });
    expect(await mint(t, connectionId, "agent")).toMatchObject({ kind: "minted", accessToken: "agent-access-token" });
  });

  test("the agent grant refreshes with the agent client, the standard one with the standard client", async () => {
    configure({ active: true });
    const asked = tokenEndpoint();
    const { t, connectionId } = await connection(true);
    expect(await mint(t, connectionId, "agent", true)).toMatchObject({ kind: "minted", accessToken: `access-for-${AGENT_ID}` });
    expect(await mint(t, connectionId, "standard", true)).toMatchObject({ kind: "minted", accessToken: `access-for-${STANDARD_ID}` });
    expect(asked.map((entry) => entry.clientId)).toEqual([AGENT_ID, STANDARD_ID]);
  });

  test("Google refusing the agent grant drops it, and leaves the person's connection healthy", async () => {
    configure({ active: true });
    tokenEndpoint({ refused: true });
    const { t, connectionId } = await connection(true);
    expect(await mint(t, connectionId, "agent", true)).toEqual({ kind: "refused" });
    const row = await t.run((ctx) => ctx.db.get(connectionId));
    expect(row?.agentGrant).toBeUndefined();
    expect(row?.health).toBe("active");
  });
});

describe("allowing AI access", () => {
  test("is refused while the agent client is off", async () => {
    configure({ active: false });
    const { t, owner, workspaceId, connectionId } = await connection();
    await expect(
      withSession(t, owner).action(api.functions.googleClients.startGoogleAgentConnect, { workspaceId, connectionId, redirectUri: CALLBACK }),
    ).rejects.toThrow(/not switched on/);
  });

  test("asks the agent client for the connection's own account, and only its owner may", async () => {
    configure({ active: true });
    const { t, owner, workspaceId, connectionId } = await connection();
    const started = await withSession(t, owner).action(api.functions.googleClients.startGoogleAgentConnect, {
      workspaceId,
      connectionId,
      redirectUri: CALLBACK,
    });
    const url = new URL(started.authorizeUrl);
    expect(url.searchParams.get("client_id")).toBe(AGENT_ID);
    expect(url.searchParams.get("redirect_uri")).toBe(CALLBACK);
    expect(url.searchParams.get("login_hint")).toBe("person@example.invalid");

    const stranger = await t.run((ctx) => ctx.db.insert("users", { email: "stranger@example.invalid", emailVerificationTime: Date.now() } as never));
    await expect(
      withSession(t, stranger).action(api.functions.googleClients.startGoogleAgentConnect, { workspaceId, connectionId, redirectUri: CALLBACK }),
    ).rejects.toThrow(/not found/);
    await expect(
      withSession(t, owner).action(api.functions.googleClients.startGoogleAgentConnect, {
        workspaceId,
        connectionId,
        redirectUri: "https://evil.example/connect/google",
      }),
    ).rejects.toThrow(/redirect/i);
  });

  async function consent(sub?: string) {
    configure({ active: true });
    tokenEndpoint({ sub });
    const scenario = await connection();
    const { t, workspaceId, connectionId, owner } = scenario;
    const started = await withSession(t, owner).action(api.functions.googleClients.startGoogleAgentConnect, {
      workspaceId,
      connectionId,
      redirectUri: CALLBACK,
    });
    const state = new URL(started.authorizeUrl).searchParams.get("state") as string;
    const done = await t.action(api.functions.googleConnect.completeGoogleConnect, {
      state,
      code: "google-code",
      completionSecret: started.completionSecret,
    });
    await drainScheduled(t);
    return { ...scenario, done, state, completionSecret: started.completionSecret };
  }

  test("the shared callback binds the agent grant to that connection, beside the standard one", async () => {
    const { t, connectionId, workspaceId, done } = await consent();
    expect(done.workspaceId).toBe(workspaceId);
    const row = await t.run((ctx) => ctx.db.get(connectionId));
    expect(row?.agentGrant?.encryptedRefreshToken).toBeTruthy();
    expect(row?.encryptedAccessToken).toBeTruthy();
    expect(await mint(t, connectionId, "agent")).toMatchObject({ kind: "minted", accessToken: `access-for-${AGENT_ID}` });
  });

  test("a consent from another Google account binds nothing", async () => {
    const { t, connectionId } = await consent("some-other-google-account");
    const row = await t.run((ctx) => ctx.db.get(connectionId));
    expect(row?.agentGrant).toBeUndefined();
  });

  test("an attempt is spent once, and a wrong completion secret spends it", async () => {
    const { t, state, completionSecret } = await consent();
    await expect(
      t.action(api.functions.googleConnect.completeGoogleConnect, { state, code: "again", completionSecret }),
    ).rejects.toThrow(/expired/);
    expect(await t.run((ctx) => ctx.db.query("googleAgentAttempts").collect())).toEqual([]);
  });

  test("disconnecting forgets both grants", async () => {
    const { t, owner, workspaceId, connectionId } = await consent();
    await withSession(t, owner).mutation(api.functions.googleConnect.disconnectGoogleConnection, { workspaceId, connectionId });
    const row = await t.run((ctx) => ctx.db.get(connectionId));
    expect(row?.agentGrant).toBeUndefined();
    expect(row?.encryptedRefreshToken).toBe("");
  });

  test("the app is told which accounts still need AI access", async () => {
    configure({ active: false });
    const { t, owner, workspaceId } = await connection();
    expect((await withSession(t, owner).query(api.functions.googleClientsAccess.myGoogleAiAccess, { workspaceId }))[0]?.aiAccess).toBe("not_needed");
    configure({ active: true });
    expect((await withSession(t, owner).query(api.functions.googleClientsAccess.myGoogleAiAccess, { workspaceId }))[0]?.aiAccess).toBe("needed");
  });
});

